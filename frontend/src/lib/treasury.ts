"use client";

import { api, json } from "./api";
import { money } from "./format";

export type Role = "operating" | "tax_reserve" | "dispute_buffer" | "ad_spend" | "other";
export type PolicyKind = "tax_reserve" | "dispute_buffer" | "ad_sweep" | "rebalance";

export type Position = { account_id: string; role: Role; name: string; balance: string; source: "paypal" | "simulated" | "ledger" };
export type Account = { id: string; role: Role; name: string; paypal_email: string; opening_balance: string; verified_at: string | null };
export type Limits = {
  currency: string;
  solo_limit: string;
  hard_cap_per_run: string;
  hard_cap_per_day: string | null;
  hard_cap_per_week: string;
  hard_cap_per_month: string | null;
  liquidity_floor: string;
};

export type TaxSpec = { kind: "tax_reserve"; rate: string };
export type BufferSpec = { kind: "dispute_buffer"; coverage: string; volume_pct: string };
export type SweepSpec = { kind: "ad_sweep"; weekday: number; hour: number; amount: string };
export type RebalanceSpec = { kind: "rebalance"; hour: number; ad_amount: string };
export type Spec = TaxSpec | BufferSpec | SweepSpec | RebalanceSpec;
export type PolicyDoc = { name: string; spec: Spec };

export type Version = {
  version: number;
  id: string;
  doc: PolicyDoc;
  spec_hash: string;
  simulated: boolean;
  approved: boolean;
  created_by: "owner" | "copilot";
  created_at: string;
};
export type Policy = {
  id: string;
  kind: PolicyKind;
  status: "draft" | "active" | "paused" | "retired";
  next_run_at: string | null;
  failures: number;
  active_version_id: string | null;
  versions: Version[];
};

export type PlanItem = { role: Role; account_id: string; amount: string; policy: string; idempotency_key: string };
export type Plan = {
  id: string;
  flow_id: string;
  items_json: PlanItem[];
  plan_hash: string;
  total: string;
  status: "needs_approval" | "approved" | "rejected" | "expired" | "executed" | "blocked";
  reason: string;
  expires_at: string;
  created_at: string;
};
export type Movement = {
  id: string;
  flow_id: string | null;
  kind: string;
  amount: string;
  currency: string;
  status: string;
  verdict: "allow" | "ask" | "block";
  check_code: string | null;
  reason: string;
  paypal_ref: string | null;
  created_at: string;
  account_name: string | null;
  role: Role | null;
};
export type Overview = { limits: Limits; positions: Position[]; accounts: Account[]; policies: Policy[]; plans: Plan[]; movements: Movement[] };

export type FeedEntry = {
  id: number;
  flow_id: string | null;
  event: string;
  label: "provider_verified" | "user_uploaded" | "system_generated" | "ai_assessment";
  actor: string | null;
  data_json: Record<string, unknown>;
  created_at: string;
  chain: string | null;
};

export type SimRow = {
  at: string;
  operating_before: string | null;
  outcome: "allow" | "ask" | "block" | "skip";
  check: string;
  reason: string;
  items: { to: Role; amount: string; policy: string }[];
  operating_after: string | null;
  fallback: { to: Role; amount: string; policy: string }[] | null;
};
export type Simulation = { rows: SimRow[]; failure_cases: { case: string; result: string; check: string; reason: string }[]; summary: string; disclaimer: string };

export type CopilotResult = {
  intent: "policies" | "move_now" | "unclear";
  drafts: PolicyDoc[];
  limit_suggestions: Partial<Record<"liquidity_floor" | "solo_limit", string>>;
  move: { role: Role; amount: string } | null;
  questions: string[];
  summary: string;
  source: "model" | "rules";
  verdict?: { decision: string; check: string; reason: string; source: string; money_moved: string; amount: string };
};

export const ROLE_LABELS: Record<Role, string> = {
  operating: "Operating",
  tax_reserve: "Tax Reserve",
  dispute_buffer: "Dispute Margin Buffer",
  ad_spend: "Ad-Spend Wallet",
  other: "Other",
};

export const KIND_LABELS: Record<PolicyKind, { title: string; icon: string; blurb: string }> = {
  tax_reserve: { title: "Rolling tax reserve", icon: "receipt_long", blurb: "Set aside a share of every sale for tax the moment PayPal captures it." },
  dispute_buffer: { title: "Dispute margin buffer", icon: "shield", blurb: "Keep enough aside to cover open disputes plus a share of recent sales." },
  ad_sweep: { title: "Ad-spend sweep", icon: "campaign", blurb: "Move a set amount to ad spend each week, only if the floor holds afterwards." },
  rebalance: { title: "Multi-account rebalance", icon: "balance", blurb: "Top up every reserve in one batch, in priority order, never below the floor." },
};

