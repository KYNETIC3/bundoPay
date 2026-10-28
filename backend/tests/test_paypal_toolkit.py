from contextlib import asynccontextmanager
from uuid import uuid4

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.agent import chat as chat_module
from app.agent import paypal_actions
from app.agent import paypal_toolkit as toolkit
from app.agent.studio import BUNDO_TOOLS

MERCHANT = uuid4()
TXN = "3C679366HH908993F"


class FakeRunner:
    def __init__(self, result=None, error=None):
        self.calls = []
        self.result = result if result is not None else {"transaction_details": [{"id": TXN}]}
        self.error = error

    async def run(self, method, args):
        self.calls.append((method, args))
        if self.error:
            raise self.error
        return self.result


class FakeConn:
    """Stores paypal_actions rows in memory and answers the few statements the code sends."""

    def __init__(self):
        self.rows = {}
        self.sql = []

    async def execute(self, sql, params=()):
        self.sql.append(sql)
        result = None
        if sql.startswith("insert into paypal_actions"):
            merchant_id, tool, args, h = params
            row_id = uuid4()
            self.rows[row_id] = {"id": row_id, "merchant_id": merchant_id, "tool": tool, "args_json": args.obj,
                                 "args_hash": h, "status": "awaiting_approval", "error": None,
                                 "created_at": None, "decided_at": None}
            result = {"id": row_id}
        elif sql.startswith("update paypal_actions set status = 'submitting'"):
            action_id, merchant_id, h = params
            r = self.rows.get(action_id)
            if r and r["merchant_id"] == merchant_id and r["status"] == "awaiting_approval" and r["args_hash"] == h:
                r["status"] = "submitting"
                result = r
        elif sql.startswith("update paypal_actions set status = 'done'"):
            _, action_id = params
            self.rows[action_id]["status"] = "done"
            result = self.rows[action_id]
        elif sql.startswith("update paypal_actions set status = 'failed'"):
            *_, action_id = params
            self.rows[action_id]["status"] = "failed"
        elif sql.startswith("update paypal_actions set status = 'declined'"):
            action_id, merchant_id = params
            r = self.rows.get(action_id)
            if r and r["merchant_id"] == merchant_id and r["status"] == "awaiting_approval":
                r["status"] = "declined"
                result = r

        class Cur:
            async def fetchone(self):
                return result

        return Cur()


@pytest.fixture
def db(monkeypatch, settings):
    fake = FakeConn()
    audits = []

    @asynccontextmanager
    async def connection():
        yield fake

    async def audit(conn, event, **kw):
        audits.append((event, kw))

    for mod in (chat_module, paypal_actions):
        monkeypatch.setattr(mod, "connection", connection)
        monkeypatch.setattr(mod, "audit", audit)
    monkeypatch.setattr(toolkit, "get_settings", lambda: settings)
    return {"conn": fake, "audits": audits}


def test_only_the_apps_own_sandbox_account_gets_the_toolkit(settings):
    assert toolkit.toolkit_enabled_for("PARTNERPAYERID", settings)
    assert not toolkit.toolkit_enabled_for("SOMEONEELSE", settings)
    assert not toolkit.toolkit_enabled_for(None, settings)
    assert not toolkit.toolkit_enabled_for("PARTNERPAYERID", settings.model_copy(update={"paypal_partner_client_secret": ""}))


def test_only_allowlisted_tools_are_offered_in_geminis_format():
    specs = toolkit.tool_specs()
    names = {s["name"] for s in specs}
    assert names == {toolkit.PREFIX + m for m in toolkit.READ_METHODS + toolkit.WRITE_METHODS}
    # No refunds, invoices, orders or subscriptions from chat.
    assert not names & {"paypal_accept_dispute_claim", "paypal_create_order", "paypal_pay_order", "paypal_create_invoice"}
    tracking = next(s for s in specs if s["name"] == "paypal_create_shipment_tracking")
    assert tracking["parameters"]["type"] == "OBJECT"
    assert tracking["parameters"]["properties"]["tracking_number"]["type"] == "STRING"
    assert set(tracking["parameters"]["required"]) == {"tracking_number", "transaction_id"}
    assert "does not change PayPal" in tracking["description"]


