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
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi tone="bg-cream text-ink border border-cream-line" icon="pending_actions" label="Need your response" value={o?.needs_response ?? "–"} note={o ? `${money(o.at_stake, cur)} at stake` : ""} />
        <Kpi tone="bg-plum text-white" icon="approval" label="Waiting for your OK" value={waiting} note="Drafts ready to approve" />
        <Kpi tone="bg-coral text-white" icon="currency_exchange" label="Refunded" value={o ? money(o.refunded, cur) : "–"} note={o ? `${o.refund_count} refunds · ${o.auto_count} automatic` : ""} />
        <Kpi tone="bg-steel text-white" icon="schedule" label="Due within 48h" value={o?.due_soon ?? "–"} note={o ? `${o.resolved} closed so far` : ""} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        <Card className="lg:col-span-8">
          <CardTitle action={<Button variant="ghost" href="/disputes" className="text-xs">All disputes <Icon name="chevron_right" className="text-[16px]" /></Button>}>
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

        <div className="space-y-5 lg:col-span-4">
          <AskCard />
          <Card>
            <CardTitle action={<Button variant="ghost" href="/settings#agent" className="text-xs">Change</Button>}>Refund limit</CardTitle>
            {rules && (
              <div className="flex items-center gap-3">
                <span className={`grid h-10 w-10 place-items-center rounded-xl ${rules.auto_refund_enabled ? "bg-primary-fixed text-primary" : "bg-soft text-muted"}`}>
                  <Icon name={rules.auto_refund_enabled ? "bolt" : "front_hand"} />
                </span>
                <div className="text-sm">
                  {rules.auto_refund_enabled ? (
                    <>Agent refunds up to <b className="font-mono">{money(rules.auto_refund_limit, cur)}</b> on its own.</>
                  ) : (
                    <>Agent asks you before every refund.</>
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
              <ul className="divide-y divide-line">
                {o.activity.slice(0, 6).map((a, i) => (
                  <li key={i} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <div className="min-w-0">
                      {a.dispute_id ? (
                        <Link href={`/disputes/${a.dispute_id}`} className="block truncate font-medium hover:underline">{a.label}</Link>
                      ) : (
                        <span className="block truncate font-medium">{a.label}</span>
                      )}
                      <span className="font-mono text-[11px] text-muted">{new Date(a.at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}</span>
                    </div>
                    {a.amount && <span className="shrink-0 font-mono text-xs font-semibold">{money(a.amount, a.currency)}</span>}
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

function Kpi({ tone, icon, label, value, note }: { tone: string; icon: string; label: string; value: React.ReactNode; note: string }) {
  return (
    <div className={`flex min-h-[116px] flex-col justify-between rounded-2xl p-5 shadow-sm ${tone}`}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold opacity-95">{label}</span>
        <Icon name={icon} className="opacity-80" />
      </div>
      <div className="mt-3">
        <div className="font-mono text-3xl font-bold tracking-tight tabular-nums">{value}</div>
        <div className="mt-1 text-xs opacity-80">{note}</div>
      </div>
    </div>
  );
}

function AskCard() {
  const router = useRouter();
  const [q, setQ] = useState("");
  return (
    <Card className="bg-ink text-white border-ink">
      <div className="flex items-center gap-2">
        <Icon name="forum" />
        <span className="font-semibold">Ask the agent</span>
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          router.push(`/agent${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`);
        }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="e.g. Refund anything under $20"
          className="min-w-0 flex-1 rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-sm text-white placeholder:text-white/50 focus:outline-none focus:ring-2 focus:ring-primary-fixed"
        />
        <button className="rounded-lg bg-white px-3 text-sm font-semibold text-ink hover:bg-primary-fixed" aria-label="Ask">
          <Icon name="arrow_upward" className="text-[18px]" />
        </button>
      </form>
    </Card>
  );
}