export const DEFAULT_SPECS: Record<PolicyKind, Spec> = {
  tax_reserve: { kind: "tax_reserve", rate: "0.0825" },
  dispute_buffer: { kind: "dispute_buffer", coverage: "1.00", volume_pct: "0.0200" },
  ad_sweep: { kind: "ad_sweep", weekday: 4, hour: 9, amount: "15000.00" },
  rebalance: { kind: "rebalance", hour: 6, ad_amount: "0.00" },
};

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export const CHECK_LABELS: Record<string, string> = {
  ok: "All 7 checks passed",
  "0_empty_plan": "Nothing to move",
  "1_no_authority": "No approved policy covers this",
  "2_unverified_trigger": "Trigger isn't a verified source",
  "3_unverified_account": "Destination isn't verified",
  "3_unknown_kind": "Unknown movement",
  "4_bad_amount": "Invalid amount",
  "4_hard_cap": "Above the hard cap",
  "4_period_cap": "Above a period cap",
  "5_duplicate": "Duplicate",
  "6_liquidity_floor": "Would breach the liquidity floor",
  "6_balance_unknown": "Balance unknown",
  "7_needs_approval": "Above your solo limit",
  owner_declined: "You declined",
  nothing_to_do: "Targets already met",
};

export const LABEL_COPY: Record<FeedEntry["label"], string> = {
  provider_verified: "PayPal-verified",
  user_uploaded: "Uploaded",
  system_generated: "System",
  ai_assessment: "AI",
};

export function latest(p: Policy): Version | undefined {
  return p.versions[p.versions.length - 1];
}

export function active(p: Policy): Version | undefined {
  return p.versions.find((v) => v.id === p.active_version_id);
}

export const treasury = {
  overview: () => api<Overview>("/treasury/overview"),
  createPolicy: (doc: PolicyDoc) => api<{ policy_id: string; version: number; spec_hash: string }>("/treasury/policies", json({ doc })),
  editPolicy: (id: string, doc: PolicyDoc) =>
    api<{ policy_id: string; version: number; spec_hash: string }>(`/treasury/policies/${id}`, { method: "PUT", body: JSON.stringify({ doc }) }),
  simulate: (id: string, version: number, weekly_inflow?: string) =>
    api<Simulation>(`/treasury/policies/${id}/versions/${version}/simulate`, json(weekly_inflow ? { weekly_inflow } : {})),
  approve: (id: string, version: number, spec_hash: string) =>
    api(`/treasury/policies/${id}/versions/${version}/approve`, json({ spec_hash })),
  action: (id: string, action: "pause" | "resume" | "retire" | "run") =>
    api<Record<string, unknown>>(`/treasury/policies/${id}/${action}`, { method: "POST" }),
  approvePlan: (id: string, plan_hash: string) => api<Record<string, unknown>>(`/treasury/plans/${id}/approve`, json({ plan_hash })),
  rejectPlan: (id: string) => api(`/treasury/plans/${id}/reject`, { method: "POST" }),
  addAccount: (a: { role: Role; name: string; paypal_email: string; opening_balance: string }) => api<{ id: string }>("/treasury/accounts", json(a)),
  editAccount: (id: string, a: { name: string; paypal_email: string; opening_balance: string }) =>
    api(`/treasury/accounts/${id}`, { method: "PUT", body: JSON.stringify(a) }),
  verifyAccount: (id: string) => api(`/treasury/accounts/${id}/verify`, { method: "POST" }),
  copilot: (text: string) => api<CopilotResult>("/treasury/copilot", json({ text })),
  acceptDrafts: (drafts: PolicyDoc[]) =>
    api<{ created: { policy_id: string; version: number }[] }>("/treasury/copilot/accept", json({ drafts })),
  putLimits: (l: Omit<Limits, "currency">) => api("/treasury/limits", { method: "PUT", body: JSON.stringify(l) }),
};

export function changed() {
  window.dispatchEvent(new CustomEvent("disputes-synced"));
}

// ---------------------------------------------------------------------------------------- plain words
// Everything below turns engine records into sentences a merchant reads at a glance. Internal ids, hashes and
// raw payloads never leave this file.


/** One sentence describing what a policy does. */
export function describePolicy(d: PolicyDoc, currency: string): string {
  const s = d.spec;
  const pc = (v: string) => `${Math.round(Number(v) * 10000) / 100}%`;
  if (s.kind === "tax_reserve") return `Sets aside ${pc(s.rate)} of every sale for tax.`;
  if (s.kind === "dispute_buffer") return `Keeps ${pc(s.coverage)} of open disputes plus ${pc(s.volume_pct)} of 30-day sales aside.`;
  if (s.kind === "ad_sweep") return `Every ${WEEKDAYS[s.weekday]}, moves ${money(s.amount, currency)} to ad spend if Operating stays above its floor.`;
  return `Each day, tops up every reserve in priority order${Number(s.ad_amount) > 0 ? `, then ad spend up to ${money(s.ad_amount, currency)}` : ""}.`;
}

