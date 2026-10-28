"use client";

import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";

import { DataGrid } from "@/components/DataGrid";
import { Card, CardTitle, Details, Empty, Fact, Icon, Pill, type Tone } from "@/components/ui";
import { api } from "@/lib/api";
import { ago, clock, dateTime, money } from "@/lib/format";
import { useLive } from "@/lib/hooks";
import {
  CHECK_LABELS, type FeedEntry, type Insights, type Movement, type Overview, ROLE_LABELS, type Said, describeEntry, flowFacts, flowTitle, movementStatus, reference,
} from "@/lib/treasury";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Flow = { flow_id: string; started: string; entries: number; policy: string | null; started_by: string | null; total: string | null; outcome: string };
type Timeline = { flow_id: string; outcome: string; entries: FeedEntry[] };
type Verify = { ok: boolean };

const OUTCOME_TONE = (o: string): Tone =>
  o.startsWith("Blocked") || o.startsWith("PayPal rejected") ? "danger"
  : o.startsWith("Confirmed") || o.startsWith("Sent") || o.startsWith("Allowed") || o.startsWith("Approved") ? "cerulean"
  : o.startsWith("Waiting") ? "plum"
  : "soft";

// The server's outcome words, shortened for a list.
const OUTCOME_WORDS: Record<string, string> = {
  "Blocked by the safety engine": "Stopped",
  "PayPal rejected it": "Turned down",
  "Waiting for your approval": "Needs your OK",
  "Copilot drafted": "Drafted",
};

const DOT: Record<Said["tone"], string> = { good: "bg-primary", wait: "bg-aqua", stop: "bg-danger", quiet: "bg-ink/25" };

/** One ledger line: a movement, with who started it from its flow. */
type Line = {
  id: string;
  when: string;
  jar: string;
  amount: number;
  currency: string;
  outcome: { label: string; tone: Tone; icon: string };
  startedBy: string;
  checkedBy: string;
  reference: string;
};

function outcomeOf(m: Pick<Movement, "status" | "verdict"> & { check_code?: string | null }): Line["outcome"] {
  if (m.verdict === "block" || m.status === "blocked") return { label: `Stopped: ${CHECK_LABELS[m.check_code ?? ""] ?? "safety check"}`, tone: "danger", icon: "block" };
  if (m.status === "failed") return { label: "Failed", tone: "danger", icon: "error" };
  if (m.status === "needs_approval" || m.verdict === "ask") return { label: movementStatus(m as Movement), tone: "plum", icon: "hourglass_top" };
  if (m.status === "succeeded" || m.status === "confirmed") return { label: "Completed", tone: "cerulean", icon: "check_circle" };
  return { label: movementStatus(m as Movement), tone: "soft", icon: "schedule" };
}

const LEDGER_COLUMNS: ColDef<Line>[] = [
  { headerName: "When", field: "when", sort: "desc", width: 170, valueFormatter: (p) => (p.value ? dateTime(p.value) : "") },
  { headerName: "Jar", field: "jar", flex: 1, minWidth: 120 },
  { headerName: "Amount", field: "amount", type: "rightAligned", width: 120, valueFormatter: (p) => (p.data ? money(String(p.value), p.data.currency) : ""), cellClass: "flex items-center justify-end tabular-nums font-semibold" },
  {
    headerName: "Outcome",
    colId: "outcome",
    valueGetter: (p) => p.data?.outcome.label ?? "",
    flex: 1.4,
    minWidth: 200,
    cellRenderer: ({ data }: ICellRendererParams<Line>) => data && <Pill tone={data.outcome.tone}><Icon name={data.outcome.icon} className="text-[14px]" />{data.outcome.label}</Pill>,
  },
  { headerName: "Who started it", field: "startedBy", flex: 1, minWidth: 150 },
  { headerName: "Checked by", field: "checkedBy", flex: 1, minWidth: 160 },
  { headerName: "Reference", field: "reference", width: 120 },
];

function LedgerCard({ l }: { l: Line }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate font-semibold">{l.jar}</span>
        <span className="shrink-0 font-semibold tabular-nums">{money(String(l.amount), l.currency)}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Pill tone={l.outcome.tone}><Icon name={l.outcome.icon} className="text-[14px]" />{l.outcome.label}</Pill>
        <span className="text-[13px] text-muted">{dateTime(l.when)} · {l.startedBy}</span>
      </div>
    </div>
  );
}

/** Every movement in the last 90 days as one sortable ledger. The newest have full detail from the overview;
 * older ones come from insights, which has no cap. */
function useLedger(flows: Flow[] | undefined, overview: Overview | null) {
  const insights = useLive<Insights>("/treasury/insights?days=90", 60_000);
  return useMemo(() => {
    const byFlow = new Map((flows ?? []).map((f) => [f.flow_id, f]));
    const recent = overview?.movements ?? [];
    const seen = new Set(recent.map((m) => m.id));
    const older = (insights.data?.movements ?? []).filter((m) => !seen.has(m.id));
    const lines: Line[] = [...recent, ...older].map((m) => {
      const full = m as Partial<Movement> & typeof m;
      const flow = full.flow_id ? byFlow.get(full.flow_id) : undefined;
      const confirmed = !!full.paypal_ref || m.status === "succeeded" || m.status === "confirmed";
      return {
        id: m.id,
        when: m.created_at,
        jar: full.account_name ?? (m.role ? ROLE_LABELS[m.role] : "Other"),
        amount: Number(m.amount),
        currency: m.currency,
        outcome: outcomeOf(full),
        startedBy: flow ? flowTitle(flow.policy, flow.started_by) : m.kind === "refund" ? "Dispute refund" : "Jars rule",
        checkedBy: confirmed ? "Safety checks, then PayPal" : "Safety checks",
        reference: reference(full.flow_id),
      };
    });
    return lines;
  }, [flows, overview, insights.data]);
}

