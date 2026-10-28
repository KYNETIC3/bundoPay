"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Countdown } from "@/components/Countdown";
import { BalanceHero } from "@/components/money";
import { Reveal, Skeleton, SuccessTick } from "@/components/motion";
import { PlanApproval } from "@/components/treasury";
import { Button, Card, Empty, Icon, SendButton } from "@/components/ui";
import { feedback } from "@/lib/feedback";
import { money, when } from "@/lib/format";
import { agentState } from "@/lib/status";
import { isOpen } from "@/lib/studio/model";
import { useMoneyModel } from "@/lib/studio/useModel";
import type { DisputeSummary } from "@/lib/types";

// AG Studio measures the page and uses localStorage, so boards only ever render in the browser.
const Board = dynamic(() => import("@/components/Board"), { ssr: false, loading: () => <Skeleton className="h-[480px]" /> });

const needsAnswer = (d: DisputeSummary) =>
  isOpen(d) && ((d.status === "WAITING_FOR_SELLER_RESPONSE" && d.draft_status !== "submitted") || d.draft_status === "awaiting_approval");

/** Home answers three questions, in order: how much can I spend, does anything need me, and how is it going. */
export default function HomePage() {
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const { model, overview, disputes, insights, ready, currency } = useMoneyModel(days);
  const [editing, setEditing] = useState(false);
  const [resetSignal, setResetSignal] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const t = overview.data;

  // The sidebar folds to its rail while the board is customised, so the widgets keep their width.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("board-editing", { detail: editing }));
    return () => void window.dispatchEvent(new CustomEvent("board-editing", { detail: false }));
  }, [editing]);
  const needsSetup = t ? !t.accounts.some((a) => a.role === "operating") || t.accounts.every((a) => !a.verified_at) : false;
  const plans = (t?.plans ?? []).filter((p) => p.status === "needs_approval");
  const answer = (disputes.data ?? []).filter(needsAnswer).sort((a, b) => (a.due_date ?? "~").localeCompare(b.due_date ?? "~"));
  const running = (t?.policies ?? []).filter((p) => p.status === "active");
  const next = running.map((p) => p.next_run_at).filter((x): x is string => !!x).sort()[0];
  const hasActivity = !!disputes.data?.length || !!insights.data?.movements.length;

  return (
    <div className="space-y-10">
      {overview.error ? (
        <Card><p className="text-sm text-danger">{overview.error}</p></Card>
      ) : !t ? (
        <Skeleton className="h-44" />
      ) : needsSetup ? (
        <Card>
          <Empty icon="savings" title="Set up your accounts">
            Add the account your business runs on and the jars money is set aside into, and Home shows what&rsquo;s
            actually free to spend.
            <div className="mt-5"><Button variant="primary" href="/money/jars/accounts">Add accounts</Button></div>
          </Empty>
        </Card>
      ) : (
        <BalanceHero
          overview={t}
          actions={<Button variant="ghost" href="/money/jars" className="min-h-9 text-[13px]">Jars <Icon name="chevron_right" className="text-[16px]" /></Button>}
        />
      )}

      {t && disputes.data && (
        <section aria-labelledby="needs-you" className="space-y-4">
          {plans.length + answer.length > 0 ? (
            <>
              <h2 id="needs-you" className="flex items-center gap-2 text-[19px] font-semibold tracking-[-0.015em]">
                <span className="h-2 w-2 animate-pulse rounded-full bg-primary motion-reduce:animate-none" aria-hidden /> Needs you
              </h2>
              <div className="grid gap-4 lg:grid-cols-2">
                {plans.slice(0, 2).map((p, i) => (
                  <Reveal key={p.id} index={i}>
                    <PlanApproval
                      plan={{ plan_id: p.id, plan_hash: p.plan_hash, total: p.total, items: p.items_json, status: p.status, reason: p.reason, expires_at: p.expires_at }}
                      currency={currency}
                      onDone={(said) => {
                        setNotice(said);
                        feedback(said.startsWith("Approved") ? "moved" : "tap");
                        overview.reload();
                      }}
                    />
                  </Reveal>
                ))}
                {answer.slice(0, 4 - Math.min(2, plans.length)).map((d, i) => <Reveal key={d.id} index={plans.length + i}><AnswerCard d={d} /></Reveal>)}
              </div>
              {plans.length > 2 || answer.length > 4 - Math.min(2, plans.length) ? (
                <p className="text-sm">
                  <Link href={answer.length > 2 ? "/money/disputes" : "/money/jars"} className="font-medium text-primary hover:text-ink">See everything that needs you</Link>
                </p>
              ) : null}
            </>
          ) : (
            <p id="needs-you" className="rise flex items-center gap-2 text-[15px] text-ink-2">
              <SuccessTick /> {notice ?? "All clear. Nothing needs you right now."}
            </p>
          )}
        </section>
      )}

      <section aria-labelledby="trends" className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <div className="flex items-center gap-3">
            <h2 id="trends" className="text-[19px] font-semibold tracking-[-0.015em]">Last {days} days</h2>
            <RangePicker value={days} onChange={setDays} />
          </div>
          {/* Building widgets needs a wide screen; phones get the curated board only. */}
          <div className="hidden items-center gap-2 sm:flex">
            {editing && <Button variant="ghost" className="min-h-9 text-[13px]" onClick={() => setResetSignal((n) => n + 1)}>Reset layout</Button>}
            <Button variant={editing ? "primary" : "ghost"} className="min-h-9 text-[13px]" onClick={() => setEditing(!editing)}>
              {editing ? "Done" : <><Icon name="tune" className="text-[16px]" /> Customize</>}
            </Button>
          </div>
        </div>

        {!ready ? (
          <Skeleton className="h-[480px]" />
        ) : !hasActivity ? (
          <Card>
            <Empty icon="insights" title="This fills in as you go">
              After your first transfers or disputes, you&rsquo;ll see what&rsquo;s at stake, what Bundo handled and what was set aside.
              {next && <span className="mt-2 block">Next rule runs {when(next)}.</span>}
            </Empty>
          </Card>
        ) : (
          <Board id="home" data={model} editing={editing} resetSignal={resetSignal} />
        )}
      </section>

      <div className="flex justify-end"><ChatToggle /></div>
    </div>
  );
}

