import type { AgDataSourcesDefinition } from "ag-studio";

import { ROLE_LABELS, type Insights, type Overview } from "@/lib/treasury";
import type { DisputeSummary } from "@/lib/types";

/** BundoPay's one data model for AG Studio. Every board (Home, Jars, Disputes) and every chart Ask Bundo builds
 * reads these same tables, so a number means the same thing wherever it appears. */

export type StoreKind = "orders" | "refunds" | "shipments" | "tickets";
export type StoreRecords = Partial<Record<StoreKind, Record<string, string | null>[]>>;

export type ModelInput = {
  currency: string;
  overview: Overview | null;
  insights: Insights | null;
  disputes: DisputeSummary[];
  records?: StoreRecords;
  /** How far back money-moved and closed disputes are counted. Open disputes always count. */
  days: number;
};

const DAY = 86_400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const isOpen = (d: DisputeSummary) => d.status !== "RESOLVED";

/** Allowed and on its way or landed; blocked and failed moves never left Operating. */
function setAside(m: Insights["movements"][number]) {
  return m.role && m.role !== "operating" && ["executing", "unconfirmed", "succeeded"].includes(m.status) ? Number(m.amount) : 0;
}

/** Operating balance minus the floor that must stay put: what the merchant can actually spend today. */
export function freeToSpend(o: Overview | null): { free: number | null; operating: number | null; floor: number } {
  const floor = Number(o?.limits.liquidity_floor ?? 0);
  const op = o?.positions.find((p) => p.role === "operating");
  if (!op || op.balance === null) return { free: null, operating: null, floor };
  const operating = Math.max(0, Number(op.balance));
  return { free: Math.max(0, operating - floor), operating, floor };
}

