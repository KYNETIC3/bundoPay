"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { DisputeTable } from "@/components/DisputeTable";
import { Button, Card, CardTitle, Empty, Icon } from "@/components/ui";
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
  activity: { label: string; event: string; at: string; dispute_id: string | null; reason: string | null; amount: string | null; currency: string | null }[];
};
type AgentSettings = { auto_refund_enabled: boolean; auto_refund_limit: string };

export default function OverviewPage() {
  const { data: o } = useLive<Overview>("/overview");
  const { data: disputes, error: disputesError } = useLive<DisputeSummary[]>("/disputes");
  const { data: rules } = useLive<AgentSettings>("/agent/settings", 120_000);
  const open = (disputes ?? []).filter((d) => d.status !== "RESOLVED");
  const waiting = open.filter((d) => d.draft_status === "awaiting_approval").length;
  const cur = o?.currency ?? "USD";

  return (
    <>
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi swatch="bg-ink" label="Need your response" value={o?.needs_response ?? "–"} note={o ? `${money(o.at_stake, cur)} at stake` : ""} />
        <Kpi swatch="bg-primary" label="Waiting for your OK" value={waiting} note="Drafts ready to approve" />
        <Kpi swatch="bg-aqua" label="Refunded" value={o ? money(o.refunded, cur) : "–"} note={o ? `${o.refund_count} refunds, ${o.auto_count} of them automatic` : ""} />
        <Kpi swatch="bg-muted" label="Due within 48h" value={o?.due_soon ?? "–"} note={o ? `${o.resolved} closed so far` : ""} />
      </div>

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
        <Card className="lg:col-span-8">
          <CardTitle action={<Button variant="ghost" href="/disputes" className="min-h-8 text-[13px]">All disputes <Icon name="chevron_right" className="text-[16px]" /></Button>}>
            Open disputes
          </CardTitle>
          {disputes === null ? (
            disputesError ? <p className="text-sm text-danger">{disputesError}</p> : null
          ) : open.length === 0 ? (
            <Empty icon="task_alt" title="Nothing needs you right now">New disputes from PayPal show up here automatically.</Empty>
          ) : (
            <DisputeTable items={open.slice(0, 6)} />
          )}
        </Card>

        <div className="space-y-6 lg:col-span-4">
          <AskCard />
          <Card>
            <CardTitle action={<Button variant="ghost" href="/settings#agent" className="min-h-8 text-[13px]">Change</Button>}>Refund limit</CardTitle>
            {rules && (
              <div className="flex items-center gap-4">
                <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-[14px] ${rules.auto_refund_enabled ? "bg-primary-fixed text-primary" : "bg-soft text-muted"}`}>
                  <Icon name={rules.auto_refund_enabled ? "bolt" : "front_hand"} />
                </span>
                <div className="text-sm leading-relaxed text-ink-2">
                  {rules.auto_refund_enabled ? (
                    <>The agent refunds up to <b className="font-semibold text-ink tabular-nums">{money(rules.auto_refund_limit, cur)}</b> on its own. Anything above waits for you.</>
                  ) : (
                    <>The agent asks you before every refund.</>
                  )}
                </div>
              </div>
            )}
          </Card>
          <Card>
            <CardTitle>Agent activity</CardTitle>
            {!o?.activity.length ? (
              <p className="text-sm text-muted">No activity yet.</p>
            ) : (
              <ul className="divide-y divide-ink/[0.06]">
                {o.activity.slice(0, 6).map((a, i) => (
                  <li key={i} className="flex items-center justify-between gap-4 py-3.5 text-sm first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      {a.dispute_id ? (
                        <Link href={`/disputes/${a.dispute_id}`} className="block truncate font-semibold text-ink hover:text-primary">{a.label}</Link>
                      ) : (
                        <span className="block truncate font-semibold">{a.label}</span>
                      )}
                      <span className="mt-1 block text-xs text-muted">{new Date(a.at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}</span>
                    </div>
                    {a.amount && <span className="shrink-0 text-[13px] font-semibold tabular-nums">{money(a.amount, a.currency)}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
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
    <Card className="bg-ink text-white shadow-lift">
      <h2 className="flex items-center gap-2.5 text-[19px] font-semibold tracking-[-0.015em]">
        <Icon name="forum" />
        Ask the agent
      </h2>
      <p className="mb-5 mt-2 text-sm leading-relaxed text-white/70">Ask about a case, or tell it what to refund. You approve before money moves.</p>
      <form
        className="flex gap-2 rounded-full bg-white/10 p-1.5 ring-1 ring-inset ring-white/15 focus-within:ring-aqua"
        onSubmit={(e) => {
          e.preventDefault();
          router.push(`/agent${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`);
        }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="e.g. Refund anything under $20"
          aria-label="Question for the agent"
          className="min-w-0 flex-1 bg-transparent px-3 text-sm text-white placeholder:text-white/55 focus:outline-none"
        />
        <button className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-aqua text-ink hover:bg-ice" aria-label="Ask">
          <Icon name="arrow_upward" className="text-[18px]" />
        </button>
      </form>
    </Card>
  );
}
