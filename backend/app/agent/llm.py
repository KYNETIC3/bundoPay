"""LLM client interface with a Gemini implementation (google-genai). Tests use a fake."""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, Protocol

ToolCaller = Callable[[str, dict[str, Any]], Awaitable[Any]]
MAX_TURNS = 8
RETRY_ATTEMPTS = 4  # waits 1s, 2s, 4s between attempts


class ModelUnavailableError(RuntimeError):
    """The model provider is overloaded or unreachable; safe to retry later."""


class LLM(Protocol):
    name: str

    async def run(self, system: str, user: str, tools: list[dict[str, Any]], call_tool: ToolCaller) -> str: ...


class GeminiLLM:
    def __init__(self, api_key: str, model: str, fallback_model: str = ""):
        from google import genai

        self._client = genai.Client(api_key=api_key)
        self._models = [m for m in (model, fallback_model) if m]
        self.name = f"gemini:{model}"

    async def _with_retries(self, call: Callable[[str], Awaitable[Any]]) -> Any:
        """Run call(model) with retries when Gemini is overloaded or rate-limited, then the fallback model."""
        from google.genai import errors

        last: errors.APIError | None = None
        for model in self._models:
            for attempt in range(RETRY_ATTEMPTS):
                try:
                    return await call(model)
                except errors.APIError as exc:
                    if exc.code not in (429, 500, 503):
                        raise
                    last = exc
                    if exc.code == 429:
                        break  # out of quota for this model; retrying won't help, try the fallback
                    await asyncio.sleep(2**attempt)
        code = last.code if last else "?"
        raise ModelUnavailableError(f"Gemini is unavailable right now ({code}). Please try again in a minute.") from last

    async def _generate(self, contents: list[Any], config: Any) -> Any:
        return await self._with_retries(
            lambda model: self._client.aio.models.generate_content(model=model, contents=contents, config=config)
        )

    async def stream(self, contents: list[Any], config: Any) -> AsyncIterator[tuple[str, Any]]:
        """Stream (model, chunk) pairs. Retries happen only until the first chunk arrives, so nothing is repeated."""

        async def open_stream(model: str) -> tuple[str, Any, Any]:
            chunks = await self._client.aio.models.generate_content_stream(model=model, contents=contents, config=config)
            return model, chunks, await anext(chunks, None)

        model, chunks, first = await self._with_retries(open_stream)
        if first is None:
            return
        yield model, first
        async for chunk in chunks:
            yield model, chunk

    async def run(self, system: str, user: str, tools: list[dict[str, Any]], call_tool: ToolCaller) -> str:
        from google.genai import types

        config = types.GenerateContentConfig(
            system_instruction=system,
            tools=[types.Tool(function_declarations=tools)] if tools else None,
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
            temperature=0.2,
        )
        contents: list[Any] = [types.Content(role="user", parts=[types.Part(text=user)])]
        for _ in range(MAX_TURNS):
            resp = await self._generate(contents, config)
            calls = resp.function_calls or []
            if not calls:
                return resp.text or ""
            contents.append(resp.candidates[0].content)
            parts = []
            for call in calls:
                try:
                    result: Any = {"result": await call_tool(call.name, dict(call.args or {}))}
                except Exception as exc:
                    result = {"error": str(exc)}
                parts.append(types.Part.from_function_response(name=call.name, response=result))
            contents.append(types.Content(role="user", parts=parts))
        raise RuntimeError("Model did not finish within the tool-call budget")


def parse_json_object(text: str) -> dict[str, Any]:
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise ValueError("Model response contained no JSON object")
    return json.loads(match.group(0))
