"use client";

import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";

import { Button, Card, CardTitle, Empty, Icon, Pill, type Tone } from "@/components/ui";
import { api } from "@/lib/api";
import { dateTime, money } from "@/lib/format";
import { useLive } from "@/lib/hooks";
import { CHECK_LABELS, LABEL_COPY, type FeedEntry } from "@/lib/treasury";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Flow = {
  flow_id: string;
  started: string;
  ended: string;
  entries: number;
  events: string[];
  policy: string | null;
  started_by: string | null;
  total: string | null;
  outcome: string;
};
type Entry = FeedEntry & { prev_hash: string | null; row_hash: string | null };
type Timeline = { flow_id: string; outcome: string; entries: Entry[] };
type Verify = { ok: boolean; entries: number; broken_at: number | null; reason: string | null };

const LABEL_TONE: Record<FeedEntry["label"], Tone> = {
  provider_verified: "cerulean",
  system_generated: "soft",
  ai_assessment: "cream",
  user_uploaded: "plum",
};

const OUTCOME_TONE = (o: string): Tone =>
  o.startsWith("Blocked") || o.startsWith("PayPal rejected") ? "danger"
  : o.startsWith("Confirmed") || o.startsWith("Sent") || o.startsWith("Allowed") ? "cerulean"
  : o.startsWith("Waiting") ? "plum"
  : "soft";

// What each step means, said plainly. Unknown events fall back to their name.
const STEP: Record<string, string> = {
  "trigger.verified": "Trigger verified",
  "trigger.unverified": "Trigger not verified",
  "plan.proposed": "Planner proposed",
  "plan.rebalanced": "Re-planned to fit the floor",
  "plan.skipped": "Nothing to move",
  "safety.allow": "Safety engine: allow",
  "safety.ask": "Safety engine: ask the owner",
  "safety.block": "Safety engine: block",
  "approval.granted": "Owner approved",
  "approval.declined": "Owner declined",
  "execution.submitted": "Sent to PayPal Payouts",
  "execution.accepted": "PayPal accepted the batch",
  "execution.confirmed": "PayPal confirmed the payout",
  "execution.failed": "PayPal rejected the payout",
  "execution.unconfirmed": "PayPal didn't answer; will check before any retry",
  "execution.item_failed": "A payout item failed",
  "execution.refused": "Refused at send time",
  "copilot.interpreted": "Copilot read your request",
};

function detail(e: Entry): string {
  const d = e.data_json as Record<string, unknown>;
  const s = (k: string) => (d[k] == null ? "" : String(d[k]));
  if (e.event.startsWith("safety.")) {
    const base = `${CHECK_LABELS[s("check")] ?? s("check")}. ${s("reason")}.`;
    return e.event === "safety.allow" ? `${base} Handed to the executor.` : `${base} Nothing moved.`;
  }
  if (e.event.startsWith("plan.") && Array.isArray(d.items)) {
    return (d.items as { role: string; amount: string }[]).map((i) => `$${i.amount} → ${i.role.replace("_", " ")}`).join(" + ");
  }
  if (e.event === "approval.granted") return `Token ${s("token")}, bound to plan hash ${s("payload_hash").slice(0, 12)}…`;
  if (e.event.startsWith("execution.")) return [s("payout_batch") && `Batch ${s("payout_batch")}`, s("status"), s("error"), s("request_id") && `Request ${s("request_id").slice(0, 18)}…`].filter(Boolean).join(" · ");
  if (e.event.startsWith("trigger.")) return [s("policy"), s("slot")].filter(Boolean).join(" · ");
  if (e.event === "copilot.interpreted") return `${s("intent")} · ${s("summary")}`;
  return "";
}

