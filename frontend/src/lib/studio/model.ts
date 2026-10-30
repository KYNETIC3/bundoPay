import type { AgDataSourcesDefinition, AgExpression, AgExpressionFieldDefinition } from "ag-studio";

import { disputeStatus } from "@/lib/status";
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

/** How strong the proof is, in words, so charts can stack by it without a colour key. */
function proofLevel(coverage: number | null | undefined): string {
  if (coverage == null) return "Not checked yet";
  if (coverage >= 0.8) return "Strong proof";
  if (coverage >= 0.5) return "Some proof";
  return "Little proof";
}

const sum = (id: string): AgExpression => ({ id, aggregation: "sum" });

/** Calculated fields. Their names and descriptions are what the field panel and Studio's AI assistant read, so
 * they're written the way a seller would say them. */
function expressions(pct: { format: string }, cash: { format: string }): AgExpressionFieldDefinition[] {
  const decided: AgExpression = { operator: "add", inputs: [sum("disputes.won"), sum("disputes.lost")] };
  return [
    {
      id: "net_exposure",
      name: "Net exposure",
      description: "Money at stake in open disputes that the Dispute cover jar doesn't already cover. Zero means every open dispute is covered.",
      isMeasure: true,
      format: "currencyFormat",
      formatOptions: cash,
      expression: { operator: "subtract", inputs: [sum("disputes.at_stake"), sum("disputes.buffer_share")] },
    },
    {
      id: "win_rate",
      name: "Win rate",
      description: "Share of closed disputes that went the seller's way. Blank until a dispute has closed.",
      isMeasure: true,
      format: "percentageFormat",
      formatOptions: pct,
      expression: {
        operator: "if",
        inputs: [{ operator: "greaterThan", inputs: [decided, { type: "number", value: 0 }] }, { operator: "divide", inputs: [sum("disputes.won"), decided] }, { type: "number", value: null }],
      },
    },
    {
      id: "evidence_coverage",
      name: "Evidence coverage",
      description: "On average, how much of the proof PayPal asks for Bundo found in the seller's records (0–100%).",
      isMeasure: true,
      format: "percentageFormat",
      formatOptions: pct,
      expression: { id: "disputes.coverage", aggregation: "avg" },
    },
  ];
}

