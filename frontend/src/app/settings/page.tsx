"use client";

import { useEffect, useState } from "react";

import { Button, Card, CardTitle, Icon, Pill } from "@/components/ui";
import { api } from "@/lib/api";
import { FEATURE_COPY, dateTime } from "@/lib/format";
import { useMerchant } from "@/lib/merchant";

type Rules = { auto_refund_enabled: boolean; auto_refund_limit: string };
type DataSummary = { kind: string; rows: number; last_import: string }[];

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PayPalCard />
      <RefundLimitCard />
      <StoreDataCard />
    </div>
  );
}

function PayPalCard() {
  const { status, refresh } = useMerchant();
  const [confirming, setConfirming] = useState(false);
  if (!status) return null;
  const connected = status.grant_status === "granted";

  async function disconnect() {
    await api("/onboarding/disconnect", { method: "POST" });
    setConfirming(false);
    await refresh();
  }

  return (
    <Card>
      <CardTitle action={<Pill tone={connected ? "cerulean" : "coral"}>{connected ? "Connected" : "Not connected"}</Pill>}>
        PayPal account
      </CardTitle>
      {connected ? (
        <>
          <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
            <dt className="text-muted">Merchant ID</dt>
            <dd className="font-mono">{status.paypal_merchant_id}</dd>
            <dt className="text-muted">Last refreshed</dt>
            <dd>{dateTime(status.last_synced_at)}</dd>
            <dt className="text-muted">Allowed to</dt>
            <dd className="flex flex-wrap gap-1.5">
              {status.granted_scopes.map((f) => <Pill key={f}>{FEATURE_COPY[f]?.title ?? f}</Pill>)}
            </dd>
          </dl>
          <div className="mt-5 border-t border-line pt-4">
            {confirming ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="mr-auto">BundoPay will stop working on your disputes.</span>
                <Button onClick={disconnect} className="text-danger">Disconnect</Button>
                <Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
              </div>
            ) : (
              <Button variant="ghost" onClick={() => setConfirming(true)} className="text-danger">
                <Icon name="link_off" className="text-[18px]" /> Disconnect
              </Button>
            )}
          </div>
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">Connect PayPal so Bundo can see and answer your disputes.</p>
          <Button variant="primary" href="/onboarding">Connect PayPal</Button>
        </div>
      )}
    </Card>
  );
}

function RefundLimitCard() {
  const [rules, setRules] = useState<Rules | null>(null);
  const [saved, setSaved] = useState<Rules | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    api<Rules>("/agent/settings")
      .then((r) => {
        setRules(r);
        setSaved(r);
      })
      .catch((e: Error) => setMessage(e.message));
  }, []);
  if (!rules)
    return message ? (
      <Card>
        <CardTitle>Bundo&rsquo;s refund limit</CardTitle>
        <p className="text-sm text-danger">{message}</p>
      </Card>
    ) : null;
  const limit = Number(rules.auto_refund_limit);
  const dirty = JSON.stringify(rules) !== JSON.stringify(saved);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const r = await api<Rules>("/agent/settings", {
        method: "PUT",
        body: JSON.stringify({ auto_refund_enabled: rules!.auto_refund_enabled, auto_refund_limit: limit.toFixed(2) }),
      });
      setRules(r);
      setSaved(r);
      setMessage("Saved");
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div id="agent" className="scroll-mt-24" />
      <CardTitle>Bundo&rsquo;s refund limit</CardTitle>

      <label className="flex cursor-pointer items-center justify-between gap-4 rounded-xl border border-line p-4">
        <div>
          <div className="font-semibold">Refund small disputes automatically</div>
          <div className="text-sm text-muted">Without asking you first, when the case can&rsquo;t clearly be won.</div>
        </div>
        <input
          type="checkbox"
          role="switch"
          checked={rules.auto_refund_enabled}
          onChange={(e) => setRules({ ...rules, auto_refund_enabled: e.target.checked })}
          className="peer sr-only"
        />
        <span className="relative h-6 w-11 shrink-0 rounded-full bg-line-strong transition peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-primary-container after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow after:transition peer-checked:after:translate-x-5" />
      </label>

      <div className={`mt-4 rounded-xl border border-line p-4 ${rules.auto_refund_enabled ? "" : "opacity-50"}`}>
        <div className="mb-2 flex items-center justify-between">
          <span className="font-semibold">Up to</span>
          <span className="rounded-md bg-primary-fixed/60 px-2 py-0.5 font-mono text-lg font-bold text-primary tabular-nums">${limit.toFixed(2)}</span>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={limit}
          disabled={!rules.auto_refund_enabled}
          onChange={(e) => setRules({ ...rules, auto_refund_limit: e.target.value })}
          aria-label="Automatic refund limit"
          className="w-full accent-primary"
        />
        <div className="flex justify-between font-mono text-[10px] text-muted">
          <span>$0</span><span>$20 suggested</span><span>$100</span>
        </div>
      </div>

      <p className="mt-3 text-sm text-muted">
        Above this amount, Bundo prepares a refund or reply and waits for you to approve it.
      </p>

      <div className="mt-4 flex items-center gap-3">
        <Button variant="primary" onClick={save} disabled={busy || !dirty}>Save</Button>
        {message && <span className="text-sm text-muted">{message}</span>}
      </div>
    </Card>
  );
}

