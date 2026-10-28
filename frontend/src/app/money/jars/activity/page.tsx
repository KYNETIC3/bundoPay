"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { Menu } from "@/components/overlay";
import { Card, Details, Empty, Fact, Icon, Pill, type Tone } from "@/components/ui";
import { api } from "@/lib/api";
import { ago, clock, dateTime, money } from "@/lib/format";
import { useLive } from "@/lib/hooks";
import { type FeedEntry, type Overview, type Said, describeEntry, downloadStatement, flowFacts, flowTitle, reference } from "@/lib/treasury";

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
        <Menu items={[{ icon: "download", label: "Download statement (CSV)", onSelect: () => overview.data && downloadStatement(overview.data.movements) }]} />
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