/** A dispute waiting on the merchant: what it is, how much, and how long is left to answer. */
function AnswerCard({ d }: { d: DisputeSummary }) {
  const a = agentState({ status: d.status, draft_status: d.draft_status ?? null, draft_action: d.draft_action ?? null });
  const ready = d.draft_status === "awaiting_approval";
  return (
    <Link href={ready ? `/money/disputes/${d.id}/approve` : `/money/disputes/${d.id}`} className="press group flex h-full flex-col rounded-[18px] bg-card p-5 ring-1 ring-ink/[0.08] transition hover:shadow-lift">
      <span className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-[22px] font-semibold tabular-nums tracking-[-0.02em]">{money(d.amount, d.currency)}</span>
          <span className="mt-1 block truncate text-[13px] text-muted">{d.reason_label ?? "Dispute"}</span>
        </span>
        <Countdown due={d.due_date} />
      </span>
      <span className="mt-auto flex items-center justify-between gap-3 pt-5 text-sm font-semibold text-primary">
        {ready ? "Review Bundo's answer" : a.label}
        <Icon name="chevron_right" className="transition group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}

const RANGES = [7, 30, 90] as const;

function RangePicker({ value, onChange }: { value: number; onChange: (d: (typeof RANGES)[number]) => void }) {
  return (
    <div role="radiogroup" aria-label="Time range" className="flex rounded-full bg-soft p-0.5">
      {RANGES.map((d) => (
        <button
          key={d}
          type="button"
          role="radio"
          aria-checked={value === d}
          onClick={() => onChange(d)}
          className={`min-h-8 rounded-full px-3 text-[13px] font-medium tabular-nums transition motion-reduce:transition-none ${
            value === d ? "bg-card text-ink shadow-card" : "text-muted hover:text-ink"
          }`}
        >
          {d}d
        </button>
      ))}
    </div>
  );
}

/** A Bundo icon beside Open disputes that rolls out into a chat bar; sending opens the Ask Bundo page. */
function ChatToggle() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) input.current?.focus({ preventScroll: true });
  }, [open]);

  // The outer box stretches to the row's height so the bar can animate to 100% of it.
  return (
    <div className="shrink-0">
      <div
        className={`flex flex-col overflow-hidden bg-card shadow-card ring-1 ring-ink/40 transition-all duration-300 ease-out motion-reduce:transition-none ${
          open ? "h-[124px] w-full rounded-[20px] sm:w-[340px]" : "h-12 w-12 rounded-[24px]"
        }`}
      >
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-label={open ? "Close chat" : "Ask Bundo"}
          className="flex h-12 shrink-0 items-center gap-2.5 px-3 text-ink"
        >
          {/* shrink-0: the icon clips its overflow, so without it the hidden label squeezes it to nothing. */}
          <Icon name="forum" className="shrink-0 text-[24px]" />
          <span className={`shrink-0 whitespace-nowrap text-[15px] font-semibold transition-opacity duration-200 motion-reduce:transition-none ${open ? "opacity-100 delay-150" : "opacity-0"}`}>Bundo</span>
        </button>
        <form
          inert={!open}
          className={`mt-auto flex min-w-[280px] items-center gap-2 p-3 transition-opacity duration-200 motion-reduce:transition-none ${open ? "opacity-100 delay-150" : "opacity-0"}`}
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) router.push(`/agent?q=${encodeURIComponent(q.trim())}`);
          }}
        >
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Message Bundo"
            aria-label="Message Bundo"
            className="min-h-11 min-w-0 flex-1 rounded-full bg-card px-4 text-sm text-ink ring-1 ring-inset ring-ink/40 placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <SendButton disabled={!q.trim()} />
        </form>
      </div>
    </div>
  );
}
