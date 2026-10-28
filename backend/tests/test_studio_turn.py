import base64
import json
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from google.genai import errors, types

from app import deps
from app.agent import router as agent_router
from app.agent import studio
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

    def __init__(self, chunks=(), error=None, fail=()):
        self.chunks, self.error, self.fail, self.calls = list(chunks), error, list(fail), []

    async def generate_content_stream(self, model, contents, config):
        self.calls.append({"model": model, "contents": contents, "config": config})
        if self.fail:
            raise self.fail.pop(0)
        if self.error:
            raise self.error

        async def gen():
            for c in self.chunks:
                yield c

        return gen()


def _gemini(monkeypatch, models):
    llm = GeminiLLM("test-key", "gemini-test-lite")
    llm._client = type("C", (), {"aio": type("A", (), {"models": models})()})()
    monkeypatch.setattr(agent_router, "studio_llm", lambda: llm)
    return models


def _settings(monkeypatch, **over):
    s = Settings(_env_file=None, **{"llm_requests_per_10_minutes": 20, **over})
    monkeypatch.setattr(deps, "get_settings", lambda: s)
    monkeypatch.setattr(studio, "get_settings", lambda: s)
    return s


def _no_sleep(monkeypatch):
    slept = []

    async def fake_sleep(seconds):
        slept.append(seconds)

    monkeypatch.setattr("app.agent.llm.asyncio.sleep", fake_sleep)
    return slept


def _busy(retry_delay=None):
    details = [{"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": retry_delay}] if retry_delay else []
    return errors.APIError(429, {"error": {"code": 429, "message": "Resource exhausted", "details": details}})


def _events(resp):
    return [json.loads(line[len("data: "):]) for line in resp.text.splitlines() if line.startswith("data: ")]


@pytest.fixture
def client(monkeypatch):
    for store in (deps._llm_calls, deps._chart_turns, studio._thinking_rejected):
        store.clear()
    _settings(monkeypatch)
    app.dependency_overrides[current_merchant] = lambda: ME
    yield TestClient(app)  # no lifespan, no database
    app.dependency_overrides.clear()
    for store in (deps._llm_calls, deps._chart_turns, studio._thinking_rejected):
        store.clear()


def test_sign_in_required():
    resp = TestClient(app).post("/agent/studio/turn", json=_turn())
    assert resp.status_code == 401


def test_rate_limit_applies_per_turn_without_a_chart_id(client, monkeypatch):
    _settings(monkeypatch, llm_requests_per_10_minutes=2)
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
         "finish_reason": "stop", "model": "gemini-test-lite"},
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
    assert _events(resp) == [{"type": "error", "message": "Bundo couldn't finish that chart step. Please try again."}]


def test_gemini_overloaded_becomes_error_event(client, monkeypatch):
    _no_sleep(monkeypatch)
    models = _gemini(monkeypatch, FakeModels(error=errors.APIError(503, {"error": {"message": "overloaded"}})))
    events = _events(client.post("/agent/studio/turn", json=_turn()))
    assert events == [{"type": "error", "message": studio.UNAVAILABLE_MESSAGE}]
    assert len(models.calls) == 4


def test_gemini_429_backs_off_honouring_the_hint_then_answers(client, monkeypatch):
    slept = _no_sleep(monkeypatch)
    models = _gemini(monkeypatch, FakeModels([_chunk(types.Part(text="ok"), finish="STOP")],
                                             fail=[_busy("7s"), _busy()]))
    events = _events(client.post("/agent/studio/turn", json=_turn()))
    assert [e["type"] for e in events] == ["text_delta", "done"]
    assert len(models.calls) == 3 and len(slept) == 2
    assert 7 <= slept[0] <= 8  # Gemini's retryDelay, plus jitter
    assert 0 <= slept[1] <= 4  # jittered exponential backoff


def test_gemini_429_that_persists_ends_in_plain_words(client, monkeypatch):
    slept = _no_sleep(monkeypatch)
    _gemini(monkeypatch, FakeModels(error=_busy("1s")))
    events = _events(client.post("/agent/studio/turn", json=_turn()))
    assert events == [{"type": "error", "message": "Bundo is busy building charts right now. Try again in about a minute."}]
    assert len(slept) == 6


def test_gemini_429_backoff_stays_inside_the_turn_timeout(client, monkeypatch):
    slept = _no_sleep(monkeypatch)
    _gemini(monkeypatch, FakeModels(error=_busy("600s")))
    events = _events(client.post("/agent/studio/turn", json=_turn()))
    assert events[0]["message"] == studio.BUSY_MESSAGE and slept == []


