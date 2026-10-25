"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { MoneyBreakdown } from "@/components/treasury";
import { Button, Card, Empty, Icon, SendButton } from "@/components/ui";
import { money, when } from "@/lib/format";
import { useLive } from "@/lib/hooks";
import type { Overview as Treasury } from "@/lib/treasury";
import type { DisputeSummary } from "@/lib/types";

type Overview = {
  needs_response: number;
  at_stake: string;
  due_soon: number;
  resolved: number;
  currency: string | null;
  refunded: string;
  refund_count: number;
  auto_count: number;
};

export default function OverviewPage() {
  const { data: t, error: treasuryError } = useLive<Treasury>("/treasury/overview", 15_000);
  const { data: o } = useLive<Overview>("/overview");
  const { data: disputes } = useLive<DisputeSummary[]>("/disputes");
  const open = (disputes ?? []).filter((d) => d.status !== "RESOLVED");
  const disputesWaiting = open.filter((d) => (d.status === "WAITING_FOR_SELLER_RESPONSE" && d.draft_status !== "submitted") || d.draft_status === "awaiting_approval").length;
  const transfersWaiting = (t?.plans ?? []).filter((p) => p.status === "needs_approval").length;
  const currency = t?.limits.currency ?? o?.currency ?? "USD";
  const needsSetup = t ? !t.accounts.some((a) => a.role === "operating") || t.accounts.every((a) => !a.verified_at) : false;
  const running = (t?.policies ?? []).filter((p) => p.status === "active");
  const next = running.map((p) => p.next_run_at).filter((x): x is string => !!x).sort()[0];

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

      <div className="flex flex-col gap-6 lg:flex-row">
        <div className="grid min-w-0 flex-1 gap-6 sm:grid-cols-2">
          <SummaryCard href="/disputes" icon="gavel" title={disputes ? `${open.length} open ${open.length === 1 ? "dispute" : "disputes"}` : "Disputes"}>
            {o ? `${money(o.at_stake, o.currency ?? currency)} at stake, ${o.due_soon} due within 48h` : ""}
          </SummaryCard>
          <SummaryCard href="/treasury/policies" icon="rule" title={t ? (running.length === 0 ? "No policies running" : `${running.length} ${running.length === 1 ? "policy" : "policies"} running`) : "Policies"}>
            {t ? (next ? `Next run ${when(next)}` : t.policies.length ? "Open Policies to turn one on." : "Add a policy to start setting money aside.") : ""}
          </SummaryCard>
        </div>

        <ChatToggle />
      </div>
    </div>
  );
}

function SummaryCard({ href, icon, title, children }: { href: string; icon: string; title: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="group rounded-[20px] bg-card p-7 shadow-card transition hover:shadow-lift">
      <div className="flex items-center justify-between">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary-fixed text-primary"><Icon name={icon} /></span>
        <Icon name="chevron_right" className="text-muted transition group-hover:translate-x-0.5 group-hover:text-ink" />
      </div>
      <p className="mt-5 text-[19px] font-semibold tracking-[-0.015em]">{title}</p>
      <p className="mt-1 text-sm text-muted">{children}</p>
    </Link>
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
          open ? "h-[124px] w-full rounded-[20px] lg:h-full lg:w-[340px]" : "h-12 w-12 rounded-[24px]"
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