export function buildModel({ currency, overview, insights, disputes, records = {}, days }: ModelInput): AgDataSourcesDefinition {
  // Excel-style format strings; AG Studio's validator rejects Intl objects here.
  const symbol = new Intl.NumberFormat("en", { style: "currency", currency }).formatToParts(0).find((p) => p.type === "currency")?.value ?? "$";
  const cash = { format: `"${symbol}"#,##0` };
  const pct = { format: "0%" };
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

  // The Dispute cover jar is shared across open disputes in proportion to what each puts at stake, so "Net
  // exposure" can be sliced by reason and still add up.
  const cover = Math.max(0, Number(overview?.positions.find((p) => p.role === "dispute_buffer")?.balance ?? 0));
  const totalAtStake = disputes.filter(isOpen).reduce((n, d) => n + Number(d.amount ?? 0), 0);
  const coveredShare = totalAtStake > 0 ? Math.min(1, cover / totalAtStake) : 0;
  const now = Date.now();

  return {
    sources: [
      {
        id: "money",
        name: "Your money",
        description: "Today's balances, one row. Free to spend is Operating minus the amount the seller always keeps.",
        data: [{ free_to_spend: free, operating, floor, set_aside: jars.reduce((n, p) => n + Math.max(0, Number(p.balance ?? 0)), 0) }],
        fields: [
          { id: "free_to_spend", name: "Free to spend", description: "Operating balance minus the amount always kept", format: "currencyFormat", formatOptions: cash },
          { id: "operating", name: "Operating", description: "The PayPal balance sales land in", format: "currencyFormat", formatOptions: cash },
          { id: "floor", name: "Always kept", description: "The least the seller keeps in Operating", format: "currencyFormat", formatOptions: cash },
          { id: "set_aside", name: "In your jars", description: "Total across Tax, Dispute cover, Ads and Other jars", format: "currencyFormat", formatOptions: cash },
        ],
      },
      {
        id: "jars",
        name: "Jars",
        description: "One row per savings jar (Tax, Dispute cover, Ads, Other) with its balance today.",
        data: jars.map((p) => ({ jar: ROLE_LABELS[p.role], balance: Math.max(0, Number(p.balance ?? 0)), pending: Number(p.pending ?? 0) })),
        fields: [
          { id: "jar", name: "Jar", description: "Which jar", format: "textFormat" },
          { id: "balance", name: "Balance", description: "What's in the jar now", format: "currencyFormat", formatOptions: cash },
          { id: "pending", name: "On its way", description: "Transfers sent but not landed yet", format: "currencyFormat", formatOptions: cash },
        ],
      },
      {
        id: "moved",
        name: "Money set aside",
        description: "Money moved from Operating into a jar, one row per transfer that went through, plus a zero row for every day so time charts show the whole period.",
        data: [...moved, ...quiet],
        fields: [
          { id: "day", name: "Day", description: "Day the money moved", format: "dateFormat", formatOptions: { format: "d mmm" } },
          { id: "jar", name: "Jar", description: "Jar it went into", format: "textFormat" },
          { id: "amount", name: "Amount", description: "How much was set aside", format: "currencyFormat", formatOptions: cash },
        ],
      },
      {
        id: "transfers",
        name: "Transfers",
        description: "Every transfer Bundo tried, including ones the safety checks stopped or held for the seller.",
        // A zero row keeps the tiles reading 0 instead of "No data" before the first transfer.
        data: moves.length ? moves.map((m) => ({
          when: new Date(m.created_at),
          jar: m.role ? ROLE_LABELS[m.role] : "Other",
          amount: Number(m.amount),
          outcome: m.verdict === "block" ? "Stopped" : m.verdict === "ask" ? "Waited for you" : setAside(m) > 0 ? "Moved" : "Not sent",
          stopped: m.verdict === "block" || m.verdict === "ask" ? 1 : 0,
        })) : [{ when: null, jar: null, amount: 0, outcome: null, stopped: 0 }],
        fields: [
          { id: "when", name: "When", description: "When the transfer was tried", format: "dateFormat", formatOptions: { format: "d mmm" } },
          { id: "jar", name: "To", description: "Jar it was for", format: "textFormat" },
          { id: "amount", name: "Amount", description: "How much", format: "currencyFormat", formatOptions: cash },
          { id: "outcome", name: "Outcome", description: "Moved, Stopped, Waited for you, or Not sent", format: "textFormat" },
          { id: "stopped", name: "Stopped by safety checks", description: "1 when a safety check blocked or held it", format: "integerFormat" },
        ],
      },
      {
        id: "disputes",
        name: "Disputes",
        description:
          "One row per PayPal dispute: open ones of any age, plus closed ones in the chosen period. At stake counts open disputes only. " +
          "Won and Lost are 1 once PayPal has closed it. Coverage is how much of the requested proof Bundo found.",
        // Open ones count however old they are (money is at stake today); closed ones only within the range.
        data: disputes
          .filter((d) => isOpen(d) || inRange(d.opened_at))
          .map((d) => {
            const order = d.transaction_id ? orderByTxn.get(d.transaction_id) : undefined;
            const due = d.due_date ? new Date(d.due_date) : null;
            const left = isOpen(d) && due ? Math.ceil((due.getTime() - now) / DAY) : null;
            const atStake = isOpen(d) ? Number(d.amount ?? 0) : 0;
            return {
              dispute_id: d.paypal_dispute_id,
              reason: d.reason_label ?? "Other",
              status: disputeStatus(d.status).label,
              opened: d.opened_at ? new Date(d.opened_at) : null,
              due,
              days_left: left,
              due_soon: isOpen(d) && due && due.getTime() - now <= 2 * DAY ? 1 : 0,
              at_stake: atStake,
              buffer_share: atStake * coveredShare,
              open: isOpen(d) ? 1 : 0,
              won: d.result === "won" ? 1 : 0,
              lost: d.result === "lost" ? 1 : 0,
              coverage: d.coverage ?? null,
              proof: proofLevel(d.coverage),
              handled: d.draft_status === "submitted" || refunded.has(d.id) ? 1 : 0,
              transaction_id: d.transaction_id ?? null,
              // Only meaningful once store data is uploaded: an open dispute whose order has no tracking number.
              no_tracking: hasStore && isOpen(d) && (!order || !tracked.has(order)) ? 1 : 0,
            };
          }),
        fields: [
          { id: "dispute_id", name: "Dispute", description: "PayPal's dispute ID", format: "textFormat" },
          { id: "reason", name: "Reason", description: "What the buyer says went wrong, in plain words", format: "textFormat" },
          // Studio's assistant filters on what this says; it once filtered status to "open", "won", "lost" and emptied every chart.
          { id: "status", name: "Status", description: "Exactly one of: Needs you, PayPal reviewing, Waiting on buyer, Open, Closed. Never won or lost; use the Open disputes, Won and Lost fields for those", format: "textFormat" },
          { id: "opened", name: "Opened", description: "Day the buyer opened it", format: "dateFormat", formatOptions: { format: "d mmm" } },
          { id: "due", name: "Reply due", description: "Last day to answer PayPal", format: "dateFormat", formatOptions: { format: "d mmm" } },
          { id: "days_left", name: "Days left", description: "Days until the reply is due; blank once closed", format: "integerFormat" },
          { id: "due_soon", name: "Due in 48h", description: "1 when an open dispute's reply is due within two days", format: "integerFormat" },
          { id: "at_stake", name: "At stake", description: "Amount the seller could lose; open disputes only", format: "currencyFormat", formatOptions: cash },
          { id: "buffer_share", name: "Covered by jar", description: "This dispute's share of the Dispute cover jar", format: "currencyFormat", formatOptions: cash },
          { id: "open", name: "Open disputes", description: "1 while PayPal hasn't closed it", format: "integerFormat" },
          { id: "won", name: "Won", description: "1 when it closed in the seller's favour", format: "integerFormat" },
          { id: "lost", name: "Lost", description: "1 when it closed in the buyer's favour", format: "integerFormat" },
          { id: "coverage", name: "Proof found", description: "Share of requested proof Bundo found, 0–100%", format: "percentageFormat", formatOptions: pct },
          { id: "proof", name: "Proof strength", description: "Strong, Some, or Little proof, or Not checked yet", format: "textFormat" },
          { id: "handled", name: "Handled by Bundo", description: "1 when Bundo's reply or refund was sent", format: "percentageFormat", formatOptions: pct },
          { id: "transaction_id", name: "PayPal transaction", description: "The sale the dispute is about", format: "textFormat" },
          { id: "no_tracking", name: "Open, no tracking number", description: "1 when the order has no tracking number in uploaded store data", format: "integerFormat" },
        ],
      },
      ...storeSources(records),
    ],
    description:
      "A small online seller's PayPal money and disputes. Jars are savings pots the seller's rules fill from Operating. " +
      "Disputes are buyer claims on PayPal; the seller wins by sending proof before the reply is due.",
    expressions: expressions(pct, cash),
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
      description: `${STORE_NAMES[k]} the seller uploaded from their store, linked to orders by order ID.`,
      data: records[k]!.map((r) => Object.fromEntries(STORE_FIELDS[k].map(([f]) => [f, f === "total" || f === "amount" ? Number(r[f] ?? 0) : (r[f] ?? null)]))),
      fields: STORE_FIELDS[k].map(([id, name]) => ({ id, name, format: id === "total" || id === "amount" ? ("currencyFormat" as const) : ("textFormat" as const) })),
    }));
}
