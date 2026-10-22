"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { DisputeTable, unresolvedCount } from "@/components/DisputeTable";
import { Button, Card, CardTitle, Empty, Icon, Pill } from "@/components/ui";
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

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <Card className="lg:col-span-8">
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

        <AskCard />
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

function AskCard() {
  const router = useRouter();
  const [q, setQ] = useState("");
  return (
    <Card className="flex flex-col bg-ink text-white shadow-lift lg:col-span-4">
      <h2 className="flex items-center gap-2.5 text-[19px] font-semibold tracking-[-0.015em]">
        <Icon name="forum" />
        Ask Bundo
      </h2>
      <p className="mb-5 mt-2 text-sm leading-relaxed text-white/70">Ask about a case, or tell it what to refund. You approve before money moves.</p>
      <form
        className="mt-auto flex gap-2 rounded-full bg-white/10 p-1.5 ring-1 ring-inset ring-white/15 focus-within:ring-aqua"
        onSubmit={(e) => {
          e.preventDefault();
          router.push(`/agent${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`);
        }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="e.g. Refund anything under $20"
          aria-label="Question for Bundo"
          className="min-w-0 flex-1 bg-transparent px-3 text-sm text-white placeholder:text-white/55 focus:outline-none"
        />
        <button className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-aqua text-ink hover:bg-ice" aria-label="Ask">
          <Icon name="arrow_upward" className="text-[18px]" />
        </button>
      </form>
    </Card>
  );
}
