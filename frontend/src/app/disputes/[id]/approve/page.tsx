"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { api, json } from "@/lib/api";
import { ACTION_LABELS, STATUS_LABELS, dateTime, humanize, money } from "@/lib/format";
import type { DisputeDetail, Draft } from "@/lib/types";

type Confirmation = { status_before: string; status_after: string; confirmed_at: string };

export default function ApprovePage() {
  const { id } = useParams<{ id: string }>();
  const [d, setD] = useState<DisputeDetail | null>(null);
  const [editing, setEditing] = useState<Record<string, any> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ackLate, setAckLate] = useState(false);
  const [done, setDone] = useState<Confirmation | null>(null);

  const load = useCallback(() => api<DisputeDetail>(`/disputes/${id}`).then(setD), [id]);
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);

  if (done)
    return (
      <div className="document stack">
        <p className="eyebrow">Submitted</p>
        <h1>PayPal received your response</h1>
        <p className="lede">
          We re-checked with PayPal after sending. The dispute moved from{" "}
          <strong>{STATUS_LABELS[done.status_before] ?? done.status_before}</strong> to{" "}
          <strong>{STATUS_LABELS[done.status_after] ?? done.status_after}</strong> at {dateTime(done.confirmed_at)}.
        </p>
        <p className="muted">BundoPay will keep following it until PayPal resolves it.</p>
        <Link className="btn" href={`/disputes/${id}`}>
          Back to the dispute
        </Link>
      </div>
    );

  if (!d) return error ? <p className="error">{error}</p> : null;
  const draft = d.draft;
  if (!draft || !["awaiting_approval", "failed"].includes(draft.status))
    return (
      <div className="narrow stack">
        <p className="muted">There&rsquo;s no draft awaiting your approval for this dispute.</p>
        <Link className="btn" href={`/disputes/${id}`}>
          Back to the dispute
        </Link>
      </div>
    );

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const approve = () =>
    run(async () => {
      const r = await api<Confirmation>(
        `/drafts/${draft.id}/approve`,
        json({ payload_hash: draft.payload_hash, acknowledge_past_due: ackLate }),
      );
      setDone(r);
    });

  const saveEdits = () =>
    run(async () => {
      await api(`/drafts/${draft.id}`, { method: "PUT", body: JSON.stringify({ payload: editing }) });
      setEditing(null);
      setNotice("Edits saved. This is a new version: review it and approve again.");
      await load();
    });

  const reject = () =>
    run(async () => {
      await api(`/drafts/${draft.id}/reject`, { method: "POST" });
      await load();
    });

  const upload = (evidenceType: string, file: File) =>
    run(async () => {
      const form = new FormData();
      form.set("evidence_type", evidenceType);
      form.set("file", file);
      await api(`/drafts/${draft.id}/files`, { method: "POST", body: form });
      setNotice("File attached. The response changed, so review it again before approving.");
      await load();
    });

  const removeFile = (sha: string) =>
    run(async () => {
      await api(`/drafts/${draft.id}/files/${sha}`, { method: "DELETE" });
      await load();
    });

  return (
    <div className="document">
      <header>
        <p className="eyebrow">For your signature · {ACTION_LABELS[draft.action]}</p>
        <h1>Response to PayPal dispute {d.paypal_dispute_id}</h1>
        <dl>
          <dt>Dispute</dt>
          <dd>{d.reason_label}</dd>
          <dt>Amount</dt>
          <dd>{money(d.amount, d.currency)}</dd>
          <dt>Respond by</dt>
          <dd className={d.past_due ? "gapnote" : undefined}>
            {dateTime(d.due_date)}
            {d.past_due && " (passed)"}
          </dd>
          <dt>Sent to</dt>
          <dd>PayPal, on your behalf, only if you approve</dd>
        </dl>
      </header>

      {notice && <p className="notice" style={{ marginBottom: 16 }}>{notice}</p>}

      {editing ? (
        <EditForm draft={draft} value={editing} onChange={setEditing} />
      ) : (
        <Body draft={draft} onUpload={upload} onRemoveFile={removeFile} busy={busy} />
      )}

      {draft.missing_items.length > 0 && (
        <div className="missing">
          <strong>Not included, because no matching record exists or it conflicts:</strong>
          <ul>
            {draft.missing_items.map((m, i) => (
              <li key={i}>
                {m.evidence_type && <>{humanize(m.evidence_type)}: </>}
                {m.detail}
              </li>
            ))}
          </ul>
        </div>
      )}

      <details className="payload">
        <summary>Exact request PayPal will receive</summary>
        <pre>
          {`POST /v1/customer/disputes/${d.paypal_dispute_id}/${draft.action.replace("_", "-")}\n\n`}
          {draft.action === "provide_evidence" ? "input = " : ""}
          {JSON.stringify(draft.payload_json, null, 2)}
          {draft.files.map((f) => `\n\nevidence-file = ${f.filename} (${f.content_type}, ${f.size} bytes, sha256 ${f.sha256})`).join("")}
        </pre>
      </details>

      <div className="signature">
        {editing ? (
          <div className="row-actions">
            <button className="btn primary" onClick={saveEdits} disabled={busy}>
              Save edits
            </button>
            <button className="btn quiet" onClick={() => setEditing(null)} disabled={busy}>
              Discard edits
            </button>
            <span className="muted" style={{ fontSize: "0.85rem" }}>
              Saving creates a new version that you&rsquo;ll need to approve again.
            </span>
          </div>
        ) : (
          <>
            <p className="line">
              I have read this response. Submit it to PayPal, exactly as shown, on my behalf.
            </p>
            {d.past_due && (
              <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 14 }}>
                <input type="checkbox" checked={ackLate} onChange={(e) => setAckLate(e.target.checked)} style={{ width: "auto", marginTop: 4 }} />
                I understand the deadline has passed and PayPal may not accept this response.
              </label>
            )}
            <div className="row-actions">
              <button className="btn primary" onClick={approve} disabled={busy || (d.past_due && !ackLate)}>
                {busy ? "Submitting…" : "Approve and submit"}
              </button>
              <button className="btn" onClick={() => setEditing(structuredClone(draft.payload_json))} disabled={busy}>
                Edit
              </button>
              <button className="btn quiet" onClick={reject} disabled={busy}>
                Reject
              </button>
            </div>
            <p className="fingerprint" style={{ marginTop: 16 }}>
              Version fingerprint {draft.payload_hash}
            </p>
          </>
        )}
        {error && <p className="error" style={{ marginTop: 12 }}>{error}</p>}
      </div>
    </div>
  );
}

