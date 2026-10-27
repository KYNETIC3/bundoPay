"use client";

import Link from "next/link";

import { money } from "@/lib/format";
import { freeToSpend, isOpen } from "@/lib/studio/model";
import { type Overview, type Position, ROLE_LABELS } from "@/lib/treasury";
import type { DisputeSummary } from "@/lib/types";

import { CountUp, Reveal } from "./motion";
import { ROLE_ICON, ROLE_ORDER } from "./treasury";
import { Icon } from "./ui";

const WHAT_FOR: Partial<Record<Position["role"], string>> = {
  tax_reserve: "Owed as tax",
  dispute_buffer: "Covers disputes and refunds",
  ad_spend: "For your ads",
  other: "Set aside",
};

/** The answer to "how much can I spend?", first and biggest. The total and what's in jars sit underneath. */
export function BalanceHero({ overview, actions }: { overview: Overview; actions?: React.ReactNode }) {
  const c = overview.limits.currency;
  const { free, floor } = freeToSpend(overview);
  const jars = overview.positions.filter((p) => p.role !== "operating");
  const jarred = jars.reduce((n, p) => n + Math.max(0, Number(p.balance ?? 0)), 0);
  const op = overview.positions.find((p) => p.role === "operating");
  const below = op && op.balance !== null && Number(op.balance) < floor;

  return (
    <section aria-label="Free to spend" className="rise rounded-[24px] bg-card p-6 shadow-card sm:p-9">
      <div className="flex items-center justify-between gap-4">
        <p className="text-[15px] text-muted">Free to spend</p>
        {actions && <div className="-my-2 -mr-2 flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
      {free === null ? (
        <p className="mt-1 text-[28px] font-semibold leading-tight tracking-[-0.03em] sm:text-[36px]">Not available yet</p>
      ) : (
        <p aria-live="polite" className="mt-1 break-words text-[40px] font-semibold leading-none tracking-[-0.035em] sm:text-[56px]">
          <CountUp value={free} currency={c} />
        </p>
      )}
      <p className={`mt-3 text-[15px] ${below ? "font-semibold text-danger" : "text-ink-2"}`}>
        {free === null
          ? "PayPal hasn't shared Operating's balance yet."
          : below
            ? `Operating is below the ${money(String(floor), c)} it always keeps.`
            : <>After the <span className="tabular-nums">{money(String(floor), c)}</span> Operating always keeps. <span className="tabular-nums">{money(String(jarred), c)}</span> is in your jars.</>}
      </p>
    </section>
  );
}

/** One card per jar: what's in it and what it's for. Dispute cover links straight to the disputes it covers. */
export function JarStrip({ overview, disputes }: { overview: Overview; disputes: DisputeSummary[] }) {
  const c = overview.limits.currency;
  const jars = overview.positions.filter((p) => p.role !== "operating").sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
  const open = disputes.filter(isOpen);
  const atStake = open.reduce((n, d) => n + Number(d.amount ?? 0), 0);
  if (!jars.length) return null;
  return (
    <ul className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:grid-cols-3 sm:overflow-visible sm:px-0">
      {jars.map((p, i) => {
        const cover = p.role === "dispute_buffer";
        const body = (
          <>
            <span className="flex items-center justify-between">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary-fixed text-primary"><Icon name={ROLE_ICON[p.role] ?? "wallet"} className="text-[18px]" /></span>
              {cover && open.length > 0 && <Icon name="chevron_right" className="text-muted transition group-hover:translate-x-0.5 group-hover:text-ink" />}
            </span>
            <span className="mt-4 block text-sm text-ink-2">{ROLE_LABELS[p.role] ?? p.name}</span>
            <span className="mt-0.5 block text-[24px] font-semibold tracking-[-0.02em]"><CountUp value={Math.max(0, Number(p.balance ?? 0))} currency={c} /></span>
            <span className="mt-1 block text-xs text-muted">
              {cover && open.length
                ? `Covers ${open.length} open ${open.length === 1 ? "dispute" : "disputes"}, ${money(String(atStake), c)} at stake`
                : Number(p.pending) > 0 ? `${money(p.pending, c)} on its way` : WHAT_FOR[p.role]}
            </span>
          </>
        );
        const cls = "press group block h-full min-w-[200px] snap-start rounded-[20px] bg-card p-5 shadow-card transition hover:shadow-lift";
        return (
          <li key={p.account_id} className="shrink-0 sm:min-w-0">
            <Reveal index={i} className="h-full">
              {cover && open.length ? <Link href="/money/disputes" className={cls}>{body}</Link> : <div className={cls}>{body}</div>}
            </Reveal>
          </li>
        );
      })}
    </ul>
  );
}