def test_one_chart_counts_as_one_request(client, monkeypatch):
    _settings(monkeypatch, llm_requests_per_10_minutes=2)
    _gemini(monkeypatch, FakeModels([_chunk(types.Part(text="ok"), finish="STOP")]))
    chart = {"X-Bundo-Chart-Id": str(uuid4())}
    codes = [client.post("/agent/studio/turn", json=_turn(), headers=chart).status_code for _ in range(10)]
    codes.append(client.post("/agent/studio/turn", json=_turn(), headers={"X-Bundo-Chart-Id": str(uuid4())}).status_code)
    codes.append(client.post("/agent/studio/turn", json=_turn(), headers={"X-Bundo-Chart-Id": str(uuid4())}).status_code)
    assert codes == [200] * 11 + [429]


def test_chart_turns_are_capped(client, monkeypatch):
    monkeypatch.setattr(deps, "MAX_TURNS_PER_CHART", 3)
    _gemini(monkeypatch, FakeModels([_chunk(types.Part(text="ok"), finish="STOP")]))
    chart = {"X-Bundo-Chart-Id": "chart-1"}
    resps = [client.post("/agent/studio/turn", json=_turn(), headers=chart) for _ in range(4)]
    assert [r.status_code for r in resps] == [200, 200, 200, 429]
    assert "too many steps" in resps[-1].json()["detail"]
    # The chart id is per merchant: another merchant using the same id starts fresh.
    app.dependency_overrides[current_merchant] = lambda: CurrentMerchant(id=uuid4(), email="other@example.com")
    assert client.post("/agent/studio/turn", json=_turn(), headers=chart).status_code == 200


def test_studio_runs_on_the_lite_model(monkeypatch):
    _settings(monkeypatch, gemini_api_key="k", gemini_model="main", gemini_fallback_model="lite")
    assert studio.studio_llm()._models == ["lite"]
    _settings(monkeypatch, gemini_api_key="k", gemini_model="main", gemini_fallback_model="lite", gemini_studio_model="charts")
    assert studio.studio_llm()._models == ["charts"]
    _settings(monkeypatch, gemini_api_key="")
    assert studio.studio_llm() is None


def test_minimal_thinking_is_requested_and_dropped_if_rejected(client, monkeypatch):
    rejected = errors.APIError(400, {"error": {"code": 400, "message": "Thinking level MINIMAL is not supported."}})
    models = _gemini(monkeypatch, FakeModels([_chunk(types.Part(text="ok"), finish="STOP")], fail=[rejected]))
    events = _events(client.post("/agent/studio/turn", json=_turn()))
    assert [e["type"] for e in events] == ["text_delta", "done"]
    first, retry = models.calls[0]["config"], models.calls[1]["config"]
    assert first.thinking_config.thinking_level == "MINIMAL" and retry.thinking_config is None
    client.post("/agent/studio/turn", json=_turn())
    assert models.calls[2]["config"].thinking_config is None  # remembered, no wasted call


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


def test_gemini_schema_drops_min_items_only_on_recursive_arrays():
    # AG Studio's layout tree: a column holds rows that hold columns, each needing at least one child.
    schema = {
        "type": "object",
        "properties": {"root": {"$ref": "#/$defs/Column"}, "tags": {"type": "array", "items": {"type": "string"}, "minItems": 1}},
        "$defs": {
            "Column": {
                "type": "object",
                "required": ["children"],
                "properties": {"children": {"type": "array", "minItems": 1, "items": {"anyOf": [{"$ref": "#/$defs/Column"}, {"type": "string"}]}}},
            }
        },
    }
    out = studio.gemini_schema(schema)
    assert "minItems" not in out["$defs"]["Column"]["properties"]["children"]
    assert out["$defs"]["Column"]["required"] == ["children"]
    assert out["properties"]["tags"]["minItems"] == 1
    assert schema["$defs"]["Column"]["properties"]["children"]["minItems"] == 1  # input left untouched


def test_tool_schemas_are_sanitised_for_gemini():
    tool = {"name": "create_plan", "parameters": {"type": "object", "properties": {"kids": {"type": "array", "minItems": 1, "items": {"$ref": "#/$defs/K"}}}, "$defs": {"K": {"type": "object"}}}}
    body = studio.StudioTurnBody.model_validate(_turn(tools=[tool]))
    config = studio.build_config(body, "")
    assert "minItems" not in config.tools[0].function_declarations[0].parameters_json_schema["properties"]["kids"]


class TurnsModels(FakeModels):
    """Answers each call with the next scripted turn."""

    def __init__(self, *turns):
        super().__init__()
        self.turns = list(turns)

    async def generate_content_stream(self, model, contents, config):
        self.chunks = self.turns.pop(0)
        return await super().generate_content_stream(model, contents, config)


MALFORMED = [_chunk(finish="MALFORMED_FUNCTION_CALL")]
GOOD_CALL = [_chunk(types.Part(function_call=types.FunctionCall(id="fc1", name="add_widget", args={"kind": "bar"})), finish="STOP")]


