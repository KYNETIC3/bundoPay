"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { Countdown } from "@/components/Countdown";
import { api, json } from "@/lib/api";
import { ACTION_LABELS, STAGE_LABELS, STATUS_LABELS, dateTime, humanize, money } from "@/lib/format";
import type { DisputeDetail } from "@/lib/types";

const ACTIVITY_LABELS: Record<string, string> = {
  "dispute.status_changed": "Status changed on PayPal",
  "dispute.new_work_item": "New request from PayPal",
  "agent.evidence_map": "Evidence map built",
  "agent.recommendation": "Recommendation prepared",
  "agent.draft_ready": "Draft ready for your review",
  "agent.no_draft": "No response drafted",
  "agent.past_due_blocked": "Paused: deadline passed",
  "draft.edited": "You edited the draft",
  "draft.file_attached": "File attached",
  "draft.file_removed": "File removed",
  "draft.approved": "You approved the response",
  "draft.rejected": "You rejected the draft",
  "submit.sent": "Sent to PayPal",
  "submit.confirmed": "PayPal confirmed receipt",
  "submit.failed": "PayPal rejected the submission",
  "submit.rejected": "Submission blocked",
  "dispute.outcome_recorded": "Outcome recorded",
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

  // Live updates after submission, through to resolution.
  const tracking = d?.draft?.status === "submitted" && d.status !== "RESOLVED";
  useEffect(() => {
    if (!tracking) return;
    const t = setInterval(() => load().catch(() => {}), 20_000);
    return () => clearInterval(t);
  }, [tracking, load]);

  async function analyze(acknowledgePastDue = false) {
    setBusy(true);
    setMessage(null);
    try {
      const r = await api<{ status: string }>(`/disputes/${id}/analyze`, json({ acknowledge_past_due: acknowledgePastDue }));
      if (r.status === "not_actionable") setMessage("PayPal isn't waiting on you for this dispute right now.");
      await load();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!d) return message ? <p className="error">{message}</p> : null;
  const emap = d.evidence_map;
  const rec = emap?.recommendation;
  const draft = d.draft;
  const actionable = d.status === "WAITING_FOR_SELLER_RESPONSE";

  const timeline = [
    ...d.paypal_timeline.map((t) => ({ at: t.at, label: t.label, kind: t.kind ?? "paypal" })),
    ...d.activity.map((a) => ({
      at: a.created_at,
      label:
        ACTIVITY_LABELS[a.event] +
        (a.event === "dispute.status_changed" && a.data_json.to ? `: ${STATUS_LABELS[a.data_json.to] ?? a.data_json.to}` : ""),
      kind: "app",
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return (
    <div>
      <p className="eyebrow">
        <Link href="/disputes">Disputes</Link> · <span className="mono">{d.paypal_dispute_id}</span>
      </p>
      <div className="section-head" style={{ borderBottom: 0, alignItems: "flex-end" }}>
        <div>
          <h1>{d.reason_label}</h1>
          <p className="muted">
            {money(d.amount, d.currency)} · {STATUS_LABELS[d.status] ?? d.status} ·{" "}
            {STAGE_LABELS[d.lifecycle_stage ?? ""] ?? d.lifecycle_stage}
          </p>
        </div>
        {d.status !== "RESOLVED" && <Countdown due={d.due_date} />}
      </div>

      {d.past_due && d.status !== "RESOLVED" && (
        <div className="notice gap stack" style={{ marginTop: 16 }}>
          <p>
            <strong>The seller response deadline passed on {dateTime(d.due_date)}.</strong> PayPal may no longer accept
            a response to this dispute. Dispute Agent won&rsquo;t prepare or send anything unless you choose to continue.
          </p>
          {actionable && !emap && (
            <button className="btn" onClick={() => analyze(true)} disabled={busy}>
              I understand. Prepare a response anyway
            </button>
          )}
        </div>
      )}

      {message && <p className="notice" style={{ marginTop: 16 }}>{message}</p>}

      {d.outcome && (
        <div className="notice" style={{ marginTop: 16 }}>
          Resolved: <strong>{humanize(d.outcome.final_status)}</strong> on {dateTime(d.outcome.resolved_at)}.
        </div>
      )}

      {draft?.status === "submitted" && d.status !== "RESOLVED" && (
        <div className="notice" style={{ marginTop: 16 }}>
          Your response was submitted. PayPal now shows this dispute as{" "}
          <strong>{STATUS_LABELS[d.status] ?? d.status}</strong>. This page refreshes on its own as PayPal updates it.
        </div>
      )}

      <div className="section">
        <div className="section-head">
          <h2>Recommendation</h2>
          {actionable && !d.past_due && (
            <button className="btn" onClick={() => analyze()} disabled={busy}>
              {busy ? "Working…" : emap ? "Re-analyze from PayPal" : "Prepare a response"}
            </button>
          )}
        </div>
        {!rec ? (
          <p className="muted">
            {actionable ? "Not analyzed yet." : "PayPal isn't waiting on a response from you right now."}
          </p>
        ) : (
          <div className="recommendation">
            <p className="eyebrow">
              {rec.source.startsWith("model") ? "Agent recommendation" : "Rules-based recommendation"} · coverage{" "}
              {Math.round(Number(emap!.coverage_score) * 100)}%
            </p>
            <h3>{rec.action ? ACTION_LABELS[rec.action] : "No action recommended"}</h3>
            <ul>
              {rec.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
            <p className="muted" style={{ marginTop: 12, fontSize: "0.85rem" }}>
              PayPal currently allows: {rec.allowed_actions.map((a) => ACTION_LABELS[a]).join(", ") || "nothing"}.
            </p>
            {draft && ["awaiting_approval", "failed"].includes(draft.status) && (
              <div className="row-actions" style={{ marginTop: 16 }}>
                <Link className="btn primary" href={`/disputes/${d.id}/approve`}>
                  Review the draft response
                </Link>
                {draft.status === "failed" && <span className="error">The last attempt didn&rsquo;t go through.</span>}
              </div>
            )}
            {draft?.status === "rejected" && <p className="muted">You rejected this draft.</p>}
          </div>
        )}
      </div>

      {emap && (
        <div className="section">
          <div className="section-head">
            <h2>Evidence map</h2>
            <span className="muted" style={{ fontSize: "0.85rem" }}>
              PayPal records first, then yours
            </span>
          </div>
          <div className="table-wrap">
            <table className="emap">
              <thead>
                <tr>
                  <th>PayPal asked for</th>
                  <th>Matching record</th>
                  <th>Source</th>
                  <th>Match</th>
                  <th>Gap or conflict</th>
                </tr>
              </thead>
              <tbody>
                {emap.rows_json.map((r, i) => {
                  const gap = !r.satisfying_record || !!r.gap_or_conflict;
                  return (
                    <tr key={i} className={gap ? "is-gap" : undefined}>
                      <td>
                        {humanize(r.requested_evidence_type)}
                        {r.requested_by === "REASON_DEFAULT" && <div className="muted" style={{ fontSize: "0.78rem" }}>typical for this reason</div>}
                      </td>
                      <td>{r.satisfying_record ?? <span className="gapnote">Nothing found</span>}</td>
                      <td>{r.source_system ?? "—"}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <span className="confidence">
                          <span style={{ width: `${r.match_confidence * 100}%` }} />
                        </span>
                        {Math.round(r.match_confidence * 100)}%
                      </td>
                      <td className={gap ? "gapnote" : "muted"}>{r.gap_or_conflict ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {emap.integrity_flags.length > 0 && (
            <div className="stack" style={{ marginTop: 20 }}>
              <h3>Integrity checks</h3>
              <p className="muted" style={{ fontSize: "0.88rem" }}>
                These are flagged for you to resolve. The agent never guesses past them.
              </p>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {emap.integrity_flags.map((f, i) => (
                  <li key={i} className={f.severity === "high" ? "gapnote" : undefined}>
                    <strong>{humanize(f.kind)}.</strong> {f.detail}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="section">
        <div className="section-head">
          <h2>Timeline</h2>
        </div>
        <ol className="timeline">
          {timeline.map((t, i) => (
            <li key={i} className={t.kind === "deadline" ? "deadline" : undefined}>
              <time>{dateTime(t.at)}</time>
              {t.label}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
