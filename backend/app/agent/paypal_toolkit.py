"""PayPal Agent Toolkit tools for Ask Bundo.

The toolkit signs in with the app's own sandbox credentials, so its tools are offered only to the merchant
whose PayPal account *is* the app's account (the hosted demo, or dev-self mode). Everyone else keeps the
gateway-backed tools in chat.py.

Read tools run straight away. The one write tool, adding shipment tracking, never runs from chat: calling it
stores a proposal in `paypal_actions`, and only the owner's Approve click on that exact proposal (its
args_hash) executes it, through the toolkit. Refunds aren't offered here at all: they keep their one route,
the dispute draft that the safety engine checks.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from typing import Any
from uuid import UUID

from app.config import SANDBOX_BASE_URL, Settings, get_settings
from app.db import jsonb

PREFIX = "paypal_"
READ_METHODS = ("list_transactions", "get_order_details", "get_shipment_tracking", "list_disputes", "get_dispute")
WRITE_METHODS = ("create_shipment_tracking",)
# Read tool results are trimmed so one big transaction search can't fill the model's context.
MAX_RESULT_CHARS = 12_000

_TYPES = {"string": "STRING", "integer": "INTEGER", "number": "NUMBER", "boolean": "BOOLEAN"}


def toolkit_enabled_for(paypal_merchant_id: str | None, settings: Settings | None = None) -> bool:
    s = settings or get_settings()
    return bool(
        paypal_merchant_id
        and s.paypal_partner_client_id
        and s.paypal_partner_client_secret
        and paypal_merchant_id == s.paypal_partner_merchant_id
        and s.paypal_base_url == SANDBOX_BASE_URL
    )


def _toolkit_tools() -> dict[str, dict[str, Any]]:
    from paypal_agent_toolkit.shared.tools import tools

    return {t["method"]: t for t in tools if t["method"] in READ_METHODS + WRITE_METHODS}


def _gemini_schema(prop: dict[str, Any]) -> dict[str, Any]:
    """One JSON-schema property (as pydantic writes it) in Gemini's function-declaration dialect."""
    options = [o for o in prop.get("anyOf", [prop]) if o.get("type") != "null"]
    base = options[0] if options else {"type": "string"}
    out: dict[str, Any] = {"type": _TYPES.get(base.get("type", "string"), "STRING")}
    if prop.get("description"):
        out["description"] = prop["description"]
    if base.get("enum"):
        out["enum"] = [str(e) for e in base["enum"]]
    return out


def tool_specs() -> list[dict[str, Any]]:
    specs = []
    for method, t in _toolkit_tools().items():
        schema = t["args_schema"].model_json_schema()
        note = (
            " Calling this does not change PayPal: it prepares the change for the owner to approve."
            if method in WRITE_METHODS
            else " Reads live data from PayPal."
        )
        specs.append(
            {
                "name": PREFIX + method,
                "description": t["description"].split("\n\n")[0].strip() + note,
                "parameters": {
                    "type": "OBJECT",
                    "properties": {k: _gemini_schema(v) for k, v in schema.get("properties", {}).items()},
                    "required": schema.get("required", []),
                },
            }
        )
    return specs


def args_hash(tool: str, args: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps({"tool": tool, "args": args}, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def validate(method: str, args: dict[str, Any]) -> dict[str, Any]:
    """The toolkit's own pydantic model checks the arguments; only the fields it knows survive."""
    model = _toolkit_tools()[method]["args_schema"]
    return model(**args).model_dump(mode="json", exclude_none=True)


def _utc(value: str) -> str:
    return value if value.endswith("Z") or "+" in value[10:] else value + "Z"


def _transactions_query(args: dict[str, Any]) -> tuple[dict[str, Any], str | None]:
    """Work around two bugs in toolkit 1.11's list_transactions: its default dates have no timezone (PayPal
    rejects them), and its search by transaction id calls the HTTP client with an argument it doesn't take, so
    it never finds anything. We search the date window instead and pick the transaction out ourselves."""
    query = dict(args)
    wanted = query.pop("transaction_id", None)
    query.pop("search_months", None)
    for key in ("start_date", "end_date"):
        if query.get(key):
            query[key] = _utc(query[key])
    return query, wanted


def _pick_transaction(result: Any, wanted: str) -> Any:
    rows = (result or {}).get("transaction_details", []) if isinstance(result, dict) else []
    found = [r for r in rows if (r.get("transaction_info") or {}).get("transaction_id") == wanted]
    return {"found": bool(found), "transaction_details": found, "total_items": len(found)}


class ToolkitRunner:
    """Runs toolkit methods. The toolkit uses blocking `requests`, so calls go to a worker thread."""

    def __init__(self, settings: Settings | None = None, api: Any = None):
        from paypal_agent_toolkit.shared.api import PayPalAPI
        from paypal_agent_toolkit.shared.configuration import Context

        s = settings or get_settings()
        if s.paypal_base_url != SANDBOX_BASE_URL:
            raise RuntimeError("The PayPal Agent Toolkit is only used against the sandbox")
        self._api = api or PayPalAPI(s.paypal_partner_client_id, s.paypal_partner_client_secret, Context(sandbox=True, source="BundoPay"))

    async def run(self, method: str, args: dict[str, Any]) -> Any:
        if method not in READ_METHODS + WRITE_METHODS:
            raise PermissionError(f"Toolkit method {method} is not enabled")
        wanted = None
        if method == "list_transactions":
            args, wanted = _transactions_query(args)
        raw = await asyncio.to_thread(self._api.run, method, args)
        try:
            result = json.loads(raw) if isinstance(raw, str) else raw
        except ValueError:
            result = raw
        return _pick_transaction(result, wanted) if wanted else result


_runner: ToolkitRunner | None = None


def get_runner() -> ToolkitRunner:
    global _runner
    if _runner is None:
        _runner = ToolkitRunner()
    return _runner


def trim(result: Any) -> Any:
    text = json.dumps(result, default=str)
    if len(text) <= MAX_RESULT_CHARS:
        return result
    return {"truncated": True, "preview": text[:MAX_RESULT_CHARS]}


async def propose(conn, merchant_id: UUID, method: str, args: dict[str, Any]) -> dict[str, Any]:
    """Store a write as a proposal awaiting the owner. Returns what the model may tell the owner."""
    clean = validate(method, args)
    h = args_hash(method, clean)
    cur = await conn.execute(
        "insert into paypal_actions (merchant_id, tool, args_json, args_hash) values (%s, %s, %s, %s) returning id",
        (merchant_id, method, jsonb(clean), h),
    )
    action_id = (await cur.fetchone())["id"]
    return {"status": "awaiting_owner_approval", "action_id": str(action_id), "details": clean}
