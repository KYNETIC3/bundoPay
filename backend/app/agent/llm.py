"""LLM client interface with a Gemini implementation (google-genai). Tests use a fake."""

from __future__ import annotations

import asyncio
import json
import random
import re
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, Protocol

ToolCaller = Callable[[str, dict[str, Any]], Awaitable[Any]]
MAX_TURNS = 8
RETRY_ATTEMPTS = 4  # waits 1s, 2s, 4s between attempts
MAX_BUSY_RETRIES = 6  # 429 retries when the caller is willing to wait
BUSY_BASE_SECONDS, BUSY_CAP_SECONDS = 2.0, 30.0


class ModelUnavailableError(RuntimeError):
    """The model provider is overloaded or unreachable; safe to retry later."""


class ModelBusyError(ModelUnavailableError):
    """Gemini kept answering 429 (rate limit or quota) after the retries the caller allowed."""


def retry_after(exc: Any) -> float | None:
    """Seconds Gemini asked us to wait: a Retry-After header, or RetryInfo.retryDelay ("32s") in the error body."""
    headers = getattr(getattr(exc, "response", None), "headers", None) or {}
    try:
        if headers.get("retry-after"):
            return float(headers["retry-after"])
    except (TypeError, ValueError):
        pass
    details = exc.details.get("error", {}).get("details", []) if isinstance(getattr(exc, "details", None), dict) else []
    for d in details if isinstance(details, list) else []:
        if isinstance(d, dict) and str(d.get("@type", "")).endswith("RetryInfo"):
            try:
                return float(str(d.get("retryDelay", "")).rstrip("s"))
            except ValueError:
                return None
    return None


def backoff_delay(attempt: int, hint: float | None) -> float:
    """Full-jitter exponential backoff, never shorter than the server's hint."""
    delay = random.uniform(0, min(BUSY_CAP_SECONDS, BUSY_BASE_SECONDS * 2**attempt))
    return max(delay, hint + random.uniform(0, 1)) if hint else delay


class LLM(Protocol):
    name: str

    async def run(self, system: str, user: str, tools: list[dict[str, Any]], call_tool: ToolCaller) -> str: ...


class GeminiLLM:
    def __init__(self, api_key: str, model: str, fallback_model: str = ""):
        from google import genai

        self._client = genai.Client(api_key=api_key)
        self._models = [m for m in (model, fallback_model) if m]
        self.name = f"gemini:{model}"

    async def _with_retries(self, call: Callable[[str], Awaitable[Any]], patient_until: float | None = None) -> Any:
        """Run call(model) with retries when Gemini is overloaded or rate-limited, then the fallback model.

        By default a 429 moves straight to the fallback model. With patient_until (a time.monotonic() deadline),
        429s are retried with jittered exponential backoff that honours Gemini's retry hint, until the deadline."""
        from google.genai import errors

        last: errors.APIError | None = None
        for model in self._models:
            attempt = busy = 0
            while attempt < RETRY_ATTEMPTS:
                try:
                    return await call(model)
                except errors.APIError as exc:
                    if exc.code not in (429, 500, 503):
                        raise
                    last = exc
                    if exc.code != 429:
                        await asyncio.sleep(2**attempt)
                        attempt += 1
                        continue
                    if patient_until is None or busy >= MAX_BUSY_RETRIES:
                        break  # out of quota for this model; try the fallback
                    wait = backoff_delay(busy, retry_after(exc))
                    if time.monotonic() + wait > patient_until:
                        break
                    await asyncio.sleep(wait)
                    busy += 1
        if last is not None and last.code == 429:
            raise ModelBusyError("Gemini is busy right now. Please try again in a minute.") from last
        code = last.code if last else "?"
        raise ModelUnavailableError(f"Gemini is unavailable right now ({code}). Please try again in a minute.") from last

    async def _generate(self, contents: list[Any], config: Any) -> Any:
        return await self._with_retries(
            lambda model: self._client.aio.models.generate_content(model=model, contents=contents, config=config)
        )

    async def stream(
        self, contents: list[Any], config: Any, patient_until: float | None = None
    ) -> AsyncIterator[tuple[str, Any]]:
        """Stream (model, chunk) pairs. Retries happen only until the first chunk arrives, so nothing is repeated."""

        async def open_stream(model: str) -> tuple[str, Any, Any]:
            chunks = await self._client.aio.models.generate_content_stream(model=model, contents=contents, config=config)
            return model, chunks, await anext(chunks, None)

        model, chunks, first = await self._with_retries(open_stream, patient_until)
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
