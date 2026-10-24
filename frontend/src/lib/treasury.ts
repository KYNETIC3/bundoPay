"use client";

import { api, json } from "./api";

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