function Body({
  draft,
  onUpload,
  onRemoveFile,
  busy,
}: {
  draft: Draft;
  onUpload: (type: string, f: File) => void;
  onRemoveFile: (sha: string) => void;
  busy: boolean;
}) {
  const p = draft.payload_json;
  if (draft.action === "make_offer")
    return (
      <div className="clause">
        <p>
          Offer the buyer a refund of <strong>{money(p.offer_amount.value, p.offer_amount.currency_code)}</strong> to resolve
          the dispute.
        </p>
        <blockquote>{p.note}</blockquote>
      </div>
    );
  if (draft.action === "accept_claim")
    return (
      <div className="clause">
        <p>Accept the buyer&rsquo;s claim. PayPal will refund the buyer.</p>
        <blockquote>{p.note}</blockquote>
      </div>
    );
  return (
    <div>
      {(p.evidences as any[]).map((e, i) => {
        const files = draft.files.filter((f) => f.evidence_type === e.evidence_type);
        return (
          <div className="clause" key={e.evidence_type}>
            <h3>
              <span className="num">{i + 1}.</span>
              {humanize(e.evidence_type)}
            </h3>
            {e.evidence_info?.tracking_info?.map((t: any) => (
              <p key={t.tracking_number} className="muted">
                Tracking <span className="mono">{t.tracking_number}</span> · {t.carrier_name_other ?? t.carrier_name}
              </p>
            ))}
            {e.evidence_info?.refund_ids?.length > 0 && (
              <p className="muted">
                PayPal refund <span className="mono">{e.evidence_info.refund_ids.join(", ")}</span>
              </p>
            )}
            <blockquote>{e.notes}</blockquote>
            <ul className="files">
              {files.map((f) => (
                <li key={f.sha256}>
                  <span>
                    📎 {f.filename} <span className="muted">({Math.ceil(f.size / 1024)} KB)</span>
                  </span>
                  <button className="btn quiet" onClick={() => onRemoveFile(f.sha256)} disabled={busy}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            <label className="muted" style={{ marginTop: 8, cursor: "pointer" }}>
              <input
                type="file"
                accept="application/pdf,image/jpeg,image/png,image/gif"
                style={{ display: "none" }}
                disabled={busy}
                onChange={(ev) => ev.target.files?.[0] && onUpload(e.evidence_type, ev.target.files[0])}
              />
              + Attach a document (PDF, JPG, PNG or GIF, up to 10 MB)
            </label>
          </div>
        );
      })}
    </div>
  );
}

function EditForm({ draft, value, onChange }: { draft: Draft; value: Record<string, any>; onChange: (v: Record<string, any>) => void }) {
  if (draft.action !== "provide_evidence")
    return (
      <div className="stack clause">
        {draft.action === "make_offer" && (
          <div>
            <label>Offer amount ({value.offer_amount.currency_code})</label>
            <input
              inputMode="decimal"
              value={value.offer_amount.value}
              onChange={(e) => onChange({ ...value, offer_amount: { ...value.offer_amount, value: e.target.value } })}
            />
          </div>
        )}
        <div>
          <label>Note to PayPal ({value.note.length}/499)</label>
          <textarea maxLength={499} value={value.note} onChange={(e) => onChange({ ...value, note: e.target.value })} />
        </div>
      </div>
    );
  const items = value.evidences as any[];
  return (
    <div>
      {items.map((e, i) => (
        <div className="clause stack" key={e.evidence_type}>
          <div className="section-head" style={{ marginBottom: 0 }}>
            <h3>{humanize(e.evidence_type)}</h3>
            <button
              className="btn quiet"
              onClick={() => onChange({ evidences: items.filter((_, j) => j !== i) })}
              disabled={items.length === 1}
            >
              Remove item
            </button>
          </div>
          <div>
            <label>Note ({e.notes.length}/499). Keep it factual.</label>
            <textarea
              maxLength={499}
              value={e.notes}
              onChange={(ev) => onChange({ evidences: items.map((x, j) => (j === i ? { ...x, notes: ev.target.value } : x)) })}
            />
          </div>
          {e.evidence_info && <p className="muted" style={{ fontSize: "0.85rem" }}>Tracking and refund details come from your records and can&rsquo;t be edited here.</p>}
        </div>
      ))}
    </div>
  );
}