def test_studio_turns_can_never_declare_toolkit_tools():
    assert {s["name"] for s in toolkit.tool_specs()} <= BUNDO_TOOLS


def test_arguments_are_checked_by_the_toolkits_own_models():
    clean = toolkit.validate("create_shipment_tracking", {"tracking_number": "1Z999", "transaction_id": TXN, "carrier": "UPS", "extra": "x"})
    assert clean == {"tracking_number": "1Z999", "transaction_id": TXN, "status": "SHIPPED", "carrier": "UPS"}
    with pytest.raises(ValidationError):
        toolkit.validate("create_shipment_tracking", {"tracking_number": "1Z999", "transaction_id": "bad id!"})


async def test_toolkit_tools_are_refused_when_not_enabled(db):
    tools = chat_module.ChatTools(MERCHANT, use_toolkit=False, runner=FakeRunner())
    assert [s["name"] for s in tools.specs()] == [t["name"] for t in chat_module.TOOLS]
    with pytest.raises(PermissionError):
        await tools.call("paypal_list_transactions", {})


async def test_a_read_tool_calls_the_toolkit_and_is_audited(db):
    runner = FakeRunner()
    tools = chat_module.ChatTools(MERCHANT, use_toolkit=True, runner=runner)
    result = await tools.call("paypal_list_transactions", {"transaction_id": TXN})
    assert result == runner.result and tools.live
    [(method, args)] = runner.calls
    assert method == "list_transactions" and args["transaction_id"] == TXN
    [(event, kw)] = db["audits"]
    assert event == "agent.tool_call" and kw["data"]["via"] == "paypal-agent-toolkit" and kw["data"]["write"] is False


async def test_big_results_are_trimmed_for_the_model(db):
    tools = chat_module.ChatTools(MERCHANT, use_toolkit=True, runner=FakeRunner(result={"rows": "x" * 50_000}))
    result = await tools.call("paypal_list_transactions", {})
    assert result["truncated"] is True and len(result["preview"]) == toolkit.MAX_RESULT_CHARS


async def test_the_write_tool_only_proposes_and_never_calls_paypal(db):
    runner = FakeRunner()
    tools = chat_module.ChatTools(MERCHANT, use_toolkit=True, runner=runner)
    out = await tools.call("paypal_create_shipment_tracking", {"tracking_number": "1Z999", "transaction_id": TXN, "carrier": "UPS"})
    assert out["status"] == "awaiting_owner_approval"
    assert runner.calls == []
    assert tools.actions == [out["action_id"]]
    [row] = db["conn"].rows.values()
    assert row["status"] == "awaiting_approval" and row["tool"] == "create_shipment_tracking"
    assert row["args_hash"] == toolkit.args_hash("create_shipment_tracking", row["args_json"])
    assert db["audits"][0][1]["data"]["write"] is True


async def _proposed(db):
    tools = chat_module.ChatTools(MERCHANT, use_toolkit=True, runner=FakeRunner())
    out = await tools.call("paypal_create_shipment_tracking", {"tracking_number": "1Z999", "transaction_id": TXN})
    row = db["conn"].rows[next(iter(db["conn"].rows))]
    return row["id"], row["args_hash"], out


async def test_approving_runs_exactly_the_stored_proposal_once(db):
    action_id, h, _ = await _proposed(db)
    runner = FakeRunner(result={"tracker_identifiers": [{"transaction_id": TXN}]})
    done = await paypal_actions.approve_action(MERCHANT, "PARTNERPAYERID", action_id, h, runner=runner)
    assert done["status"] == "done"
    assert runner.calls == [("create_shipment_tracking", db["conn"].rows[action_id]["args_json"])]
    with pytest.raises(HTTPException) as again:
        await paypal_actions.approve_action(MERCHANT, "PARTNERPAYERID", action_id, h, runner=runner)
    assert again.value.status_code == 409 and len(runner.calls) == 1
    assert [e for e, _ in db["audits"]][-2:] == ["paypal_action.approved", "paypal_action.done"]