export type State = { label: string; tone: "cerulean" | "plum" | "cream" | "soft" };

/** A policy's state in one or two words. Version numbers stay out of sight. */
export function policyState(p: Policy): State {
  const live = active(p);
  const last = latest(p);
  if (live && last && last.version > live.version) return { label: p.status === "active" ? "Running, changes to review" : "Changes to review", tone: "plum" };
  if (p.status === "paused") return { label: "Paused", tone: "cream" };
  if (p.status === "active") return { label: "Running", tone: "cerulean" };
  if (last?.created_by === "copilot") return { label: "Draft from Copilot", tone: "soft" };
  return { label: "Draft", tone: "soft" };
}

/** A short, human reference for a flow, safe to read out to support. Never the raw id. */
export function reference(flowId: string | null | undefined): string {
  return flowId ? `BP-${flowId.replace(/-/g, "").slice(0, 6).toUpperCase()}` : "—";
}

function kindOf(ref: unknown): PolicyKind | null {
  const k = String(ref ?? "").split("@")[0];
  return k in KIND_LABELS ? (k as PolicyKind) : null;
}

/** "Ad-spend sweep", "Copilot request", …: a flow's title in words. */
export function flowTitle(policy: string | null, startedBy: string | null): string {
  const k = kindOf(policy);
  if (k) return KIND_LABELS[k].title;
  if (startedBy?.startsWith("copilot")) return "Copilot request";
  return "Treasury activity";
}

export type Said = { text: string; tone: "good" | "wait" | "stop" | "quiet"; icon: string };

/** One History entry as a plain sentence, or null when it's bookkeeping no merchant needs to see. */
export function describeEntry(e: FeedEntry, currency = "USD"): Said | null {
  const d = e.data_json ?? {};
  const s = (k: string) => (d[k] == null ? "" : String(d[k]));
  const amt = (k: string) => (s(k) ? money(s(k), currency) : "");
  const sum = amt("total") || amt("amount");
  const check = CHECK_LABELS[s("check")]?.toLowerCase() ?? "a safety check failed";
  const items = Array.isArray(d.items)
    ? (d.items as { role: Role; amount: string }[]).map((i) => `${money(i.amount, currency)} to ${ROLE_LABELS[i.role] ?? "another account"}`).join(" and ")
    : "";
  const k = kindOf(d.policy);
  const doc = d.doc as PolicyDoc | undefined;
  const by = e.label === "ai_assessment" || e.actor?.startsWith("copilot") ? "Copilot" : "You";

  switch (e.event) {
    case "trigger.verified": {
      const why = s("slot").startsWith("manual") ? "you asked" : s("slot").startsWith("capture") ? "a sale came in" : "it was scheduled";
      return { text: `${k ? KIND_LABELS[k].title : "A policy"} started because ${why}`, tone: "quiet", icon: "play_circle" };
    }
    case "trigger.unverified": return { text: "A run was ignored because its trigger couldn't be confirmed", tone: "stop", icon: "block" };
    case "plan.proposed": return { text: items ? `Planned ${items}` : "Planned a transfer", tone: "quiet", icon: "edit_note" };
    case "plan.rebalanced": return { text: `Adjusted the plan to ${items || "fit"} so Operating stays above its floor`, tone: "quiet", icon: "tune" };
    case "plan.skipped": return { text: "Nothing to move: every reserve is already on target", tone: "quiet", icon: "check_circle" };
    case "safety.allow": return { text: `Safety checks passed${sum ? ` for ${sum}` : ""}`, tone: "good", icon: "verified_user" };
    case "safety.ask": return { text: `${sum || "A transfer"} is waiting for your OK: it's above your auto-run limit`, tone: "wait", icon: "pending_actions" };
    case "safety.block": return { text: `Stopped ${sum || "a transfer"}: ${check}. Nothing moved`, tone: "stop", icon: "block" };
    case "approval.granted": return { text: `You approved ${sum || "a transfer"}`, tone: "good", icon: "thumb_up" };
    case "approval.declined": return { text: "You declined a transfer. Nothing moved", tone: "quiet", icon: "do_not_disturb_on" };
    case "execution.submitted": return { text: `Sent ${sum || "the transfer"} to PayPal`, tone: "quiet", icon: "send" };
    case "execution.accepted": return { text: "PayPal accepted the transfer", tone: "good", icon: "task_alt" };
    case "execution.confirmed": return { text: `PayPal confirmed ${sum || "the payment"}`, tone: "good", icon: "check_circle" };
    case "execution.failed": return { text: "PayPal turned the transfer down. Nothing moved", tone: "stop", icon: "error" };
    case "execution.unconfirmed": return { text: "Waiting to hear back from PayPal before trying again", tone: "wait", icon: "hourglass_top" };
    case "execution.item_failed": return { text: "One payment in the transfer didn't go through", tone: "stop", icon: "error" };
    case "execution.refused": return { text: "Not sent: the destination account is no longer confirmed", tone: "stop", icon: "block" };
    case "capture.recorded": return { text: `A sale of ${sum || "money"} came in`, tone: "quiet", icon: "payments" };
    case "policy.version_drafted": return { text: `${by} drafted ${doc?.name ? `“${doc.name}”` : "a policy"}`, tone: "quiet", icon: by === "Copilot" ? "auto_awesome" : "edit" };
    case "policy.simulated": return null; // a preview moves nothing
    case "policy.approved": return { text: "You approved a policy and turned it on", tone: "good", icon: "toggle_on" };
    case "policy.paused": return { text: "A policy was paused", tone: "quiet", icon: "pause_circle" };
    case "policy.active": return { text: "A policy was resumed", tone: "quiet", icon: "play_circle" };
    case "policy.retired": return { text: "A policy was retired", tone: "quiet", icon: "archive" };
    case "account.added": return { text: `Added the ${s("name") || "new"} account`, tone: "quiet", icon: "add_card" };
    case "account.edited": return { text: "Updated an account's details", tone: "quiet", icon: "edit" };
    case "account.verified": return { text: "Confirmed an account's details", tone: "good", icon: "verified" };
    case "limits.updated": return { text: "Updated your safety limits", tone: "quiet", icon: "shield" };
    case "copilot.interpreted":
      return s("intent") === "move_now"
        ? { text: "Copilot was asked to move money now, which it can't do", tone: "stop", icon: "auto_awesome" }
        : { text: "Copilot read your request and drafted policies", tone: "quiet", icon: "auto_awesome" };
    default: return null;
  }
}

