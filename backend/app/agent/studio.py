"""Server-side LLM proxy for AG Studio's built-in AI (the frontend's `AgLlmAdapter.executeTurn`).

AG Studio runs the agent loop in the browser: it sends one turn (instructions, conversation, the
widget tools it can execute) and executes any tool calls itself. This module only translates that
turn to Gemini's function-calling format and streams the answer back, so the Gemini key stays on
the server. It never executes a tool, and it refuses tool names that belong to Bundo's own dispute
and money tools, so a widget-building turn can't be steered into them.

Request (`POST /agent/studio/turn`, JSON; mirrors `AgLlmRequest`). Send the same `X-Bundo-Chart-Id: <uuid>`
header on every turn of one chart: the chart then counts once against the per-user Gemini limit, with at
most 40 turns (then 429). Without the header every turn counts. Turns run on the lite model
(`gemini_studio_model`, default `gemini_fallback_model`) with minimal thinking.

    {
      "instructions": "...",                       # system prompt for the turn
      "conversation": [AgAiConversationItem, ...], # AG Studio's `input`, passed as-is
      "tools": [{"name", "description", "parameters": <JSON schema>}],
      "tool_choice": "auto" | "none" | "required" | {"name": "..."},   # optional
      "output_format": {"type": "text"} | {"type": "json", "name", "schema"}  # optional
    }

Conversation items understood: input `message` (role user/system, text parts), output `message`
(assistant text), `function_call` ({callId, name, arguments: JSON string, optional
thought_signature}), and `function_call_output` ({callId, output}). Reasoning items, images and
files are dropped. Echo a tool call's `thought_signature` back on its `function_call` item when
you have it; Gemini 3 uses it to keep its reasoning across tool calls.

Response: `text/event-stream`, one JSON object per `data:` line:

    {"type": "text_delta", "text": "..."}
    {"type": "tool_call", "id": "...", "name": "...", "arguments": "<JSON string>",
     "thought_signature": "<base64>" | null}
    {"type": "done", "usage": {"inputTokens", "outputTokens", "totalTokens",
                               "reasoningTokens"?, "cachedInputTokens"?},
     "finish_reason": "stop" | "max_output_tokens" | "content_filter" | "other", "model": "..."}
    {"type": "error", "message": "..."}

Every stream ends with exactly one `done` or `error`. Error messages are plain words for the merchant;
when Gemini is rate-limiting, the turn waits with backoff first and then says Bundo is busy. `id` is the AG `callId`; `usage` uses
`AgAiUsage` field names. Validation problems (unknown callId, a Bundo tool name, too many steps)
are rejected with HTTP 400 before the stream starts.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .chat import TOOLS as CHAT_TOOLS
from app.config import get_settings

from .llm import GeminiLLM, ModelBusyError, ModelUnavailableError
from .tools import READ_ONLY_TOOLS, WRITE_TOOLS

log = logging.getLogger(__name__)

MAX_BODY_BYTES = 512_000
MAX_ITEMS = 200
MAX_TOOLS = 48
MAX_TOOL_ROUNDS = 40  # function calls already in the conversation; a widget build shouldn't need more
MAX_OUTPUT_TOKENS = 8192
TURN_TIMEOUT_SECONDS = 120
ANSWER_SECONDS = 30  # of the turn timeout, kept for the answer after any waiting on Gemini's rate limit
BUSY_MESSAGE = "Bundo is busy building charts right now. Try again in about a minute."
UNAVAILABLE_MESSAGE = "Bundo can't reach its chart model right now. Try again in about a minute."
# Gemini's documented placeholder for a function call whose real signature the client didn't keep.
SKIP_SIGNATURE = b"skip_thought_signature_validator"
LOCAL_ID = "bundo_call_"  # ids minted here when Gemini returns none; never sent back to Gemini

# Bundo's own tools. Studio turns never get these, even if a request declares one by the same name.
BUNDO_TOOLS = frozenset({t["name"] for t in CHAT_TOOLS} | set(READ_ONLY_TOOLS) | set(WRITE_TOOLS))

FINISH_REASONS = {"STOP": "stop", "MAX_TOKENS": "max_output_tokens", "SAFETY": "content_filter",
                  "PROHIBITED_CONTENT": "content_filter", "BLOCKLIST": "content_filter", "SPII": "content_filter"}


_thinking_rejected: set[str] = set()  # GeminiLLM names that refused our thinking config


def studio_llm() -> GeminiLLM | None:
    """Chart turns are many and short, so they run on the fast lite model, with no slower fallback."""
    s = get_settings()
    model = s.gemini_studio_model or s.gemini_fallback_model or s.gemini_model
    return GeminiLLM(s.gemini_api_key, model) if s.gemini_api_key else None


def thinking_level(llm: GeminiLLM) -> str | None:
    return None if llm.name in _thinking_rejected else (get_settings().gemini_studio_thinking_level or None)


class StudioTool(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str = Field(pattern=r"^[A-Za-z_][A-Za-z0-9_.:\-]{0,63}$")
    description: str = Field(default="", max_length=8000)
    parameters: dict[str, Any] = Field(default_factory=lambda: {"type": "object", "properties": {}})


class StudioOutputFormat(BaseModel):
    type: Literal["text", "json"]
    name: str | None = None
    description: str | None = None
    json_schema: dict[str, Any] | None = Field(default=None, alias="schema")


class StudioTurnBody(BaseModel):
    instructions: str = Field(default="", max_length=100_000)
    conversation: list[dict[str, Any]] = Field(min_length=1, max_length=MAX_ITEMS)
    tools: list[StudioTool] = Field(default_factory=list, max_length=MAX_TOOLS)
    tool_choice: Literal["auto", "none", "required"] | dict[str, str] | None = None
    output_format: StudioOutputFormat | None = None


def _text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    return "".join(c.get("text", "") for c in content or [] if isinstance(c, dict) and c.get("type") == "text")


def _signature(item: dict[str, Any]) -> bytes:
    sig = item.get("thought_signature")
    if isinstance(sig, str) and sig:
        try:
            return base64.b64decode(sig, validate=True)
        except (binascii.Error, ValueError):
            pass
    return SKIP_SIGNATURE


def _gemini_id(call_id: str) -> str | None:
    return None if call_id.startswith(LOCAL_ID) else call_id


def build_contents(body: StudioTurnBody) -> tuple[str, list[Any]]:
    """AG conversation -> (system instruction, Gemini contents). Raises ValueError on a malformed turn."""
    from google.genai import types

    names = {t.name for t in body.tools}
    clash = names & BUNDO_TOOLS
    if clash:
        raise ValueError(f"Tool name reserved by Bundo: {', '.join(sorted(clash))}")

    system = [body.instructions] if body.instructions else []
    call_names: dict[str, str] = {}
    contents: list[Any] = []
    rounds = 0

    def add(role: str, part: Any) -> None:
        # Gemini wants alternating turns, with parallel calls and their results grouped together.
        if contents and contents[-1].role == role:
            contents[-1].parts.append(part)
        else:
            contents.append(types.Content(role=role, parts=[part]))

    for item in body.conversation:
        kind = item.get("type")
        if kind == "message":
            text = _text_of(item.get("content"))
            if not text:
                continue
            role = item.get("role")
            if role == "system":
                system.append(text)
            elif role == "assistant":
                add("model", types.Part(text=text))
            else:
                add("user", types.Part(text=text))
        elif kind == "function_call":
            rounds += 1
            call_id, name = str(item.get("callId") or ""), str(item.get("name") or "")
            if not call_id or name not in names:
                raise ValueError(f"Tool call {call_id or '?'} is for a tool this turn doesn't declare")
            try:
                args = json.loads(item.get("arguments") or "{}")
            except json.JSONDecodeError as exc:
                raise ValueError(f"Tool call {call_id} has invalid JSON arguments") from exc
            call_names[call_id] = name
            add("model", types.Part(function_call=types.FunctionCall(id=_gemini_id(call_id), name=name, args=args),
                                    thought_signature=_signature(item)))
        elif kind == "function_call_output":
            call_id = str(item.get("callId") or "")
            if call_id not in call_names:
                raise ValueError(f"Tool result {call_id or '?'} has no matching tool call")
            output = item.get("output", "")
            try:
                result: Any = json.loads(output) if isinstance(output, str) else output
            except json.JSONDecodeError:
                result = output
            add("user", types.Part(function_response=types.FunctionResponse(
                id=_gemini_id(call_id), name=call_names[call_id], response={"output": result})))
        # reasoning items and anything unknown are dropped

    if rounds > MAX_TOOL_ROUNDS:
        raise ValueError(f"This chart took more than {MAX_TOOL_ROUNDS} steps; start a new request.")
    if not contents or contents[-1].role != "user":
        raise ValueError("The conversation must end with a user message or tool results")
    return "\n\n".join(system), contents


def _has_ref(node: Any) -> bool:
    if isinstance(node, dict):
        return "$ref" in node or any(_has_ref(v) for v in node.values())
    return isinstance(node, list) and any(_has_ref(v) for v in node)


def gemini_schema(node: Any) -> Any:
    """A tool schema Gemini accepts. Gemini refuses a `$ref` loop through required fields (AG Studio's layout
    tree: a column must hold at least one row, which must hold at least one column...), so arrays that can
    recurse lose `minItems`. Studio still validates the arguments it gets back."""
    if isinstance(node, list):
        return [gemini_schema(v) for v in node]
    if not isinstance(node, dict):
        return node
    out = {k: gemini_schema(v) for k, v in node.items()}
    if out.get("type") == "array" and "minItems" in out and _has_ref(out.get("items")):
        del out["minItems"]
    return out


def build_config(body: StudioTurnBody, system: str, thinking: str | None = None) -> Any:
    from google.genai import types

    config: dict[str, Any] = {
        "thinking_config": types.ThinkingConfig(thinking_level=thinking) if thinking else None,
        "system_instruction": system or None,
        "max_output_tokens": MAX_OUTPUT_TOKENS,
        "temperature": 0.2,
        "automatic_function_calling": types.AutomaticFunctionCallingConfig(disable=True),
    }
    if body.tools:
        config["tools"] = [types.Tool(function_declarations=[
            types.FunctionDeclaration(name=t.name, description=t.description, parameters_json_schema=gemini_schema(t.parameters))
            for t in body.tools
        ])]
        choice = body.tool_choice
        if isinstance(choice, dict):
            if choice.get("name") not in {t.name for t in body.tools}:
                raise ValueError("tool_choice names a tool this turn doesn't declare")
            fcc = types.FunctionCallingConfig(mode="ANY", allowed_function_names=[choice["name"]])
        else:
            fcc = types.FunctionCallingConfig(mode={"none": "NONE", "required": "ANY"}.get(choice or "auto", "AUTO"))
        config["tool_config"] = types.ToolConfig(function_calling_config=fcc)
    fmt = body.output_format
    if fmt and fmt.type == "json":
        config["response_mime_type"] = "application/json"
        if fmt.json_schema:
            config["response_json_schema"] = fmt.json_schema
    return types.GenerateContentConfig(**config)


def _usage(meta: Any) -> dict[str, int]:
    if meta is None:
        return {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0}
    thoughts = meta.thoughts_token_count or 0
    out = (meta.candidates_token_count or 0) + thoughts
    usage = {"inputTokens": meta.prompt_token_count or 0, "outputTokens": out,
             "totalTokens": meta.total_token_count or (meta.prompt_token_count or 0) + out}
    if thoughts:
        usage["reasoningTokens"] = thoughts
    if meta.cached_content_token_count:
        usage["cachedInputTokens"] = meta.cached_content_token_count
    return usage


def sse(event: dict[str, Any]) -> str:
    return f"data: {json.dumps(event, separators=(',', ':'))}\n\n"


async def _chunks(llm: GeminiLLM, contents: list[Any], config: Any, patient_until: float) -> AsyncIterator[tuple[str, Any]]:
    """llm.stream, retried once without a thinking config if the model rejects the one we sent."""
    from google.genai import errors

    try:
        async for item in llm.stream(contents, config, patient_until):
            yield item
    except errors.APIError as exc:
        # Only reached before the first chunk: a 400 here means the request itself was refused.
        if exc.code != 400 or config.thinking_config is None or "thinking" not in str(exc).lower():
            raise
        log.info("%s rejected thinking config; sending none from now on", llm.name)
        _thinking_rejected.add(llm.name)
        async for item in llm.stream(contents, config.model_copy(update={"thinking_config": None}), patient_until):
            yield item


async def stream_turn(llm: GeminiLLM, contents: list[Any], config: Any) -> AsyncIterator[str]:
    """Run one Gemini turn and yield SSE lines in the documented event shape."""
    usage_meta, finish, model = None, None, ""
    # Leave room for the answer itself after waiting out Gemini's rate limit.
    patient_until = time.monotonic() + TURN_TIMEOUT_SECONDS - ANSWER_SECONDS
    try:
        async with asyncio.timeout(TURN_TIMEOUT_SECONDS):
            async for model, chunk in _chunks(llm, contents, config, patient_until):
                usage_meta = chunk.usage_metadata or usage_meta
                for cand in (chunk.candidates or [])[:1]:
                    if cand.finish_reason:
                        finish = getattr(cand.finish_reason, "value", str(cand.finish_reason))
                    for part in (cand.content.parts if cand.content else None) or []:
                        if part.function_call:
                            fc = part.function_call
                            yield sse({
                                "type": "tool_call",
                                "id": fc.id or f"{LOCAL_ID}{uuid.uuid4().hex[:24]}",
                                "name": fc.name,
                                "arguments": json.dumps(fc.args or {}),
                                "thought_signature": base64.b64encode(part.thought_signature).decode()
                                if part.thought_signature else None,
                            })
                        elif part.text and not part.thought:
                            yield sse({"type": "text_delta", "text": part.text})
    except ModelBusyError:
        yield sse({"type": "error", "message": BUSY_MESSAGE})
        return
    except ModelUnavailableError:
        yield sse({"type": "error", "message": UNAVAILABLE_MESSAGE})
        return
    except TimeoutError:
        yield sse({"type": "error", "message": "Bundo took too long on that chart step. Please try again."})
        return
    except Exception as exc:  # the stream has started, so errors must travel as events
        log.warning("studio turn failed: %s", exc)
        yield sse({"type": "error", "message": "Bundo couldn't finish that chart step. Please try again."})
        return
    if finish and finish not in FINISH_REASONS:
        # e.g. MALFORMED_FUNCTION_CALL: the model tried a tool call it couldn't fit to the schema.
        log.info("studio turn ended with %s", finish)
    yield sse({"type": "done", "usage": _usage(usage_meta),
               "finish_reason": FINISH_REASONS.get(finish or "STOP", "other"), "model": model})
