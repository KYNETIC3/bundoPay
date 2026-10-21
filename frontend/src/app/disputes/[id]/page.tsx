"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { Countdown } from "@/components/Countdown";
import { Button, Card, CardTitle, Icon, Pill } from "@/components/ui";
import { api, json } from "@/lib/api";
import { dateTime, humanize, money } from "@/lib/format";
import { ACTION_VERB, agentState, disputeStatus } from "@/lib/status";
import type { DisputeDetail } from "@/lib/types";

const EVENT_LABELS: Record<string, string> = {
  "dispute.new_work_item": "PayPal asked for a response",
  "agent.recommendation": "Agent reviewed the case",
  "agent.draft_ready": "Draft ready for you",
  "agent.past_due_blocked": "Paused: deadline passed",
  "draft.edited": "You edited the draft",
  "draft.approved": "Approved",
  "draft.rejected": "You declined",
  "submit.confirmed": "PayPal confirmed",
  "submit.failed": "PayPal rejected it",
  "dispute.outcome_recorded": "Dispute closed",
};

export default function DisputePage() {
  const { id } = useParams<{ id: string }>();
  const [d, setD] = useState<DisputeDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => api<DisputeDetail>(`/disputes/${id}`).then(setD), [id]);
  useEffect(() => {
    load().catch((e) => setMessage(e.message));
  }, [load]);

  // Keep following the dispute after a response is sent, until PayPal closes it.
  const following = d?.draft?.status === "submitted" && d.status !== "RESOLVED";
  useEffect(() => {
    if (!following) return;
    const t = setInterval(() => load().catch(() => {}), 20_000);
    return () => clearInterval(t);
  }, [following, load]);

  async function analyze(acknowledgePastDue = false) {
    setBusy(true);
    setMessage(null);
    try {
      const r = await api<{ status: string }>(`/disputes/${id}/analyze`, json({ acknowledge_past_due: acknowledgePastDue }));
      if (r.status === "not_actionable") setMessage("PayPal isn't waiting on you for this one right now.");
      if (r.status === "auto_refunded") setMessage("Refunded automatically: it was within your refund limit.");
      await load();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!d) return message ? <p className="text-sm text-danger">{message}</p> : null;
  const s = disputeStatus(d.status);
  const draft = d.draft;
  const a = agentState({ status: d.status, draft_status: draft?.status ?? null, draft_action: draft?.action ?? null });
  const rec = d.evidence_map?.recommendation;
  const actionable = d.status === "WAITING_FOR_SELLER_RESPONSE";
  const offer = draft?.action === "make_offer" ? draft.payload_json.offer_amount?.value : null;
  const headline = rec?.action
    ? `${ACTION_VERB[rec.action]}${rec.action === "accept_claim" ? ` ${money(d.amount, d.currency)}` : offer ? ` of ${money(offer, d.currency)}` : ""}`
    : "No action recommended";
  const gaps = d.evidence_map?.rows_json.filter((r) => !r.satisfying_record || r.gap_or_conflict) ?? [];

  const timeline = [
    ...d.paypal_timeline.map((t) => ({ at: t.at, label: t.label, deadline: t.kind === "deadline" })),
    ...d.activity.filter((x) => EVENT_LABELS[x.event]).map((x) => ({ at: x.created_at, label: EVENT_LABELS[x.event], deadline: false })),
  ].sort((x, y) => x.at.localeCompare(y.at));

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
      <div className="space-y-5 lg:col-span-8">
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[11px] text-muted">{d.paypal_dispute_id}</p>
              <h2 className="mt-1 text-2xl font-bold tracking-tight">{d.reason_label}</h2>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Pill tone={s.tone}>{s.label}</Pill>
                <Pill tone={a.tone}>{a.label}</Pill>
                {d.status !== "RESOLVED" && <Countdown due={d.due_date} />}
              </div>
            </div>
            <div className="font-mono text-3xl font-bold tabular-nums">{money(d.amount, d.currency)}</div>
          </div>
        </Card>

        {message && <div className="rounded-xl border border-line bg-card px-4 py-3 text-sm">{message}</div>}

        {d.past_due && d.status !== "RESOLVED" && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm">
            <span><b>Deadline passed</b> on {dateTime(d.due_date)}. PayPal may not accept a response.</span>
            {actionable && !d.evidence_map && <Button onClick={() => analyze(true)} disabled={busy}>Review anyway</Button>}
          </div>
        )}

        {d.outcome && (
          <Card className="flex items-center gap-3">
            <Icon name="flag" className="text-primary" />
            <span>Closed: <b>{humanize(d.outcome.final_status)}</b> · {dateTime(d.outcome.resolved_at)}</span>
          </Card>
        )}

        <Card className="border-cream-line bg-cream">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-ink-2">
                <Icon name="smart_toy" className="text-[16px]" /> Agent recommends
              </p>
              <h3 className="mt-1 text-2xl font-bold tracking-tight">{rec ? headline : actionable ? "Not reviewed yet" : "Nothing to do"}</h3>
            </div>
            <div className="flex flex-wrap gap-2">
              {draft && ["awaiting_approval", "failed"].includes(draft.status) && (
                <Button variant="primary" href={`/disputes/${d.id}/approve`}>
                  Review &amp; approve <Icon name="arrow_forward" className="text-[18px]" />
                </Button>
              )}
              {actionable && !d.past_due && (
                <Button onClick={() => analyze()} disabled={busy}>
                  <Icon name={busy ? "progress_activity" : "refresh"} className={`text-[18px] ${busy ? "animate-spin" : ""}`} />
                  {busy ? "Reviewing" : rec ? "Check again" : "Review now"}
                </Button>
              )}
            </div>
          </div>
          {rec && rec.reasons.length > 0 && (
            <ul className="mt-4 space-y-1.5 text-sm text-ink-2">
              {rec.reasons.slice(0, 3).map((r, i) => (
                <li key={i} className="flex gap-2"><Icon name="check" className="text-[16px] text-primary" />{r}</li>
              ))}
            </ul>
          )}
          {draft?.status === "submitted" && d.status !== "RESOLVED" && (
            <p className="mt-4 text-sm text-ink-2">Sent to PayPal. This page updates on its own until the dispute closes.</p>
          )}
        </Card>

        {d.evidence_map && (
          <Card>
            <details>
              <summary className="flex cursor-pointer list-none items-center justify-between font-semibold">
                <span>What PayPal asked for</span>
                <span className="flex items-center gap-2 text-sm font-normal text-muted">
                  {gaps.length ? `${gaps.length} missing` : "All found"}
                  <Icon name="expand_more" />
                </span>
              </summary>
              <ul className="mt-4 divide-y divide-line">
                {d.evidence_map.rows_json.map((r, i) => {
                  const ok = r.satisfying_record && !r.gap_or_conflict;
                  return (
                    <li key={i} className="flex items-start gap-3 py-2.5 text-sm">
                      <Icon name={ok ? "check_circle" : "error"} className={ok ? "text-primary" : "text-coral"} />
                      <div>
                        <div className="font-medium">{humanize(r.requested_evidence_type)}</div>
                        <div className="text-muted">{r.satisfying_record ?? r.gap_or_conflict ?? "Not found"}</div>
                      </div>
                    </li>
                  );
                })}
                {d.evidence_map.integrity_flags.filter((f) => f.severity === "high").map((f, i) => (
                  <li key={`f${i}`} className="flex items-start gap-3 py-2.5 text-sm">
                    <Icon name="warning" className="text-danger" />
                    <span>{f.detail}</span>
                  </li>
                ))}
              </ul>
            </details>
          </Card>
        )}
      </div>

      <div className="space-y-5 lg:col-span-4">
        <Card className="border-ink bg-ink text-white">
          <p className="font-semibold">Questions about this dispute?</p>
          <Button href={`/agent?q=${encodeURIComponent(`Tell me about dispute ${d.paypal_dispute_id}`)}`} className="mt-3 w-full border-white/20 bg-white/10 text-white hover:bg-white/20">
            <Icon name="forum" className="text-[18px]" /> Ask the agent
          </Button>
        </Card>
        <Card>
          <CardTitle>Timeline</CardTitle>
          <ol className="relative ml-1.5 space-y-3 border-l border-line pl-4">
            {timeline.map((t, i) => (
              <li key={i} className="relative text-sm">
                <span className={`absolute -left-[21px] top-1.5 h-2 w-2 rounded-full ${t.deadline ? "bg-coral" : "bg-line-strong"}`} />
                <div className="font-medium">{t.label}</div>
                <div className="font-mono text-[11px] text-muted">{dateTime(t.at)}</div>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </div>
  );
}
