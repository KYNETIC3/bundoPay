"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { Button, Card, Icon, Pill } from "@/components/ui";
import { api, json } from "@/lib/api";
import { dateTime, humanize, money } from "@/lib/format";
import { disputeStatus } from "@/lib/status";
import type { DisputeDetail, Draft } from "@/lib/types";

type Confirmation = { status_before: string; status_after: string; confirmed_at: string };

const HEADLINE: Record<Draft["action"], (amount: string, offer?: string) => string> = {
  accept_claim: (amount) => `Refund ${amount} to the buyer`,
  make_offer: (_amount, offer) => `Offer the buyer ${offer}`,
  provide_evidence: () => "Send your proof to PayPal",
};

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

  if (done) {
    const after = disputeStatus(done.status_after);
    return (
      <Card className="mx-auto max-w-[720px] px-8 py-14 text-center">
        <span className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-primary-fixed text-primary"><Icon name="check" className="text-[30px]" /></span>
        <h2 className="mt-5 text-2xl font-semibold tracking-[-0.02em]">Sent to PayPal</h2>
        <p className="mt-2 text-[15px] text-muted">PayPal now shows this dispute as</p>
        <div className="mt-3"><Pill tone={after.tone}>{after.label}</Pill></div>
        <Button href={`/money/disputes/${id}`} className="mt-6">Back to dispute</Button>
      </Card>
    );
  }

  if (!d) return error ? <p className="text-sm text-danger">{error}</p> : null;
  const draft = d.draft;
  if (!draft || !["awaiting_approval", "failed"].includes(draft.status))
    return (
      <Card className="mx-auto max-w-[720px] px-8 py-14 text-center">
        <p className="text-muted">Nothing is waiting for your approval on this dispute.</p>
        <Button href={`/money/disputes/${id}`} className="mt-4">Back to dispute</Button>
      </Card>
    );

  const p = draft.payload_json;
  const amount = money(d.amount, d.currency);
  const offer = draft.action === "make_offer" ? money(p.offer_amount?.value, p.offer_amount?.currency_code) : undefined;

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
  const approve = () => run(async () => setDone(await api<Confirmation>(`/drafts/${draft.id}/approve`, json({ payload_hash: draft.payload_hash, acknowledge_past_due: ackLate }))));
  const save = () =>
    run(async () => {
      await api(`/drafts/${draft.id}`, { method: "PUT", body: JSON.stringify({ payload: editing }) });
      setEditing(null);
      setNotice("Saved. Check it once more, then approve.");
      await load();
    });
  const reject = () => run(async () => { await api(`/drafts/${draft.id}/reject`, { method: "POST" }); await load(); });
  const upload = (type: string, file: File) =>
    run(async () => {
      const form = new FormData();
      form.set("evidence_type", type);
      form.set("file", file);
      await api(`/drafts/${draft.id}/files`, { method: "POST", body: form });
      setNotice("File added. Check it once more, then approve.");
      await load();
    });
  const removeFile = (sha: string) => run(async () => { await api(`/drafts/${draft.id}/files/${sha}`, { method: "DELETE" }); await load(); });

  return (
    <div className="mx-auto max-w-[720px] space-y-6">
      <Card className="p-6 sm:p-8">
        <p className="text-[13px] text-muted">Your approval</p>
        <h1 className="mt-1.5 text-[32px] font-semibold leading-tight tracking-[-0.025em]">{HEADLINE[draft.action](amount, offer)}</h1>
        <p className="mt-2 text-sm text-muted">
          {d.reason_label}, {d.paypal_dispute_id}. Respond by {dateTime(d.due_date)}.
        </p>

        {notice && <p className="mt-5 rounded-[14px] bg-primary-fixed px-4 py-3 text-sm">{notice}</p>}

        <div className="mt-7 space-y-3 border-t border-ink/[0.06] pt-7">
          {editing ? (
            <EditForm draft={draft} value={editing} onChange={setEditing} />
          ) : draft.action === "provide_evidence" ? (
            (p.evidences as any[]).map((e) => (
              <div key={e.evidence_type} className="rounded-[14px] bg-page p-5">
                <div className="font-semibold">{humanize(e.evidence_type)}</div>
                {e.evidence_info?.tracking_info?.map((t: any) => (
                  <div key={t.tracking_number} className="mt-1 text-xs text-muted">
                    {t.carrier_name_other ?? t.carrier_name} · {t.tracking_number}
                  </div>
                ))}
                <p className="mt-2 text-sm text-ink-2">{e.notes}</p>
                {draft.files.filter((f) => f.evidence_type === e.evidence_type).map((f) => (
                  <div key={f.sha256} className="mt-2 flex items-center justify-between text-sm">
                    <span className="flex items-center gap-1"><Icon name="attach_file" className="text-[16px]" />{f.filename}</span>
                    <button className="text-xs text-danger" onClick={() => removeFile(f.sha256)} disabled={busy}>Remove</button>
                  </div>
                ))}
                <label className="mt-2 inline-flex cursor-pointer items-center gap-1 text-xs font-semibold text-primary">
                  <input type="file" className="hidden" accept="application/pdf,image/jpeg,image/png,image/gif" disabled={busy}
                    onChange={(ev) => ev.target.files?.[0] && upload(e.evidence_type, ev.target.files[0])} />
                  <Icon name="add" className="text-[16px]" /> Add a file
                </label>
              </div>
            ))
          ) : (
            <div className="rounded-[14px] bg-page p-5">
              <div className="text-[15px] font-semibold">Note to PayPal</div>
              <p className="mt-2 text-sm leading-relaxed text-ink-2">{p.note}</p>
            </div>
          )}
        </div>

        {draft.missing_items.length > 0 && !editing && (
          <details className="mt-4 rounded-[14px] bg-danger-soft px-5 py-4 text-sm">
            <summary className="cursor-pointer font-semibold text-danger">{draft.missing_items.length} thing(s) we couldn&rsquo;t find</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {draft.missing_items.map((m, i) => <li key={i}>{m.evidence_type && `${humanize(m.evidence_type)}: `}{m.detail}</li>)}
            </ul>
          </details>
        )}

        <details className="mt-6 text-sm">
          <summary className="cursor-pointer font-medium text-primary">Show exactly what PayPal receives</summary>
          <PayPalSummary draft={draft} headline={HEADLINE[draft.action](amount, offer)} />
        </details>

        {d.past_due && !editing && (
          <label className="mt-5 flex items-start gap-2 text-sm">
            <input type="checkbox" checked={ackLate} onChange={(e) => setAckLate(e.target.checked)} className="mt-1" />
            The deadline has passed. Send anyway.
          </label>
        )}

        <div className="mt-7 flex flex-wrap items-center gap-3 border-t border-ink/[0.06] pt-7">
          {editing ? (
            <>
              <Button variant="primary" onClick={save} disabled={busy}>Save changes</Button>
              <Button variant="ghost" onClick={() => setEditing(null)} disabled={busy}>Cancel</Button>
            </>
          ) : (
            <>
              <Button variant="primary" onClick={approve} disabled={busy || (d.past_due && !ackLate)}>
                {busy ? "Sending" : "Approve and send"}
              </Button>
              <Button onClick={() => setEditing(structuredClone(p))} disabled={busy}>Edit</Button>
              <Button variant="ghost" onClick={reject} disabled={busy} className="text-danger">Decline</Button>
            </>
          )}
        </div>
        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      </Card>
    </div>
  );
}

