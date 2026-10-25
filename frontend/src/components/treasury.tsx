"use client";

import { useState } from "react";

import { ago, money, when } from "@/lib/format";
import { type FeedEntry, type PlanItem, type Position, ROLE_LABELS, type Role, type Said, changed, describeEntry, treasury } from "@/lib/treasury";

import { Button, Icon, Pill, type Tone, Tooltip } from "./ui";

export const ROLE_ICON: Record<string, string> = {
  operating: "account_balance",
  tax_reserve: "receipt_long",
  dispute_buffer: "shield",
  ad_spend: "campaign",
  other: "wallet",
};

// One shade per account, all from the Bundo palette, darkest for the money the business runs on.
const ROLE_SHADE: Record<Role, string> = {
  operating: "bg-ink",
  tax_reserve: "bg-primary",
  dispute_buffer: "bg-muted",
  ad_spend: "bg-aqua",
  other: "bg-ice",
};

const SOURCE: Record<Position["source"], string> = {
  paypal: "Balance read from PayPal",
  simulated: "Your opening balance plus confirmed transfers",
  ledger: "Opening balance plus transfers PayPal confirmed",
};

/** The first thing Treasury shows: how much there is, and how it's split. */
export const ROLE_ORDER: Role[] = ["operating", "tax_reserve", "dispute_buffer", "ad_spend", "other"];

export function TreasuryHero({ positions: unordered, floor, currency, actions }: { positions: Position[]; floor: string; currency: string; actions?: React.ReactNode }) {
  const positions = [...unordered].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
  const total = positions.reduce((n, p) => n + Math.max(0, Number(p.balance)), 0);
  return (
    <section aria-label="Treasury balance" className="rounded-[24px] bg-card p-6 shadow-card sm:p-9">
      <div className="flex items-center justify-between gap-4">
        <p className="text-[15px] text-muted">Total in treasury</p>
        {actions && <div className="-my-2 -mr-2 flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
      <p className="mt-1 break-words text-[34px] font-semibold leading-tight tracking-[-0.03em] tabular-nums sm:text-[48px] sm:leading-none">{money(String(total), currency)}</p>
      <p className="mt-2.5 text-sm text-muted">Held across {positions.length} account{positions.length === 1 ? "" : "s"}</p>

      {total > 0 && (
        <div className="mt-8 flex h-2.5 gap-[3px] overflow-hidden rounded-full" aria-hidden>
          {positions.map((p) => {
            const share = Math.max(0, Number(p.balance)) / total;
            return share > 0 ? <span key={p.account_id} className={`${ROLE_SHADE[p.role]} rounded-full`} style={{ flexGrow: share, minWidth: 6 }} /> : null;
          })}
        </div>
      )}

      <ul className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 xl:grid-cols-4">
        {positions.map((p) => {
          const isOp = p.role === "operating";
          const below = isOp && Number(p.balance) < Number(floor);
          const at = isOp && Number(p.balance) === Number(floor);
          return (
            <li key={p.account_id} className="min-w-0">
              <Tooltip label={SOURCE[p.source]} side="top">
                <span className="flex min-w-0 items-center gap-2 text-sm text-ink-2" tabIndex={0}>
                  <span className={`h-2 w-2 shrink-0 rounded-full ${ROLE_SHADE[p.role]}`} aria-hidden />
                  <span className="truncate">{p.name}</span>
                </span>
              </Tooltip>
              <p className="mt-1 pl-4 text-[19px] font-semibold tabular-nums tracking-[-0.015em]">{money(p.balance, currency)}</p>
              {isOp && (
                <p className={`mt-0.5 pl-4 text-xs ${below ? "font-semibold text-danger" : at ? "font-medium text-ink-2" : "text-muted"}`}>
                  {below ? `Below its ${money(floor, currency)} floor` : at ? `At its ${money(floor, currency)} floor` : `Floor ${money(floor, currency)}`}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A transfer the safety engine asked the owner about. Approving is an authenticated tap bound to this exact plan;
 * the server re-runs every check before anything is sent. */
export function PlanApproval({
  plan,
  currency = "USD",
  onDone,
}: {
  plan: { plan_id: string; plan_hash: string; total: string; items: PlanItem[]; status: string; reason?: string; expires_at?: string };
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
            ? r.execution === "succeeded" ? "Approved. PayPal confirmed the transfer." : "Approved and sent. Waiting for PayPal to confirm."
            : `Not sent: something changed since you were asked. ${String(r.reason ?? "")}`,
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
          {plan.reason && <p className="mt-1 text-[13px] text-muted">{plan.reason}</p>}
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