function HistoryView() {
  const params = useSearchParams();
  const { data } = useLive<{ flows: Flow[] }>("/treasury/history", 30_000);
  const asked = params.get("flow");
  // Only a full flow id is a link to a flow; anything else just opens the latest one.
  const [selected, setSelected] = useState<string | null>(asked && UUID.test(asked) ? asked : null);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [verify, setVerify] = useState<Verify | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const flowId = selected ?? data?.flows[0]?.flow_id ?? null;
  useEffect(() => {
    if (!flowId) return;
    api<Timeline>(`/treasury/history/${flowId}`).then(setTimeline).catch((e) => setError((e as Error).message));
  }, [flowId]);

  async function runVerify() {
    setBusy(true);
    setError(null);
    try {
      setVerify(await api<Verify>("/treasury/history/verify", { method: "POST" }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function download() {
    if (!timeline) return;
    const blob = new Blob([JSON.stringify(timeline, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `bundopay-flow-${timeline.flow_id}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-[19px] font-semibold tracking-[-0.015em]">Tamper check</h2>
            <p className="mt-1 text-sm text-muted">
              Every entry is HMAC-linked to the one before it. Verifying recomputes every link, so an edited, removed or reordered
              entry shows up. It can&rsquo;t prove an entry was true when it was written.
            </p>
          </div>
          <Button variant="primary" disabled={busy} onClick={runVerify}>
            <Icon name="verified_user" className="text-[18px]" /> {busy ? "Verifying" : "Verify chain"}
          </Button>
        </div>
        {verify && (
          <p className={`mt-4 flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold ${verify.ok ? "bg-primary-fixed text-ink" : "bg-danger-soft text-danger"}`}>
            <Icon name={verify.ok ? "check_circle" : "gpp_bad"} className="text-[20px]" />
            {verify.ok
              ? `${verify.entries} entries, HMAC chain intact`
              : `Chain broken at entry ${verify.broken_at}: ${verify.reason}. ${verify.entries} entries verified before it.`}
          </p>
        )}
        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <Card>
          <CardTitle>Flows</CardTitle>
          {!data ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : data.flows.length === 0 ? (
            <Empty icon="timeline" title="Nothing yet">Every run, approval and copilot request gets a flow here.</Empty>
          ) : (
            <ul className="-mx-2 space-y-1">
              {data.flows.map((f) => (
                <li key={f.flow_id}>
                  <button
                    onClick={() => setSelected(f.flow_id)}
                    aria-current={f.flow_id === flowId ? "true" : undefined}
                    className={`w-full rounded-xl px-3 py-2.5 text-left transition ${f.flow_id === flowId ? "bg-primary-fixed" : "hover:bg-soft"}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-sm font-semibold">{f.policy ?? (f.started_by?.startsWith("copilot") ? "Copilot request" : "Flow")}</span>
                      <Pill tone={OUTCOME_TONE(f.outcome)}>{f.outcome}</Pill>
                    </div>
                    <p className="mt-0.5 text-xs text-muted">
                      {dateTime(f.started)} · {f.entries} {f.entries === 1 ? "entry" : "entries"}{f.total ? ` · ${money(f.total, "USD")}` : ""} · <span className="font-mono">{f.flow_id.slice(0, 8)}</span>
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardTitle action={timeline && <Button variant="ghost" onClick={download}><Icon name="download" className="text-[18px]" /> Export JSON</Button>}>
            Timeline
          </CardTitle>
          {!timeline ? (
            <p className="text-sm text-muted">Pick a flow.</p>
          ) : (
            <ol className="relative space-y-4 border-l border-ink/[0.1] pl-5">
              {timeline.entries.map((e) => (
                <li key={e.id} className="relative">
                  <span className="absolute -left-[26px] top-1 h-2.5 w-2.5 rounded-full bg-primary ring-4 ring-card" aria-hidden />
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{STEP[e.event] ?? e.event}</span>
                    <Pill tone={LABEL_TONE[e.label]}>{LABEL_COPY[e.label]}</Pill>
                    {e.actor && <span className="text-xs text-muted">by {e.actor}</span>}
                  </div>
                  {detail(e) && <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{detail(e)}</p>}
                  <p className="mt-1 font-mono text-[11px] text-muted">
                    {new Date(e.created_at).toISOString().slice(11, 19)}Z · #{e.id}
                    {e.row_hash ? ` · ${e.prev_hash?.slice(0, 6)}…→${e.row_hash.slice(0, 6)}…` : " · before the chain"}
                  </p>
                </li>
              ))}
            </ol>
          )}
          <p className="mt-5 text-xs text-muted">
            Labels: <strong>PayPal-verified</strong> came from PayPal; <strong>System</strong> was written by BundoPay&rsquo;s own code;{" "}
            <strong>AI</strong> is the copilot&rsquo;s reading, never a fact. <Link href="/treasury" className="text-primary">Back to the console</Link>
          </p>
        </Card>
      </div>
    </div>
  );
}

export default function HistoryPage() {
  return (
    <Suspense>
      <HistoryView />
    </Suspense>
  );
}