def _with_fallback(monkeypatch, models):
    main = GeminiLLM("test-key", "gemini-test-main")
    main._client = type("C", (), {"aio": type("A", (), {"models": models})()})()
    monkeypatch.setattr(agent_router, "studio_fallback_llm", lambda: main)


def test_malformed_tool_call_is_retried_with_more_thinking_before_anything_streams(client, monkeypatch):
    models = _gemini(monkeypatch, TurnsModels(MALFORMED, GOOD_CALL))
    events = _events(client.post("/agent/studio/turn", json=_turn()))
    assert [e["type"] for e in events] == ["tool_call", "done"]
    assert events[-1]["finish_reason"] == "stop"
    assert [c["model"] for c in models.calls] == ["gemini-test-lite", "gemini-test-lite"]
    assert models.calls[1]["config"].thinking_config.thinking_level == "LOW"


def test_second_malformed_call_falls_back_to_the_main_model(client, monkeypatch):
    lite = _gemini(monkeypatch, TurnsModels(MALFORMED, MALFORMED))
    main = TurnsModels(GOOD_CALL)
    _with_fallback(monkeypatch, main)
    events = _events(client.post("/agent/studio/turn", json=_turn()))
    assert [e["type"] for e in events] == ["tool_call", "done"]
    assert len(lite.calls) == 2 and [c["model"] for c in main.calls] == ["gemini-test-main"]


def test_malformed_after_every_retry_is_reported_not_called_other(client, monkeypatch):
    _gemini(monkeypatch, TurnsModels(MALFORMED, MALFORMED))
    events = _events(client.post("/agent/studio/turn", json=_turn()))
    assert events == [{"type": "done", "usage": {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0},
                       "finish_reason": "malformed_function_call", "model": "gemini-test-lite"}]


def test_required_tool_call_that_never_comes_is_retried(client, monkeypatch):
    models = _gemini(monkeypatch, TurnsModels([_chunk(types.Part(text="Sure!"), finish="STOP")], GOOD_CALL))
    events = _events(client.post("/agent/studio/turn", json=_turn(tool_choice="required")))
    assert [e["type"] for e in events] == ["tool_call", "done"] and len(models.calls) == 2


def test_plain_text_answer_is_not_retried(client, monkeypatch):
    models = _gemini(monkeypatch, TurnsModels([_chunk(types.Part(text="Done."), finish="STOP")]))
    events = _events(client.post("/agent/studio/turn", json=_turn()))
    assert [e["type"] for e in events] == ["text_delta", "done"] and len(models.calls) == 1


def test_fallback_is_the_main_model_only_when_it_differs(monkeypatch):
    _settings(monkeypatch, gemini_api_key="k", gemini_model="main", gemini_fallback_model="lite")
    assert studio.studio_fallback_llm()._models == ["main"]
    _settings(monkeypatch, gemini_api_key="k", gemini_model="main", gemini_studio_model="main")
    assert studio.studio_fallback_llm() is None


DELEGATE = {
    "name": "delegate_to",
    "parameters": {"type": "object", "required": ["type", "instructions"], "properties": {
        "type": {"anyOf": [{"$ref": "#/$defs/Agent"}]}, "instructions": {"type": "string"}},
        "$defs": {"Agent": {"type": "object", "properties": {"id": {"type": "string"}}}}},
}


def _delegate(args):
    return [_chunk(types.Part(function_call=types.FunctionCall(id="d1", name="delegate_to", args=args)), finish="STOP")]


def test_call_with_wrongly_shaped_arguments_is_retried(client, monkeypatch):
    # Seen live: the lite model sent `"type": "data"` where Studio requires `{"id": "data"}`.
    models = _gemini(monkeypatch, TurnsModels(_delegate({"type": "data", "instructions": "explore"}),
                                              _delegate({"type": {"id": "data"}, "instructions": "explore"})))
    events = _events(client.post("/agent/studio/turn", json=_turn(tools=[DELEGATE])))
    assert json.loads(events[0]["arguments"])["type"] == {"id": "data"} and len(models.calls) == 2


def test_call_missing_a_required_argument_is_retried(client, monkeypatch):
    models = _gemini(monkeypatch, TurnsModels(_delegate({"instructions": "explore"}),
                                              _delegate({"type": {"id": "data"}, "instructions": "explore"})))
    client.post("/agent/studio/turn", json=_turn(tools=[DELEGATE]))
    assert len(models.calls) == 2


def test_well_shaped_call_is_not_retried(client, monkeypatch):
    models = _gemini(monkeypatch, TurnsModels(_delegate({"type": {"id": "data"}, "instructions": "explore"})))
    client.post("/agent/studio/turn", json=_turn(tools=[DELEGATE]))
    assert len(models.calls) == 1
