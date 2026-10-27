"use client";

import { useState } from "react";

import { ago, money, when } from "@/lib/format";
import { type FeedEntry, type PlanItem, ROLE_LABELS, type Role, type Said, changed, describeEntry, plainReason, treasury } from "@/lib/treasury";

import { Button, Icon, Pill, type Tone } from "./ui";

export const ROLE_ICON: Record<string, string> = {
  operating: "account_balance",
  tax_reserve: "receipt_long",
  dispute_buffer: "shield",
  ad_spend: "campaign",
  other: "wallet",
};

/** Accounts in the order a merchant thinks of them: the one the business runs on, then each jar. */
export const ROLE_ORDER: Role[] = ["operating", "tax_reserve", "dispute_buffer", "ad_spend", "other"];

/** A transfer the safety engine asked the owner about. Approving is an authenticated tap bound to this exact plan;
 * the server re-runs every check before anything is sent. */
export function PlanApproval({
  plan,
  currency = "USD",
  onDone,
}: {
  plan: { plan_id: string; plan_hash: string; total: string; items: PlanItem[]; status: string; reason?: string; expires_at?: string };
  currency?: string;
  onDone?: (result: string) => void;
}) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const open = plan.status === "needs_approval" && !result;

  async function run(kind: "approve" | "reject") {
    setBusy(kind);
    setError(null);
    try {
      let said: string;
      if (kind === "approve") {
        const r = await treasury.approvePlan(plan.plan_id, plan.plan_hash);
        said =
          r.status === "allowed"
            ? r.execution === "succeeded" ? `Approved. PayPal confirmed the ${money(plan.total, currency)} transfer.` : `Approved. ${money(plan.total, currency)} is on its way; PayPal will confirm it shortly.`
            : `Not sent: something changed since you were asked. ${plainReason(String(r.reason ?? ""))}`;
      } else {
        await treasury.rejectPlan(plan.plan_id);
        said = `Declined. ${money(plan.total, currency)} stays in Operating; nothing was sent.`;
      }
      setResult(said);
      changed();
      onDone?.(said);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const statusPill: Record<string, [Tone, string]> = {
    executed: ["cerulean", "Approved and sent"],
    approved: ["cerulean", "Approved"],
    rejected: ["soft", "Declined"],
    blocked: ["danger", "Not sent"],
    expired: ["soft", "Expired"],
  };
  const pill = statusPill[plan.status];

  return (
    <div className="rounded-[18px] bg-card p-5 ring-1 ring-ink/[0.08]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[22px] font-semibold tabular-nums tracking-[-0.02em]">Move {money(plan.total, currency)}</p>
          {plan.reason && <p className="mt-1 text-[13px] text-muted">{plainReason(plan.reason)}</p>}
        </div>
        {pill && !open && <Pill tone={pill[0]}>{pill[1]}</Pill>}
      </div>
      <ul className="mt-4 space-y-2 text-sm">
        {plan.items.map((i) => (
          <li key={i.idempotency_key} className="flex justify-between gap-4">
            <span className="flex items-center gap-2 text-ink-2">
              <Icon name={ROLE_ICON[i.role] ?? "wallet"} className="text-[18px] text-muted" /> To {ROLE_LABELS[i.role] ?? "another account"}
            </span>
            <span className="font-medium tabular-nums">{money(i.amount, currency)}</span>
          </li>
        ))}
      </ul>
      {open && (
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button variant="primary" disabled={!!busy} onClick={() => run("approve")}>
            {busy === "approve" ? "Checking and sending…" : `Approve ${money(plan.total, currency)}`}
          </Button>
          <Button variant="ghost" disabled={!!busy} className="text-muted hover:text-danger" onClick={() => run("reject")}>
            {busy === "reject" ? "Declining…" : "Decline"}
          </Button>
          {plan.expires_at && <span className="ml-auto text-xs text-muted">Expires {when(plan.expires_at)}</span>}
        </div>
      )}
      {result && <p className="mt-4 text-sm font-medium text-ink-2">{result}</p>}
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
    </div>
  );
}

const SAID_TILE: Record<Said["tone"], string> = {
  good: "bg-primary-fixed text-primary",
  wait: "bg-ice/50 text-ink",
  stop: "bg-danger-soft text-danger",
  quiet: "bg-soft text-muted",
};

/** One line per flow (its latest step) plus standalone events, newest first. */
export function condense(entries: FeedEntry[], currency = "USD"): { e: FeedEntry; said: Said }[] {
  const seen = new Set<string>();
  const out: { e: FeedEntry; said: Said }[] = [];
  for (const e of [...entries].sort((a, b) => b.id - a.id)) {
    if (e.flow_id) {
      if (seen.has(e.flow_id)) continue;
      seen.add(e.flow_id);
    }
    const said = describeEntry(e, currency);
    if (said) out.push({ e, said });
  }
  return out;
}

/** Treasury activity in plain sentences. No codes, ids or payloads. */
export function ActivityList({ items, empty = "Nothing has happened yet." }: { items: { e: FeedEntry; said: Said }[]; empty?: string }) {
  if (!items.length) return <p className="py-2 text-sm text-muted">{empty}</p>;
  return (
    <ul className="divide-y divide-ink/[0.06]">
      {items.map(({ e, said }) => (
        <li key={e.id} className="flex items-start gap-3.5 py-3.5 first:pt-0 last:pb-0">
          <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${SAID_TILE[said.tone]}`}><Icon name={said.icon} className="text-[18px]" /></span>
          <p className="min-w-0 flex-1 pt-1.5 text-sm leading-snug">{said.text}</p>
          <time dateTime={e.created_at} title={when(e.created_at)} className="shrink-0 pt-1.5 text-xs text-muted">{ago(e.created_at)}</time>
        </li>
      ))}
    </ul>
  );
}
