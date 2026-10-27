import base64
import json
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from google.genai import errors, types

from app import deps
from app.agent import router as agent_router
from app.agent.llm import GeminiLLM
from app.auth import CurrentMerchant, current_merchant
from app.config import Settings
from app.main import app

ME = CurrentMerchant(id=uuid4(), email="owner@example.com")

ADD_WIDGET = {
    "name": "add_widget",
    "description": "Add a chart widget to the preview board.",
    "parameters": {"type": "object", "properties": {"kind": {"type": "string"}}, "required": ["kind"]},
}


def _turn(**over):
    body = {
        "instructions": "You build charts.",
        "conversation": [
            {"id": "m1", "kind": "input", "type": "message", "role": "user", "status": "completed",
             "content": [{"type": "text", "text": "Chart my refunds by week"}]},
        ],
        "tools": [ADD_WIDGET],
    }
    return {**body, **over}


def _chunk(*parts, finish=None, usage=None):
    return types.GenerateContentResponse(
        candidates=[types.Candidate(content=types.Content(role="model", parts=list(parts)), finish_reason=finish)],
        usage_metadata=usage,
    )


class FakeModels:
    """Stands in for client.aio.models; records each streamed request."""

    def __init__(self, chunks=(), error=None):
        self.chunks, self.error, self.calls = list(chunks), error, []

    async def generate_content_stream(self, model, contents, config):
        self.calls.append({"model": model, "contents": contents, "config": config})
        if self.error:
            raise self.error

        async def gen():
            for c in self.chunks:
                yield c

        return gen()


def _gemini(monkeypatch, models):
    llm = GeminiLLM("test-key", "gemini-test", "gemini-test-lite")
    llm._client = type("C", (), {"aio": type("A", (), {"models": models})()})()
    monkeypatch.setattr(agent_router, "default_llm", lambda: llm)
    return models


def _events(resp):
    return [json.loads(line[len("data: "):]) for line in resp.text.splitlines() if line.startswith("data: ")]


@pytest.fixture
def client(monkeypatch):
    deps._llm_calls.clear()
    monkeypatch.setattr(deps, "get_settings", lambda: Settings(_env_file=None, llm_requests_per_10_minutes=20))
    app.dependency_overrides[current_merchant] = lambda: ME
    yield TestClient(app)  # no lifespan, no database
    app.dependency_overrides.clear()
    deps._llm_calls.clear()


def test_sign_in_required():
    resp = TestClient(app).post("/agent/studio/turn", json=_turn())
    assert resp.status_code == 401


def test_rate_limit_applies(client, monkeypatch):
    monkeypatch.setattr(deps, "get_settings", lambda: Settings(_env_file=None, llm_requests_per_10_minutes=2))
    models = _gemini(monkeypatch, FakeModels([_chunk(types.Part(text="ok"), finish="STOP")]))
    assert [client.post("/agent/studio/turn", json=_turn()).status_code for _ in range(3)] == [200, 200, 429]
    assert len(models.calls) == 2


def test_text_streams_and_usage_is_reported(client, monkeypatch):
    usage = types.GenerateContentResponseUsageMetadata(
        prompt_token_count=120, candidates_token_count=30, thoughts_token_count=10, total_token_count=160)
    _gemini(monkeypatch, FakeModels([
        _chunk(types.Part(text="thinking...", thought=True)),
        _chunk(types.Part(text="Here is ")),
        _chunk(types.Part(text="your chart."), finish="STOP", usage=usage),
    ]))
    resp = client.post("/agent/studio/turn", json=_turn())
    assert resp.status_code == 200 and resp.headers["content-type"].startswith("text/event-stream")
    assert _events(resp) == [
        {"type": "text_delta", "text": "Here is "},
        {"type": "text_delta", "text": "your chart."},
        {"type": "done", "usage": {"inputTokens": 120, "outputTokens": 40, "totalTokens": 160, "reasoningTokens": 10},
         "finish_reason": "stop", "model": "gemini-test"},
    ]


def test_tool_call_is_translated_and_streamed(client, monkeypatch):
    sig = b"\x01sig"
    models = _gemini(monkeypatch, FakeModels([
        _chunk(types.Part(function_call=types.FunctionCall(id="fc1", name="add_widget", args={"kind": "bar"}),
                          thought_signature=sig), finish="STOP"),
    ]))
    events = _events(client.post("/agent/studio/turn", json=_turn(tool_choice="required")))
    assert events[0] == {"type": "tool_call", "id": "fc1", "name": "add_widget",
                         "arguments": json.dumps({"kind": "bar"}), "thought_signature": base64.b64encode(sig).decode()}
    assert events[-1]["type"] == "done"

    config = models.calls[0]["config"]
    decl = config.tools[0].function_declarations
    assert [d.name for d in decl] == ["add_widget"] and decl[0].parameters_json_schema == ADD_WIDGET["parameters"]
    assert config.tool_config.function_calling_config.mode == "ANY"
    assert config.system_instruction == "You build charts."
    assert config.max_output_tokens == 8192


