"use client";

import { useEffect, useState } from "react";

import { showGuide } from "@/components/StartHere";
import { Button, Card, CardTitle, Icon, Pill } from "@/components/ui";
import { api } from "@/lib/api";
import { feedback, feedbackPrefs, setFeedbackPrefs } from "@/lib/feedback";
import { FEATURE_COPY, dateTime } from "@/lib/format";
import { useMerchant } from "@/lib/merchant";

type Rules = { auto_refund_enabled: boolean; auto_refund_limit: string };
type DataSummary = { kind: string; rows: number; last_import: string }[];

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-[760px] space-y-8">
      <DemoCard />
      <PayPalCard />
      <RefundLimitCard />
      <StoreDataCard />
      <FeelCard />
    </div>
  );
}

/** Sound and haptics are off until the merchant asks for them; the visual confirmations always show. */
function FeelCard() {
  const [prefs, setPrefs] = useState({ sound: false, haptics: false });
  const [canBuzz, setCanBuzz] = useState(false);
  useEffect(() => {
    setPrefs(feedbackPrefs());
    setCanBuzz(typeof navigator !== "undefined" && "vibrate" in navigator);
  }, []);
  function toggle(key: "sound" | "haptics") {
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next);
    setFeedbackPrefs(next);
    if (next[key]) feedback("approved");
  }
  const row = (key: "sound" | "haptics", title: string, hint: string, disabled = false) => (
    <li className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
      <div>
        <p className="font-medium">{title}</p>
        <p className="mt-0.5 text-[13px] text-muted">{hint}</p>
      </div>
      <button
        role="switch"
        aria-checked={prefs[key]}
        aria-label={title}
        disabled={disabled}
        onClick={() => toggle(key)}
        className={`relative h-7 w-12 shrink-0 rounded-full transition-colors duration-200 disabled:opacity-40 ${prefs[key] ? "bg-primary" : "bg-ink/20"}`}
      >
        <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform duration-200 [transition-timing-function:var(--ease-out)] motion-reduce:transition-none ${prefs[key] ? "translate-x-[22px]" : "translate-x-0.5"}`} />
      </button>
    </li>
  );
  return (
    <Card>
      <CardTitle>Sounds and haptics</CardTitle>
      <ul className="divide-y divide-ink/[0.06]">
        {row("sound", "Sounds", "A soft chime when money moves, a transfer is approved or an answer is sent.")}
        {row("haptics", "Haptics", canBuzz ? "A light tap on your phone for the same moments." : "Not supported on this device.", !canBuzz)}
      </ul>
      <p className="mt-4 text-xs text-muted">Animations follow your device&rsquo;s reduce-motion setting.</p>
    </Card>
  );
}

function DemoCard() {
  const { status } = useMerchant();
  const [demoEmail, setDemoEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    api<{ email: string | null }>("/demo/info").then((r) => setDemoEmail(r.email)).catch(() => {});
  }, []);
  if (!status || !demoEmail || status.email.toLowerCase() !== demoEmail.toLowerCase()) return null;

  async function reset() {
    setBusy(true);
    setMessage(null);
    try {
      await api("/demo/reset", { method: "POST" });
      setMessage("Done. Jars, chat and history are back to the starting point.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Reset failed.");
    }
    setBusy(false);
  }

  return (
    <Card>
      <CardTitle>Demo account</CardTitle>
      <p className="text-sm text-muted">
        Other judges share this login. Reset puts the jars, rules, limits, chat and history back to the starting
        point. It also resets every night. PayPal disputes stay, because they live in the PayPal sandbox.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button onClick={reset} disabled={busy}><Icon name="restart_alt" className="text-[18px]" /> Reset demo</Button>
        <Button variant="ghost" onClick={() => { showGuide(); setMessage("The Start here guide is back on Home."); }}>Show guide</Button>
        {message && <span role="status" className="text-sm text-muted">{message}</span>}
      </div>
    </Card>
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
      <CardTitle>
        PayPal account
      </CardTitle>
      {connected ? (
        <>
          <dl className="grid grid-cols-[9rem_1fr] text-[15px] [&>*]:border-t [&>*]:border-ink/[0.06] [&>*]:py-4 [&>:nth-child(-n+2)]:border-t-0 [&>:nth-child(-n+2)]:pt-0">
            <dt className="text-muted">Merchant ID</dt>
            <dd className="text-right text-muted">{status.paypal_merchant_id}</dd>
            <dt className="text-muted">Last refreshed</dt>
            <dd className="text-right text-muted tabular-nums">{dateTime(status.last_synced_at)}</dd>
            <dt className="text-muted">Allowed to</dt>
            <dd className="flex flex-wrap justify-end gap-1.5">
              {status.granted_scopes.map((f) => <Pill key={f} tone="cerulean">{FEATURE_COPY[f]?.title ?? f}</Pill>)}
            </dd>
          </dl>
          <div className="border-t border-ink/[0.06] pt-4">
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
        <CardTitle>Refund limit</CardTitle>
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
      <CardTitle>Refund limit</CardTitle>

      <label className="flex cursor-pointer items-center justify-between gap-6">
        <div>
          <div className="text-[15px] font-medium">Refund small disputes automatically</div>
          <div className="mt-1 text-[13px] leading-relaxed text-muted">Without asking you first, when the case can&rsquo;t clearly be won.</div>
        </div>
        <input
          type="checkbox"
          role="switch"
          checked={rules.auto_refund_enabled}
          onChange={(e) => setRules({ ...rules, auto_refund_enabled: e.target.checked })}
          className="peer sr-only"
        />
        <span className="relative h-[31px] w-[51px] shrink-0 rounded-full bg-[#dde4ea] transition peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-aqua after:absolute after:left-0.5 after:top-0.5 after:h-[27px] after:w-[27px] after:rounded-full after:bg-white after:shadow-[0_2px_4px_rgb(54_33_62/0.2)] after:transition peer-checked:after:translate-x-5" />
      </label>

      <div className={`mt-5 border-t border-ink/[0.06] pt-5 ${rules.auto_refund_enabled ? "" : "opacity-50"}`}>
        <div className="mb-3 flex items-baseline justify-between">
          <span className="text-[15px]">Up to</span>
          <span className="text-[28px] font-semibold tracking-[-0.02em] tabular-nums">${limit.toFixed(2)}</span>
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
        <div className="mt-2 flex justify-between text-xs text-muted">
          <span>$0</span><span>$20 suggested</span><span>$100</span>
        </div>
      </div>

      <p className="mt-5 text-[13px] leading-relaxed text-muted">
        Above this amount, Bundo prepares a refund or reply and waits for you to approve it.
      </p>

      <div className="mt-5 flex items-center justify-end gap-3 border-t border-ink/[0.06] pt-5">
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
      <CardTitle action={<Pill>Optional</Pill>}>Store data</CardTitle>
      <p className="-mt-2 mb-5 text-sm leading-relaxed text-muted">
        PayPal only sees the payment. Upload CSV exports from your shop so Bundo can prove you shipped, spot mismatched tracking, and fight disputes you can win. Without them, Bundo only has PayPal&rsquo;s records and leans toward refunding.
      </p>
      <ul className="divide-y divide-ink/[0.06]">
        {KINDS.map((k) => {
          const s = summary.find((x) => x.kind === k.kind);
          return (
            <li key={k.kind} className="flex flex-wrap items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
              <div className="flex min-w-0 items-center gap-3.5">
                <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-[10px] ${s ? "bg-primary-fixed text-primary" : "bg-soft text-muted"}`}>
                  <Icon name={s ? "check" : "upload"} className="text-[18px]" />
                </span>
                <div className="min-w-0">
                  <div className="text-[15px] font-medium">{k.label}</div>
                  <div className="mt-0.5 truncate text-[13px] text-muted" title={`CSV columns: ${k.cols}`}>{msg[k.kind] ?? (s ? `${s.rows} rows, ${dateTime(s.last_import)}` : `Needs: ${k.hint}`)}</div>
                </div>
              </div>
              <label className="inline-flex min-h-8 cursor-pointer items-center rounded-full bg-card px-3.5 text-[13px] font-semibold ring-1 ring-ink/[0.12] hover:bg-[#f7fafb]">
                <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && upload(k.kind, e.target.files[0])} />
                {s ? "Replace" : "Upload"}
              </label>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