export function buildModel({ currency, overview, insights, disputes, records = {}, days }: ModelInput): AgDataSourcesDefinition {
  // Excel-style format strings; AG Studio's validator rejects Intl objects here.
  const symbol = new Intl.NumberFormat("en", { style: "currency", currency }).formatToParts(0).find((p) => p.type === "currency")?.value ?? "$";
  const cash = { format: `"${symbol}"#,##0` };
  const since = Date.now() - days * DAY;
  const inRange = (at: string | null | undefined) => !!at && new Date(at).getTime() >= since;
  const refunded = new Set(insights?.auto_refunded ?? []);
  const { free, operating, floor } = freeToSpend(overview);

  const jars = (overview?.positions ?? []).filter((p) => p.role !== "operating");
  const moves = (insights?.movements ?? []).filter((m) => inRange(m.created_at));
  const moved = moves.filter((m) => setAside(m) > 0).map((m) => ({ day: startOfDay(new Date(m.created_at)), jar: ROLE_LABELS[m.role!], amount: setAside(m) }));
  // A zero for every day in range, so the axis shows the whole period rather than one wide bar.
  const today = startOfDay(new Date());
  // With nothing moved yet, the chart still shows the period, flat, rather than "No data".
  const quietJar = moved[0]?.jar ?? ROLE_LABELS[jars[0]?.role ?? "tax_reserve"];
  const quiet = Array.from({ length: days }, (_, i) => ({ day: new Date(today.getTime() - i * DAY), jar: quietJar, amount: 0 }));

  const tracked = new Set((records.shipments ?? []).filter((s) => s.tracking_number).map((s) => s.order_id));
  const orderByTxn = new Map((records.orders ?? []).map((o) => [o.paypal_transaction_id, o.order_id]));
  const hasStore = !!records.orders?.length;

  return {
    sources: [
      {
        id: "money",
        name: "Your money",
        data: [{ free_to_spend: free, operating, floor, set_aside: jars.reduce((n, p) => n + Math.max(0, Number(p.balance ?? 0)), 0) }],
        fields: [
          { id: "free_to_spend", name: "Free to spend", format: "currencyFormat", formatOptions: cash },
          { id: "operating", name: "Operating", format: "currencyFormat", formatOptions: cash },
          { id: "floor", name: "Always kept", format: "currencyFormat", formatOptions: cash },
          { id: "set_aside", name: "In your jars", format: "currencyFormat", formatOptions: cash },
        ],
      },
      {
        id: "jars",
        name: "Jars",
        data: jars.map((p) => ({ jar: ROLE_LABELS[p.role], balance: Math.max(0, Number(p.balance ?? 0)), pending: Number(p.pending ?? 0) })),
        fields: [
          { id: "jar", name: "Jar", format: "textFormat" },
          { id: "balance", name: "Balance", format: "currencyFormat", formatOptions: cash },
          { id: "pending", name: "On its way", format: "currencyFormat", formatOptions: cash },
        ],
      },
      {
        id: "moved",
        name: "Money set aside",
        data: [...moved, ...quiet],
        fields: [
          { id: "day", name: "Day", format: "dateFormat", formatOptions: { format: "d mmm" } },
          { id: "jar", name: "Jar", format: "textFormat" },
          { id: "amount", name: "Amount", format: "currencyFormat", formatOptions: cash },
        ],
      },
      {
        id: "transfers",
        name: "Transfers",
        // A zero row keeps the tiles reading 0 instead of "No data" before the first transfer.
        data: moves.length ? moves.map((m) => ({
          when: new Date(m.created_at),
          jar: m.role ? ROLE_LABELS[m.role] : "Other",
          amount: Number(m.amount),
          outcome: m.verdict === "block" ? "Stopped" : m.verdict === "ask" ? "Waited for you" : setAside(m) > 0 ? "Moved" : "Not sent",
          stopped: m.verdict === "block" || m.verdict === "ask" ? 1 : 0,
        })) : [{ when: null, jar: null, amount: 0, outcome: null, stopped: 0 }],
        fields: [
          { id: "when", name: "When", format: "dateFormat", formatOptions: { format: "d mmm" } },
          { id: "jar", name: "To", format: "textFormat" },
          { id: "amount", name: "Amount", format: "currencyFormat", formatOptions: cash },
          { id: "outcome", name: "Outcome", format: "textFormat" },
          { id: "stopped", name: "Stopped by safety checks", format: "integerFormat" },
        ],
      },
      {
        id: "disputes",
        name: "Disputes",
        // Open ones count however old they are (money is at stake today); closed ones only within the range.
        data: disputes
          .filter((d) => isOpen(d) || inRange(d.opened_at))
          .map((d) => {
            const order = d.transaction_id ? orderByTxn.get(d.transaction_id) : undefined;
            return {
              reason: d.reason_label ?? "Other",
              at_stake: isOpen(d) ? Number(d.amount ?? 0) : 0,
              open: isOpen(d) ? 1 : 0,
              handled: d.draft_status === "submitted" || refunded.has(d.id) ? 1 : 0,
              transaction_id: d.transaction_id ?? null,
              // Only meaningful once store data is uploaded: an open dispute whose order has no tracking number.
              no_tracking: hasStore && isOpen(d) && (!order || !tracked.has(order)) ? 1 : 0,
            };
          }),
        fields: [
          { id: "reason", name: "Reason", format: "textFormat" },
          { id: "at_stake", name: "At stake", format: "currencyFormat", formatOptions: cash },
          { id: "open", name: "Open disputes", format: "integerFormat" },
          { id: "handled", name: "Handled by Bundo", format: "percentageFormat", formatOptions: { format: "0%" } },
          { id: "transaction_id", name: "PayPal transaction", format: "textFormat" },
          { id: "no_tracking", name: "Open, no tracking number", format: "integerFormat" },
        ],
      },
      ...storeSources(records),
    ],
    relationships: hasStore
      ? [
          { id: "dispute-order", source: { tableId: "disputes", fieldId: "transaction_id" }, target: { tableId: "orders", fieldId: "paypal_transaction_id" }, type: "many-to-one" as const },
          ...(["shipments", "refunds", "tickets"] as const)
            .filter((k) => records[k]?.length)
            .map((k) => ({ id: `${k}-order`, source: { tableId: k, fieldId: "order_id" }, target: { tableId: "orders", fieldId: "order_id" }, type: "many-to-one" as const })),
        ]
      : undefined,
  };
}

const STORE_FIELDS: Record<StoreKind, [string, string][]> = {
  orders: [["order_id", "Order"], ["order_date", "Order date"], ["total", "Total"], ["currency", "Currency"], ["paypal_transaction_id", "PayPal transaction"]],
  shipments: [["order_id", "Order"], ["carrier", "Carrier"], ["tracking_number", "Tracking number"], ["status", "Shipping status"]],
  refunds: [["order_id", "Order"], ["refund_id", "Refund"], ["amount", "Refunded"], ["currency", "Currency"]],
  tickets: [["order_id", "Order"], ["ticket_id", "Ticket"], ["created_at", "Opened"], ["summary", "Summary"]],
};
const STORE_NAMES: Record<StoreKind, string> = { orders: "Orders", shipments: "Shipments", refunds: "Refunds", tickets: "Support tickets" };

/** Store CSVs become tables only once the merchant has uploaded them, so an empty store adds nothing to the model. */
function storeSources(records: StoreRecords) {
  return (Object.keys(STORE_FIELDS) as StoreKind[])
    .filter((k) => records[k]?.length)
    .map((k) => ({
      id: k,
      name: STORE_NAMES[k],
      data: records[k]!.map((r) => Object.fromEntries(STORE_FIELDS[k].map(([f]) => [f, f === "total" || f === "amount" ? Number(r[f] ?? 0) : (r[f] ?? null)]))),
      fields: STORE_FIELDS[k].map(([id, name]) => ({ id, name, format: id === "total" || id === "amount" ? ("currencyFormat" as const) : ("textFormat" as const) })),
    }));
}