async def test_a_changed_or_unseen_proposal_is_not_run(db):
    action_id, _, _ = await _proposed(db)
    runner = FakeRunner()
    with pytest.raises(HTTPException) as exc:
        await paypal_actions.approve_action(MERCHANT, "PARTNERPAYERID", action_id, "0" * 64, runner=runner)
    assert exc.value.status_code == 409 and runner.calls == []


async def test_another_merchant_cannot_approve(db):
    action_id, h, _ = await _proposed(db)
    runner = FakeRunner()
    with pytest.raises(HTTPException):
        await paypal_actions.approve_action(uuid4(), "PARTNERPAYERID", action_id, h, runner=runner)
    with pytest.raises(HTTPException):
        await paypal_actions.approve_action(MERCHANT, "SOMEONEELSE", action_id, h, runner=runner)
    assert runner.calls == []


async def test_a_paypal_failure_is_recorded_and_reported(db):
    action_id, h, _ = await _proposed(db)
    with pytest.raises(HTTPException) as exc:
        await paypal_actions.approve_action(MERCHANT, "PARTNERPAYERID", action_id, h, runner=FakeRunner(error=RuntimeError("INVALID_TRACKING")))
    assert exc.value.status_code == 502 and db["conn"].rows[action_id]["status"] == "failed"


async def test_declining_closes_the_proposal(db):
    action_id, h, _ = await _proposed(db)
    assert (await paypal_actions.decline_action(MERCHANT, action_id))["status"] == "declined"
    with pytest.raises(HTTPException):
        await paypal_actions.approve_action(MERCHANT, "PARTNERPAYERID", action_id, h, runner=FakeRunner())


async def test_chat_offers_toolkit_tools_and_reports_live_data_and_proposals(db):
    class FakeLLM:
        name = "fake"

        async def run(self, system, user, tools, call_tool):
            assert "paypal_" in system and "paypal_list_transactions" in {t["name"] for t in tools}
            await call_tool("paypal_list_transactions", {})
            await call_tool("paypal_create_shipment_tracking", {"tracking_number": "1Z999", "transaction_id": TXN})
            return "Your sale is there. Tracking is ready for your approval."

    out = await chat_module.chat(MERCHANT, [{"role": "owner", "content": "add tracking"}], FakeLLM(), use_toolkit=True, runner=FakeRunner())
    assert out["live"] is True and len(out["paypal_action_ids"]) == 1 and out["cards"] == []


async def test_transaction_search_works_around_the_toolkits_date_and_id_bugs(settings):
    sent = []

    class FakeAPI:
        def run(self, method, args):
            sent.append((method, args))
            return '{"transaction_details": [{"transaction_info": {"transaction_id": "OTHER123456789"}}, {"transaction_info": {"transaction_id": "%s"}}]}' % TXN

    runner = toolkit.ToolkitRunner(settings, api=FakeAPI())
    args = toolkit.validate("list_transactions", {"transaction_id": TXN})
    out = await runner.run("list_transactions", args)
    [(method, query)] = sent
    assert method == "list_transactions"
    assert "transaction_id" not in query and "search_months" not in query
    assert query["start_date"].endswith("Z") and query["end_date"].endswith("Z")
    assert out == {"found": True, "transaction_details": [{"transaction_info": {"transaction_id": TXN}}], "total_items": 1}


async def test_the_runner_refuses_methods_that_are_not_enabled(settings):
    with pytest.raises(PermissionError):
        await toolkit.ToolkitRunner(settings).run("accept_dispute_claim", {"dispute_id": "PP-D-1"})
