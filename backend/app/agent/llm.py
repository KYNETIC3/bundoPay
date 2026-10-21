"""LLM client interface with a Gemini implementation (google-genai). Tests use a fake."""

from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable
from typing import Any, Protocol

ToolCaller = Callable[[str, dict[str, Any]], Awaitable[Any]]
MAX_TURNS = 8


class LLM(Protocol):
    name: str

    async def run(self, system: str, user: str, tools: list[dict[str, Any]], call_tool: ToolCaller) -> str: ...


class GeminiLLM:
    def __init__(self, api_key: str, model: str):
        from google import genai

        self._client = genai.Client(api_key=api_key)
        self._model = model
        self.name = f"gemini:{model}"

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
            resp = await self._client.aio.models.generate_content(model=self._model, contents=contents, config=config)
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
