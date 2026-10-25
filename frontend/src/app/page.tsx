"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { MoneyBreakdown } from "@/components/treasury";
import { Button, Card, Empty, Icon, SendButton } from "@/components/ui";
import { when } from "@/lib/format";
import { useLive } from "@/lib/hooks";
import type { Insights, Overview as Treasury } from "@/lib/treasury";
import type { DisputeSummary } from "@/lib/types";

// AG Studio measures the page and uses localStorage, so it only ever renders in the browser.
const InsightsBoard = dynamic(() => import("@/components/InsightsBoard"), { ssr: false, loading: () => <BoardSkeleton /> });

export default function InsightsPage() {
  const { data: t, error: treasuryError } = useLive<Treasury>("/treasury/overview", 15_000);
  const { data: disputes } = useLive<DisputeSummary[]>("/disputes");
  const { data: insights } = useLive<Insights>("/treasury/insights?days=90", 60_000);
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [editing, setEditing] = useState(false);
  const [resetSignal, setResetSignal] = useState(0);
  const open = (disputes ?? []).filter((d) => d.status !== "RESOLVED");
  const disputesWaiting = open.filter((d) => (d.status === "WAITING_FOR_SELLER_RESPONSE" && d.draft_status !== "submitted") || d.draft_status === "awaiting_approval").length;
  const transfersWaiting = (t?.plans ?? []).filter((p) => p.status === "needs_approval").length;
  const currency = t?.limits.currency ?? open.find((d) => d.currency)?.currency ?? "USD";
  const needsSetup = t ? !t.accounts.some((a) => a.role === "operating") || t.accounts.every((a) => !a.verified_at) : false;
  const running = (t?.policies ?? []).filter((p) => p.status === "active");
  const next = running.map((p) => p.next_run_at).filter((x): x is string => !!x).sort()[0];
  const hasActivity = !!disputes?.length || !!insights?.movements.length;

  return (
    <div className="space-y-10">
      {treasuryError ? (
        <Card><p className="text-sm text-danger">{treasuryError}</p></Card>
      ) : !t ? (
        <Card><p className="text-sm text-muted">Loading your balance…</p></Card>
      ) : needsSetup ? (
        <Card>
          <Empty icon="account_balance" title="Set up your treasury accounts">
            Add the account your business runs on and the reserves money is set aside into, and this page splits your
            balance by what it&rsquo;s for.
            <div className="mt-5"><Button variant="primary" href="/treasury/setup">Add accounts</Button></div>
          </Empty>
        </Card>
      ) : (
        <MoneyBreakdown
          positions={t.positions}
          floor={t.limits.liquidity_floor}
          currency={currency}
          actions={<Button variant="ghost" href="/treasury" className="min-h-9 text-[13px]">Treasury <Icon name="chevron_right" className="text-[16px]" /></Button>}
        />
      )}

      {t && disputes && (transfersWaiting + disputesWaiting > 0 ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[19px] font-semibold tracking-[-0.015em]">
          <span className="h-2 w-2 rounded-full bg-primary" aria-hidden />
          Needs you:
          {transfersWaiting > 0 && <Link href="/treasury" className="text-primary underline-offset-4 hover:underline">{transfersWaiting} {transfersWaiting === 1 ? "transfer" : "transfers"} to OK</Link>}
          {transfersWaiting > 0 && disputesWaiting > 0 && <span className="text-muted">·</span>}
          {disputesWaiting > 0 && <Link href="/disputes" className="text-primary underline-offset-4 hover:underline">{disputesWaiting} {disputesWaiting === 1 ? "dispute" : "disputes"} to answer</Link>}
        </p>
      ) : (
        <p className="flex items-center gap-2 text-[15px] text-muted">
          <Icon name="check_circle" className="text-primary" /> Nothing needs you right now.
        </p>
      ))}

      <section aria-labelledby="trends" className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <div className="flex items-center gap-3">
            <h2 id="trends" className="text-[19px] font-semibold tracking-[-0.015em]">Last {days} days</h2>
            <RangePicker value={days} onChange={setDays} />
          </div>
          <div className="flex items-center gap-2">
            {editing && (
              <Button variant="ghost" className="min-h-9 text-[13px]" onClick={() => setResetSignal((n) => n + 1)}>Reset layout</Button>
            )}
            {/* Building widgets needs a wide screen; phones get the curated board only. */}
            <span className="hidden sm:contents">
              <Button variant={editing ? "primary" : "ghost"} className="min-h-9 text-[13px]" onClick={() => setEditing(!editing)}>
                {editing ? "Done" : <><Icon name="tune" className="text-[16px]" /> Customize</>}
              </Button>
            </span>
          </div>
        </div>

        {!insights || !disputes ? (
          <BoardSkeleton />
        ) : !hasActivity ? (
          <Card>
            <Empty icon="insights" title="Insights fill in as you go">
              After your first transfers or disputes, you&rsquo;ll see what&rsquo;s at stake, what Bundo handled and what was set aside.
              {next && <span className="mt-2 block">Next policy run {when(next)}.</span>}
            </Empty>
          </Card>
        ) : (
          <InsightsBoard currency={currency} disputes={disputes} insights={insights} days={days} editing={editing} resetSignal={resetSignal} />
        )}
      </section>

      <div className="flex justify-end"><ChatToggle /></div>
    </div>
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

/** Same footprint as the board, so nothing jumps when AG Studio loads. */
function BoardSkeleton() {
  return (
    <div aria-hidden className="grid h-[480px] grid-cols-2 grid-rows-[144px_1fr] gap-4 sm:grid-cols-4">
      {[0, 1, 2, 3].map((i) => <div key={i} className="animate-pulse rounded-[20px] bg-card motion-reduce:animate-none" />)}
      <div className="col-span-2 animate-pulse rounded-[20px] bg-card motion-reduce:animate-none sm:col-span-4" />
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
