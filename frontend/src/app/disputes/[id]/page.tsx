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
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
      <div className="space-y-6 lg:col-span-8">
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-[13px] text-muted">{d.paypal_dispute_id}</p>
              <h1 className="mt-1 text-[32px] font-semibold leading-tight tracking-[-0.025em]">{d.reason_label}</h1>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Pill tone={s.tone}>{s.label}</Pill>
                <Pill tone={a.tone}>{a.label}</Pill>
                {d.status !== "RESOLVED" && <Countdown due={d.due_date} />}
              </div>
            </div>
            <div className="text-[32px] font-semibold tracking-[-0.02em] tabular-nums">{money(d.amount, d.currency)}</div>
          </div>
        </Card>

        {message && <div className="rounded-2xl bg-card px-5 py-4 text-sm shadow-card">{message}</div>}

        {d.past_due && d.status !== "RESOLVED" && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-danger-soft px-5 py-4 text-sm">
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

        <Card className="bg-ink text-white shadow-lift">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="flex items-center gap-1.5 text-[13px] font-medium text-white/65">
                <Icon name="smart_toy" className="text-[16px]" /> Agent recommends
              </p>
              <h3 className="mt-1.5 text-[26px] font-semibold tracking-[-0.02em]">{rec ? headline : actionable ? "Not reviewed yet" : "Nothing to do"}</h3>
            </div>
            <div className="flex flex-wrap gap-2">
              {draft && ["awaiting_approval", "failed"].includes(draft.status) && (
                <Button variant="primary" href={`/disputes/${d.id}/approve`} className="bg-aqua text-ink hover:bg-ice">
                  Review and approve
                </Button>
              )}
              {actionable && !d.past_due && (
                <Button onClick={() => analyze()} disabled={busy} className="bg-white/10 text-white ring-white/20 hover:bg-white/20">
                  <Icon name={busy ? "progress_activity" : "refresh"} className={`text-[18px] ${busy ? "animate-spin" : ""}`} />
                  {busy ? "Reviewing" : rec ? "Check again" : "Review now"}
                </Button>
              )}
            </div>
          </div>
          {rec && rec.reasons.length > 0 && (
            <ul className="mt-5 space-y-2 text-sm leading-relaxed text-white/80">
              {rec.reasons.slice(0, 3).map((r, i) => (
                <li key={i} className="flex gap-2"><Icon name="check" className="mt-0.5 text-[16px] text-aqua" />{r}</li>
              ))}
            </ul>
          )}
          {draft?.status === "submitted" && d.status !== "RESOLVED" && (
            <p className="mt-5 text-sm text-white/80">Sent to PayPal. This page updates on its own until the dispute closes.</p>
          )}
        </Card>

        {d.evidence_map && (
          <Card>
            <details>
              <summary className="flex cursor-pointer list-none items-center justify-between">
                <span className="text-[19px] font-semibold tracking-[-0.015em]">What PayPal asked for</span>
                <span className="flex items-center gap-2 text-sm font-normal text-muted">
                  {gaps.length ? `${gaps.length} missing` : "All found"}
                  <Icon name="expand_more" />
                </span>
              </summary>
              <ul className="mt-5 divide-y divide-ink/[0.06]">
                {d.evidence_map.rows_json.map((r, i) => {
                  const ok = r.satisfying_record && !r.gap_or_conflict;
                  return (
                    <li key={i} className="flex items-start gap-4 py-4 text-sm leading-relaxed first:pt-0">
                      <Icon name={ok ? "check_circle" : "error"} className={ok ? "text-primary" : "text-coral"} />
                      <div>
                        <div className="font-semibold">{humanize(r.requested_evidence_type)}</div>
                        <div className="text-muted">{r.satisfying_record ?? r.gap_or_conflict ?? "Not found"}</div>
                      </div>
                    </li>
                  );
                })}
                {d.evidence_map.integrity_flags.filter((f) => f.severity === "high").map((f, i) => (
                  <li key={`f${i}`} className="flex items-start gap-4 py-4 text-sm">
                    <Icon name="warning" className="text-danger" />
                    <span>{f.detail}</span>
                  </li>
                ))}
              </ul>
            </details>
          </Card>
        )}
      </div>

      <div className="space-y-6 lg:col-span-4">
        <Card>
          <h2 className="text-[19px] font-semibold tracking-[-0.015em]">Questions about this dispute?</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">The agent can explain its reasoning and what PayPal needs.</p>
          <Button href={`/agent?q=${encodeURIComponent(`Tell me about dispute ${d.paypal_dispute_id}`)}`} className="mt-5 w-full">
            <Icon name="forum" className="text-[18px]" /> Ask the agent
          </Button>
        </Card>
        <Card>
          <CardTitle>Timeline</CardTitle>
          <ol className="relative ml-1.5 space-y-6 border-l border-ink/10 pl-5">
            {timeline.map((t, i) => (
              <li key={i} className="relative text-sm">
                <span className={`absolute -left-[25px] top-1 h-2.5 w-2.5 rounded-full ${t.deadline ? "bg-coral" : i === timeline.length - 1 ? "bg-aqua shadow-[0_0_0_4px_rgb(138_198_208/0.25)]" : "bg-[#c9d3dc]"}`} />
                <div className="font-semibold">{t.label}</div>
                <div className="mt-0.5 text-[13px] text-muted">{dateTime(t.at)}</div>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </div>
  );
}