const KINDS = [
  { kind: "orders", label: "Orders", cols: "order_id, order_date, total, currency, paypal_transaction_id", hint: "order ID, order date, total, currency, PayPal transaction ID" },
  { kind: "shipments", label: "Shipments", cols: "order_id, carrier, tracking_number, status", hint: "order ID, carrier, tracking number, status" },
  { kind: "refunds", label: "Refunds", cols: "order_id, refund_id, amount, currency, paypal_refund_id", hint: "order ID, refund ID, amount, currency, PayPal refund ID" },
  { kind: "tickets", label: "Support tickets", cols: "order_id, ticket_id, created_at, summary", hint: "order ID, ticket ID, date opened, summary" },
];

function StoreDataCard() {
  const [summary, setSummary] = useState<DataSummary>([]);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const load = () => api<DataSummary>("/data/summary").then(setSummary).catch(() => {});
  useEffect(() => {
    load();
  }, []);

  async function upload(kind: string, file: File) {
    const form = new FormData();
    form.set("kind", kind);
    form.set("file", file);
    try {
      const r = await api<{ rows: number }>("/data/csv", { method: "POST", body: form });
      setMsg((m) => ({ ...m, [kind]: `${r.rows} rows added` }));
      load();
    } catch (e) {
      setMsg((m) => ({ ...m, [kind]: (e as Error).message }));
    }
  }

  return (
    <Card>
      <div id="data" className="scroll-mt-24" />
      <CardTitle action={<Pill>Optional</Pill>}>Order records</CardTitle>
      <p className="mb-4 text-sm text-muted">Upload your shop&rsquo;s order, shipping, refund and support-ticket exports (CSV). Bundo matches them to each dispute, for example a tracking number that proves delivery, so it can argue your case instead of just refunding.</p>
      <ul className="divide-y divide-line">
        {KINDS.map((k) => {
          const s = summary.find((x) => x.kind === k.kind);
          return (
            <li key={k.kind} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <div className="font-medium">{k.label}</div>
                <div className="truncate text-xs text-muted" title={`CSV columns: ${k.cols}`}>{msg[k.kind] ?? (s ? `${s.rows} rows · ${dateTime(s.last_import)}` : `Needs: ${k.hint}`)}</div>
              </div>
              <label className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-line-strong px-3 py-1.5 text-sm font-semibold hover:bg-soft">
                <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && upload(k.kind, e.target.files[0])} />
                <Icon name="upload" className="text-[18px]" /> Upload
              </label>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