/** What approving sends, in plain words rather than the raw request. */
function PayPalSummary({ draft, headline }: { draft: Draft; headline: string }) {
  const p = draft.payload_json;
  const rows: { label: string; value: React.ReactNode }[] = [{ label: "What happens", value: headline }];
  if (draft.action === "provide_evidence") {
    for (const e of p.evidences as any[]) {
      const tracking = (e.evidence_info?.tracking_info ?? []).map((t: any) => `${t.carrier_name_other ?? t.carrier_name}, tracking ${t.tracking_number}`);
      rows.push({
        label: humanize(e.evidence_type),
        value: (
          <>
            {e.notes}
            {tracking.map((t: string) => <span key={t} className="mt-1 block text-muted">{t}</span>)}
          </>
        ),
      });
    }
  } else if (p.note) {
    rows.push({ label: "Note to PayPal", value: p.note });
  }
  rows.push({ label: "Files attached", value: draft.files.length ? draft.files.map((f) => f.filename).join(", ") : "None" });

  return (
    <dl className="mt-3 divide-y divide-ink/[0.06] rounded-[14px] bg-page px-5">
      {rows.map((r) => (
        <div key={r.label} className="grid gap-1 py-4 sm:grid-cols-[9rem_1fr] sm:gap-4">
          <dt className="text-muted">{r.label}</dt>
          <dd className="leading-relaxed text-ink">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function EditForm({ draft, value, onChange }: { draft: Draft; value: Record<string, any>; onChange: (v: Record<string, any>) => void }) {
  const field = "w-full rounded-[14px] bg-page px-4 py-3 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-aqua";
  if (draft.action !== "provide_evidence")
    return (
      <div className="space-y-3">
        {draft.action === "make_offer" && (
          <label className="block text-sm">
            <span className="mb-1 block text-muted">Offer amount ({value.offer_amount.currency_code})</span>
            <input inputMode="decimal" className={field} value={value.offer_amount.value}
              onChange={(e) => onChange({ ...value, offer_amount: { ...value.offer_amount, value: e.target.value } })} />
          </label>
        )}
        <label className="block text-sm">
          <span className="mb-1 block text-muted">Note to PayPal</span>
          <textarea maxLength={499} rows={3} className={field} value={value.note} onChange={(e) => onChange({ ...value, note: e.target.value })} />
        </label>
      </div>
    );
  const items = value.evidences as any[];
  return (
    <div className="space-y-3">
      {items.map((e, i) => (
        <label key={e.evidence_type} className="block text-sm">
          <span className="mb-1 flex items-center justify-between text-muted">
            {humanize(e.evidence_type)}
            {items.length > 1 && (
              <button type="button" className="text-xs text-danger" onClick={() => onChange({ evidences: items.filter((_, j) => j !== i) })}>Remove</button>
            )}
          </span>
          <textarea maxLength={499} rows={3} className={field} value={e.notes}
            onChange={(ev) => onChange({ evidences: items.map((x, j) => (j === i ? { ...x, notes: ev.target.value } : x)) })} />
        </label>
      ))}
    </div>
  );
}