// Checking the record chain writes an entry of its own, so do it at most once every ten minutes per tab.
let lastCheck: { at: number; result: Verify } | null = null;

function ActivityView() {
  const params = useSearchParams();
  const { data } = useLive<{ flows: Flow[] }>("/treasury/history", 30_000);
  const overview = useLive<Overview>("/treasury/overview", 60_000);
  const asked = params.get("flow");
  const [selected, setSelected] = useState<string | null>(asked && UUID.test(asked) ? asked : null);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [check, setCheck] = useState<Verify | null>(lastCheck?.result ?? null);
  const [error, setError] = useState<string | null>(null);
  const currency = overview.data?.limits.currency ?? "USD";

  useEffect(() => {
    if (lastCheck && Date.now() - lastCheck.at < 600_000) return;
    api<Verify>("/treasury/history/verify", { method: "POST" })
      .then((r) => {
        lastCheck = { at: Date.now(), result: r };
        setCheck(r);
      })
      .catch(() => {});
  }, []);

  const flowId = selected ?? data?.flows[0]?.flow_id ?? null;
  useEffect(() => {
    if (!flowId) return;
    api<Timeline>(`/treasury/history/${flowId}`).then(setTimeline).catch((e) => setError((e as Error).message));
  }, [flowId]);
  const flow = data?.flows.find((f) => f.flow_id === flowId);
  const ledger = useLedger(data?.flows, overview.data);
  const steps = (timeline?.entries ?? []).map((e) => ({ e, said: describeEntry(e, currency) })).filter((x): x is { e: FeedEntry; said: Said } => !!x.said);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        {check && !check.ok ? (
          <p className="flex items-center gap-2 rounded-2xl bg-danger-soft px-4 py-3 text-sm font-medium text-danger" role="alert">
            <Icon name="gpp_bad" /> Something in your records doesn&rsquo;t match what was written. Contact BundoPay support before relying on it.
          </p>
        ) : (
          <p className="flex items-center gap-2 text-[15px] text-muted">
            <Icon name="verified_user" className="text-primary" />
            {check ? "Your records are intact. Nothing has been changed after the fact." : "Checking your records…"}
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <Card className="lg:self-start">
          {!data ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : data.flows.length === 0 ? (
            <Empty icon="history" title="Nothing yet">Every run, approval and Copilot request will show here.</Empty>
          ) : (
            <ul className="-mx-3 space-y-0.5" aria-label="Activity">
              {data.flows.map((f) => {
                const on = f.flow_id === flowId;
                return (
                  <li key={f.flow_id}>
                    <button
                      onClick={() => setSelected(f.flow_id)}
                      aria-current={on ? "true" : undefined}
                      className={`w-full rounded-2xl px-3 py-3 text-left transition ${on ? "bg-primary-fixed/70" : "hover:bg-soft"}`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="truncate text-[15px] font-semibold">{flowTitle(f.policy, f.started_by)}</span>
                        {f.total && <span className="shrink-0 text-[15px] font-medium tabular-nums">{money(f.total, currency)}</span>}
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-3">
                        <span className="text-[13px] text-muted">{ago(f.started)}</span>
                        <Pill tone={OUTCOME_TONE(f.outcome)}>{OUTCOME_WORDS[f.outcome] ?? f.outcome}</Pill>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card className="lg:sticky lg:top-10 lg:self-start">
          {error ? (
            <p className="text-sm text-danger">{error}</p>
          ) : !timeline || !flow ? (
            <p className="text-sm text-muted">{data?.flows.length ? "Loading…" : "Pick something on the left to see what happened."}</p>
          ) : (
            <>
              <h2 className="text-[19px] font-semibold tracking-[-0.015em]">{flowTitle(flow.policy, flow.started_by)}</h2>
              <p className="mt-1 text-sm text-muted">{dateTime(flow.started)}</p>
              <ol className="mt-6 space-y-5">
                {steps.map(({ e, said }, i) => (
                  <li key={e.id} className="relative flex gap-4">
                    {i < steps.length - 1 && <span className="absolute left-[4px] top-4 h-[calc(100%+8px)] w-px bg-ink/[0.1]" aria-hidden />}
                    <span className={`relative mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${DOT[said.tone]}`} aria-hidden />
                    <div className="min-w-0">
                      <p className="text-sm leading-snug">{said.text}</p>
                      <p className="mt-0.5 text-xs text-muted">
                        {clock(e.created_at)}
                        {e.label === "provider_verified" ? ", confirmed by PayPal" : e.label === "ai_assessment" ? ", Copilot's reading" : ""}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
              <Details className="mt-7 border-t border-ink/[0.06] pt-4">
                <dl className="divide-y divide-ink/[0.05]">
                  <Fact label="Reference">{reference(flow.flow_id)}</Fact>
                  {flowFacts(timeline.entries, currency).map(([k, v]) => <Fact key={k} label={k}>{v}</Fact>)}
                </dl>
              </Details>
            </>
          )}
        </Card>
      </div>

      <Card>
        <CardTitle>Ledger</CardTitle>
        <DataGrid
          label="Your ledger"
          rows={ledger}
          columns={LEDGER_COLUMNS}
          getRowId={(l) => l.id}
          card={(l) => <LedgerCard l={l} />}
          csvName="jars-ledger"
          empty={<Empty icon="receipt_long" title="No money has moved yet">Transfers between your jars show here once a rule runs.</Empty>}
        />
      </Card>
    </div>
  );
}

export default function ActivityPage() {
  return (
    <Suspense>
      <ActivityView />
    </Suspense>
  );
}
