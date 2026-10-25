"use client";

import { useEffect, useState } from "react";

import { ROLE_ICON, ROLE_ORDER } from "@/components/treasury";
import { Button, Card, CardTitle, Icon, IconButton } from "@/components/ui";
import { useLive } from "@/lib/hooks";
import { type Account, type Limits, type Overview, ROLE_LABELS, type Role, changed, treasury } from "@/lib/treasury";

const input = "min-h-11 w-full rounded-xl bg-card px-3.5 text-[15px] ring-1 ring-inset ring-ink/20 focus:outline-none focus:ring-2 focus:ring-primary";
const ROLES: Role[] = ["operating", "tax_reserve", "dispute_buffer", "ad_spend"];

export default function SetupPage() {
  const { data, reload } = useLive<Overview>("/treasury/overview", 60_000);
  if (!data) return <Card><p className="text-sm text-muted">Loading…</p></Card>;
  const taken = new Set(data.accounts.map((a) => a.role));
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <Card>
        <CardTitle>Your accounts</CardTitle>
        <p className="-mt-2 mb-6 max-w-prose text-sm leading-relaxed text-muted">
          Money is only ever sent to accounts you&rsquo;ve confirmed. Changing an account&rsquo;s details asks you to confirm it again.
        </p>
        <div className="divide-y divide-ink/[0.06]">
          {[...data.accounts].sort((x, y) => ROLE_ORDER.indexOf(x.role) - ROLE_ORDER.indexOf(y.role)).map((a) => <AccountRow key={a.id} a={a} currency={data.limits.currency} onChanged={reload} />)}
        </div>
        {ROLES.some((r) => !taken.has(r)) && <AddAccount roles={ROLES.filter((r) => !taken.has(r))} onAdded={reload} />}
      </Card>
      <LimitsCard limits={data.limits} onSaved={reload} />
    </div>
  );
}

function AccountRow({ a, currency, onChanged }: { a: Account; currency: string; onChanged: () => void }) {
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState({ name: a.name, paypal_email: a.paypal_email, opening_balance: a.opening_balance });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setEdit(false);
      changed();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="py-4 first:pt-0 last:pb-0">
      {edit ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <input className={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label="Name" />
          <input className={input} value={form.paypal_email} onChange={(e) => setForm({ ...form, paypal_email: e.target.value })} aria-label="PayPal email" />
          <input className={input} inputMode="decimal" value={form.opening_balance} onChange={(e) => setForm({ ...form, opening_balance: e.target.value })} aria-label="Opening balance" />
          <div className="flex gap-2 sm:col-span-3">
            <Button variant="primary" disabled={busy} onClick={() => run(() => treasury.editAccount(a.id, form))}>Save</Button>
            <Button variant="ghost" onClick={() => setEdit(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-4">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary-fixed text-primary"><Icon name={ROLE_ICON[a.role] ?? "wallet"} /></span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{a.name}</p>
            <p className="mt-0.5 truncate text-[13px] text-muted">{a.paypal_email}</p>
            <p className={`mt-1 flex items-center gap-1 text-[13px] ${a.verified_at ? "text-ink-2" : "font-medium text-danger"}`}>
              <Icon name={a.verified_at ? "verified" : "error"} className={`text-[16px] ${a.verified_at ? "text-primary" : ""}`} />
              {a.verified_at ? "Confirmed" : "Not confirmed yet: nothing can be sent here"}
            </p>
          </div>
          <div className="flex items-center gap-1">
            {!a.verified_at && (
              <Button variant="primary" disabled={busy} className="min-h-9 px-3.5 text-[13px]" onClick={() => run(() => treasury.verifyAccount(a.id))}>
                Confirm details
              </Button>
            )}
            <IconButton icon="edit" label="Edit account" onClick={() => setEdit(true)} />
          </div>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  );
}

function AddAccount({ roles, onAdded }: { roles: Role[]; onAdded: () => void }) {
  const [form, setForm] = useState({ role: roles[0], name: ROLE_LABELS[roles[0]], paypal_email: "", opening_balance: "0.00" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setForm((f) => (roles.includes(f.role) ? f : { ...f, role: roles[0], name: ROLE_LABELS[roles[0]] })), [roles]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await treasury.addAccount(form);
      setForm({ ...form, paypal_email: "", opening_balance: "0.00" });
      changed();
      onAdded();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={add} className="mt-5 grid gap-3 border-t border-ink/[0.06] pt-5 sm:grid-cols-2">
      <select className={input} value={form.role} aria-label="Account role"
        onChange={(e) => setForm({ ...form, role: e.target.value as Role, name: ROLE_LABELS[e.target.value as Role] })}>
        {roles.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
      </select>
      <input className={input} placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label="Name" />
      <input className={input} placeholder="Sandbox PayPal email" type="email" required value={form.paypal_email}
        onChange={(e) => setForm({ ...form, paypal_email: e.target.value })} aria-label="PayPal email" />
      <input className={input} placeholder="Opening balance" inputMode="decimal" value={form.opening_balance}
        onChange={(e) => setForm({ ...form, opening_balance: e.target.value })} aria-label="Opening balance" />
      <div className="sm:col-span-2">
        <Button variant="primary" disabled={busy}><Icon name="add" className="text-[18px]" /> Add account</Button>
        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      </div>
    </form>
  );
}

function LimitsCard({ limits, onSaved }: { limits: Limits; onSaved: () => void }) {
  const [form, setForm] = useState(limits);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const field = (key: keyof Limits, label: string, hint: string, optional = false) => (
    <label className="block">
      <span className="text-[13px] font-semibold text-ink-2">{label}</span>
      <input className={`${input} mt-1.5 tabular-nums`} inputMode="decimal" placeholder={optional ? "No cap" : undefined}
        value={form[key] ?? ""} onChange={(e) => setForm({ ...form, [key]: e.target.value === "" && optional ? null : e.target.value })} />
      <span className="mt-1 block text-xs text-muted">{hint}</span>
    </label>
  );

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      const { currency: _c, ...rest } = form;
      await treasury.putLimits(rest);
      setNote("Limits saved.");
      onSaved();
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardTitle>Safety limits</CardTitle>
      <p className="-mt-2 mb-6 text-sm leading-relaxed text-muted">Every policy stays inside these, even with your approval.</p>
      <form onSubmit={save} className="space-y-4">
        {field("liquidity_floor", "Always keep in Operating", "Nothing moves if Operating would drop below this.")}
        {field("solo_limit", "Move on its own up to", "Anything larger waits for your OK.")}
        {field("hard_cap_per_run", "Never more than, per run", "Stopped above this, even if you approve.")}
        {field("hard_cap_per_week", "Never more than, per 7 days", "Counts everything moved in the last 7 days.")}
        <details className="group/more">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[13px] font-medium text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
            Daily and monthly limits <Icon name="expand_more" className="text-[18px] transition-transform group-open/more:rotate-180" />
          </summary>
          <div className="mt-4 space-y-4">
            {field("hard_cap_per_day", "Never more than, per 24 hours", "Optional.", true)}
            {field("hard_cap_per_month", "Never more than, per 30 days", "Optional.", true)}
          </div>
        </details>
        <div className="flex items-center gap-3">
          <Button variant="primary" disabled={busy}>Save limits</Button>
          {note && <span className="text-sm text-ink-2">{note}</span>}
        </div>
      </form>
    </Card>
  );
}
