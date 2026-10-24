"use client";

import { useState } from "react";

import { money } from "@/lib/format";
import { CHECK_LABELS, type FeedEntry, LABEL_COPY, type PlanItem, type Position, ROLE_LABELS, changed, treasury } from "@/lib/treasury";

import { Button, Icon, Pill, type Tone } from "./ui";

const ROLE_ICON: Record<string, string> = {
  operating: "account_balance",
  tax_reserve: "receipt_long",
  dispute_buffer: "shield",
  ad_spend: "campaign",
  other: "wallet",
};

const SOURCE: Record<Position["source"], { label: string; tone: Tone; title: string }> = {
  paypal: { label: "PayPal balance", tone: "cerulean", title: "Read from PayPal's balance API" },
  simulated: { label: "Simulated", tone: "cream", title: "Your seeded opening balance plus confirmed movements. PayPal's sandbox didn't return a balance." },
  ledger: { label: "Ledger", tone: "soft", title: "Opening balance plus movements PayPal confirmed. BundoPay can't read another account's balance." },
};

export function PositionCards({ positions, floor, currency }: { positions: Position[]; floor: string; currency: string }) {
  if (!positions.length) return null;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {positions.map((p) => {
        const s = SOURCE[p.source];
        const atFloor = p.role === "operating" && Number(p.balance) <= Number(floor);
        return (
          <div key={p.account_id} className="rounded-[20px] bg-card p-5 shadow-card">
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-ink-2">
                <Icon name={ROLE_ICON[p.role] ?? "wallet"} className="text-[18px] text-primary" />
                <span className="truncate">{p.name}</span>
              </span>
              <span title={s.title}><Pill tone={s.tone}>{s.label}</Pill></span>
            </div>
            <p className="mt-4 text-[28px] font-semibold tabular-nums tracking-[-0.02em]">{money(p.balance, currency)}</p>
            {p.role === "operating" ? (
              <p className={`mt-1 text-xs ${atFloor ? "font-semibold text-danger" : "text-muted"}`}>
                Floor {money(floor, currency)}{atFloor ? ": at or below" : ""}
              </p>
            ) : (
              <p className="mt-1 text-xs text-muted">{ROLE_LABELS[p.role]}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** An approval card for a plan the engine asked the owner about. Approving is an authenticated tap bound to
 * the plan hash shown here; the server re-runs every check before anything is sent. */
export function PlanApproval({
  plan,
  currency = "USD",
  onDone,
}: {
  plan: { plan_id: string; plan_hash: string; total: string; items: PlanItem[]; status: string; reason?: string };
  currency?: string;
  onDone?: () => void;
}) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const open = plan.status === "needs_approval" && !result;

  async function run(kind: "approve" | "reject") {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "approve") {
        const r = await treasury.approvePlan(plan.plan_id, plan.plan_hash);
        setResult(
          r.status === "allowed"
            ? r.execution === "succeeded" ? "Sent and confirmed by PayPal." : "Sent to PayPal. Waiting for confirmation."
            : `Blocked on re-check: ${String(r.reason ?? "")}`,
        );
      } else {
        await treasury.rejectPlan(plan.plan_id);
        setResult("Declined. Nothing was sent.");
      }
      changed();
      onDone?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const statusPill: Record<string, [Tone, string]> = {
    needs_approval: ["plum", "Needs your OK"],
    executed: ["cerulean", "Approved and sent"],
    approved: ["cerulean", "Approved"],
    rejected: ["soft", "Declined"],
    blocked: ["danger", "Blocked on re-check"],
    expired: ["soft", "Expired"],
  };
  const [tone, label] = statusPill[plan.status] ?? ["soft", plan.status];

  return (
    <div className="rounded-[14px] bg-card px-4 py-3 ring-1 ring-ink/[0.12]">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold">Move {money(plan.total, currency)}</span>
        <Pill tone={tone}>{label}</Pill>
      </div>
      <ul className="mt-2 space-y-1 text-[13px]">
        {plan.items.map((i) => (
          <li key={i.idempotency_key} className="flex justify-between gap-4">
            <span className="text-muted">→ {ROLE_LABELS[i.role] ?? i.role}</span>
            <span className="font-semibold tabular-nums">{money(i.amount, currency)}</span>
          </li>
        ))}
      </ul>
      {open && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-ink/[0.06] pt-3">
          <Button variant="primary" disabled={!!busy} className="min-h-8 px-3.5 text-[13px]" onClick={() => run("approve")}>
            <Icon name="check" className="text-[16px]" /> {busy === "approve" ? "Checking and sending" : `Approve ${money(plan.total, currency)}`}
          </Button>
          <Button variant="ghost" disabled={!!busy} className="min-h-8 text-[13px] text-danger" onClick={() => run("reject")}>
            Decline
          </Button>
        </div>
      )}
      {result && <p className="mt-2 text-xs font-semibold text-ink-2">{result}</p>}
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  );
}

const EVENT_TONE: Record<string, string> = {
  "safety.block": "text-[#ff9b8f]",
  "safety.ask": "text-[#ffd479]",
  "safety.allow": "text-[#8fe3b0]",
  "execution.confirmed": "text-[#8fe3b0]",
  "execution.failed": "text-[#ff9b8f]",
  "execution.unconfirmed": "text-[#ffd479]",
  "approval.granted": "text-ice",
};

function summary(e: FeedEntry): string {
  const d = e.data_json as Record<string, unknown>;
  const pick = (k: string) => (d[k] == null ? null : String(d[k]));
  if (e.event.startsWith("safety.")) {
    const check = pick("check") ?? "";
    return `${check} · ${CHECK_LABELS[check] ?? ""}${pick("total") ? ` · $${pick("total")}` : pick("amount") ? ` · $${pick("amount")}` : ""} · moved $${pick("money_moved") ?? "0.00"}`;
  }
  if (e.event === "plan.proposed" || e.event === "plan.rebalanced") {
    const items = (d.items as { role: string; amount: string }[] | undefined) ?? [];
    return items.map((i) => `${ROLE_LABELS[i.role as keyof typeof ROLE_LABELS] ?? i.role} $${i.amount}`).join(" + ") || "nothing";
  }
  if (e.event.startsWith("execution.")) return [pick("payout_batch"), pick("status"), pick("request_id"), pick("error")].filter(Boolean).join(" · ");
  if (e.event === "approval.granted") return `${pick("token")} · $${pick("total")}`;
  if (e.event.startsWith("trigger.")) return [pick("policy"), pick("slot")].filter(Boolean).join(" · ");
  if (e.event.startsWith("capture.")) return `${pick("capture_id")} · $${pick("amount")}`;
  return Object.entries(d).slice(0, 3).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(" ");
}

/** The console's right-hand pane: History entries as they're written, one line each. */
export function LiveLog({ entries }: { entries: FeedEntry[] }) {
  const [raw, setRaw] = useState(false);
  return (
    <div className="flex h-full min-h-[420px] flex-col overflow-hidden rounded-[20px] bg-ink text-[12.5px] text-white/90 shadow-card">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <span className="flex items-center gap-2 font-semibold text-white">
          <span className="h-2 w-2 animate-pulse rounded-full bg-[#8fe3b0]" aria-hidden /> Live treasury log
        </span>
        <button onClick={() => setRaw((r) => !r)} className="rounded-full px-2.5 py-1 text-[11px] font-semibold text-ice hover:bg-white/10">
          {raw ? "Readable" : "Raw JSON"}
        </button>
      </div>
      <ol className="flex-1 space-y-1.5 overflow-y-auto px-4 py-3 font-mono" aria-live="polite">
        {entries.length === 0 && <li className="text-white/50">Waiting for the first event…</li>}
        {entries.map((e) =>
          raw ? (
            <li key={e.id} className="break-all text-white/80">
              {JSON.stringify({ t: e.created_at, type: e.event, label: e.label, flow: e.flow_id?.slice(0, 8), chain: e.chain, ...e.data_json })}
            </li>
          ) : (
            <li key={e.id} className="grid grid-cols-[auto_1fr] gap-x-3">
              <span className="tabular-nums text-white/45">{new Date(e.created_at).toISOString().slice(11, 19)}Z</span>
              <span className="min-w-0">
                <span className={`font-semibold ${EVENT_TONE[e.event] ?? "text-white"}`}>{e.event}</span>{" "}
                <span className="text-white/75">{summary(e)}</span>{" "}
                <span className="text-white/35">[{LABEL_COPY[e.label]}{e.chain ? ` · ${e.chain}` : ""}]</span>
              </span>
            </li>
          ),
        )}
      </ol>
    </div>
  );
}