/** Facts worth keeping from a flow, for its Details panel. Human references only. */
export function flowFacts(entries: FeedEntry[], currency = "USD"): [string, string][] {
  const facts: [string, string][] = [];
  const find = (ev: string) => entries.find((e) => e.event === ev);
  const val = (e: FeedEntry | undefined, k: string) => (e?.data_json?.[k] == null ? "" : String(e.data_json[k]));
  const approved = find("approval.granted");
  if (approved) facts.push(["Approved", `By you at ${new Date(approved.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`]);
  const batch = val(find("execution.confirmed"), "payout_batch") || val(find("execution.accepted"), "payout_batch");
  if (batch) facts.push(["PayPal reference", batch]);
  const total = val(find("execution.confirmed"), "amount") || val(find("safety.allow"), "total");
  if (total) facts.push(["Amount", money(total, currency)]);
  const source = entries.some((e) => e.label === "provider_verified") ? "Confirmed by PayPal" : "Recorded by BundoPay";
  facts.push(["Source", source]);
  return facts;
}

/** Spreadsheet-friendly CSV (with a byte-order mark so Excel reads the currency symbols). */
export function downloadCsv(filename: string, rows: (string | number)[][]) {
  const cell = (v: string | number) => {
    const t = String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const blob = new Blob(["﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

const STATUS_WORDS: Record<string, string> = {
  allowed: "Approved", executing: "Sending", succeeded: "Completed", confirmed: "Completed", blocked: "Stopped", failed: "Failed",
  needs_approval: "Waiting for you", declined: "Declined", pending: "Pending", unconfirmed: "Waiting on PayPal",
};

/** A movement's status in words. */
export function movementStatus(m: Movement): string {
  return STATUS_WORDS[m.status] ?? m.status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** The statement CSV: one row per movement, oldest last, the way a bank statement reads. */
export function downloadStatement(movements: Movement[]) {
  const rows: (string | number)[][] = [["Date", "What happened", "To", "Amount", "Currency", "Status", "Reference"]];
  for (const m of movements) {
    rows.push([
      new Date(m.created_at).toLocaleString(),
      m.verdict === "block" ? `Stopped: ${CHECK_LABELS[m.check_code ?? ""] ?? "safety check"}` : m.kind === "refund" ? "Refund" : "Transfer between your accounts",
      m.account_name ?? (m.role ? ROLE_LABELS[m.role] : ""),
      Number(m.amount).toFixed(2),
      m.currency,
      movementStatus(m),
      reference(m.flow_id),
    ]);
  }
  downloadCsv(`bundopay-treasury-statement-${new Date().toISOString().slice(0, 10)}.csv`, rows);
}