def test_tool_results_round_trip_to_gemini(client, monkeypatch):
    models = _gemini(monkeypatch, FakeModels([_chunk(types.Part(text="Added."), finish="STOP")]))
    conversation = _turn()["conversation"] + [
        {"id": "o1", "kind": "output", "type": "function_call", "callId": "fc1", "name": "add_widget",
         "arguments": '{"kind": "bar"}', "thought_signature": base64.b64encode(b"sig").decode()},
        {"type": "function_call_output", "callId": "fc1", "output": '{"ok": true}', "status": "completed"},
        {"id": "o2", "kind": "output", "type": "function_call", "callId": "bundo_call_x", "name": "add_widget",
         "arguments": "{}"},
        {"type": "function_call_output", "callId": "bundo_call_x", "output": "done", "status": "completed"},
    ]
    assert client.post("/agent/studio/turn", json=_turn(conversation=conversation)).status_code == 200
    contents = models.calls[0]["contents"]
    assert [c.role for c in contents] == ["user", "model", "user", "model", "user"]
    call = contents[1].parts[0]
    assert call.function_call.name == "add_widget" and call.function_call.args == {"kind": "bar"}
    assert call.thought_signature == b"sig"
    assert contents[2].parts[0].function_response.response == {"output": {"ok": True}}
    # Locally minted ids and missing signatures don't reach Gemini as if they were its own.
    assert contents[3].parts[0].function_call.id is None
    assert contents[3].parts[0].thought_signature == b"skip_thought_signature_validator"


def test_gemini_error_becomes_error_event(client, monkeypatch):
    _gemini(monkeypatch, FakeModels(error=errors.APIError(400, {"error": {"message": "bad schema"}})))
    resp = client.post("/agent/studio/turn", json=_turn())
    assert resp.status_code == 200
    assert _events(resp) == [{"type": "error", "message": "Gemini couldn't finish this turn (400)."}]


def test_gemini_overloaded_becomes_error_event(client, monkeypatch):
    async def no_sleep(_):
        return None

    monkeypatch.setattr("app.agent.llm.asyncio.sleep", no_sleep)
    models = _gemini(monkeypatch, FakeModels(error=errors.APIError(503, {"error": {"message": "overloaded"}})))
    events = _events(client.post("/agent/studio/turn", json=_turn()))
    assert events[0]["type"] == "error" and "unavailable" in events[0]["message"]
    assert {c["model"] for c in models.calls} == {"gemini-test", "gemini-test-lite"}


@pytest.mark.parametrize("name", ["submit_dispute_response", "prepare_response", "get_refunds"])
def test_bundo_tools_are_refused(client, monkeypatch, name):
    models = _gemini(monkeypatch, FakeModels())
    resp = client.post("/agent/studio/turn", json=_turn(tools=[{**ADD_WIDGET, "name": name}]))
    assert resp.status_code == 400 and "reserved" in resp.json()["detail"]
    assert models.calls == []


def test_undeclared_tool_call_is_refused(client, monkeypatch):
    _gemini(monkeypatch, FakeModels())
    conversation = _turn()["conversation"] + [
        {"type": "function_call", "callId": "fc1", "name": "submit_dispute_response", "arguments": "{}"},
        {"type": "function_call_output", "callId": "fc1", "output": "{}"},
    ]
    assert client.post("/agent/studio/turn", json=_turn(conversation=conversation)).status_code == 400


def test_request_size_and_steps_are_capped(client, monkeypatch):
    _gemini(monkeypatch, FakeModels())
    big = _turn(instructions="x" * 600_000)
    assert client.post("/agent/studio/turn", json=big).status_code == 413
    steps = []
    for i in range(41):
        steps += [{"type": "function_call", "callId": f"c{i}", "name": "add_widget", "arguments": "{}"},
                  {"type": "function_call_output", "callId": f"c{i}", "output": "{}"}]
    resp = client.post("/agent/studio/turn", json=_turn(conversation=_turn()["conversation"] + steps))
    assert resp.status_code == 400 and "steps" in resp.json()["detail"]
    too_many_tools = [{**ADD_WIDGET, "name": f"t{i}"} for i in range(49)]
    assert client.post("/agent/studio/turn", json=_turn(tools=too_many_tools)).status_code == 422
