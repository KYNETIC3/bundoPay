"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { DisputeTable, unresolvedCount } from "@/components/DisputeTable";
import { Button, Card, CardTitle, Empty, Icon, Pill, SendButton } from "@/components/ui";
import { money } from "@/lib/format";
import { useLive } from "@/lib/hooks";
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
  const { data: o } = useLive<Overview>("/overview");
  const { data: disputes, error: disputesError } = useLive<DisputeSummary[]>("/disputes");
  const open = (disputes ?? []).filter((d) => d.status !== "RESOLVED");
  const waiting = open.filter((d) => d.draft_status === "awaiting_approval").length;
  const needsAction = open.filter((d) => d.status === "WAITING_FOR_SELLER_RESPONSE" || d.draft_status === "awaiting_approval").length;
  const cur = o?.currency ?? "USD";

  return (
    <>
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
        <Kpi swatch="bg-ink" label="Needs you" value={disputes ? needsAction : "–"} note={o ? `${waiting} ready to approve, ${money(o.at_stake, cur)} at stake` : ""} />
        <Kpi swatch="bg-aqua" label="Refunded" value={o ? money(o.refunded, cur) : "–"} note={o ? `${o.refund_count} refunds, ${o.auto_count} of them automatic` : ""} />
        <Kpi swatch="bg-muted" label="Due within 48h" value={o?.due_soon ?? "–"} note={o ? `${o.resolved} closed so far` : ""} />
      </div>

      <div className="flex flex-col gap-6 lg:flex-row">
        <Card className="min-w-0 flex-1">
          <CardTitle action={<Button variant="ghost" href="/disputes" className="min-h-8 text-[13px]">All disputes <Icon name="chevron_right" className="text-[16px]" /></Button>}>
            <span className="flex items-center gap-2">
              Open disputes
              {disputes && <Pill tone={open.length ? "coral" : "soft"}>{unresolvedCount(disputes)} unresolved</Pill>}
            </span>
          </CardTitle>
          {disputes === null ? (
            disputesError ? <p className="text-sm text-danger">{disputesError}</p> : null
          ) : open.length === 0 ? (
            <Empty icon="task_alt" title="Nothing needs you right now">New disputes from PayPal show up here automatically.</Empty>
          ) : (
            <DisputeTable items={open.slice(0, 6)} />
          )}
        </Card>

        <ChatToggle />
      </div>
    </>
  );
}

function Kpi({ swatch, label, value, note }: { swatch: string; label: string; value: React.ReactNode; note: string }) {
  return (
    <div className="flex flex-col gap-5 rounded-[20px] bg-card px-7 py-6 shadow-card">
      <div className="flex items-center gap-2.5 text-sm font-medium text-ink-2">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-[3px] ${swatch}`} />
        {label}
      </div>
      <div>
        <div className="text-[40px] font-semibold leading-none tracking-[-0.03em] tabular-nums">{value}</div>
        <div className="mt-2 text-[13px] text-muted">{note}</div>
      </div>
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
