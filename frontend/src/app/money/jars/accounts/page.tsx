"use client";

import { useEffect, useState } from "react";

import { LimitsSummary, fieldClass } from "@/components/limits";
import { Reveal, Skeleton, SuccessTick } from "@/components/motion";
import { Sheet } from "@/components/overlay";
import { ROLE_ICON, ROLE_ORDER } from "@/components/treasury";
import { Button, Icon, Pill } from "@/components/ui";
import { feedback } from "@/lib/feedback";
import { money } from "@/lib/format";
import { useLive } from "@/lib/hooks";
import { type Account, type Overview, ROLE_LABELS, type Role, changed, treasury } from "@/lib/treasury";

const ROLES: Role[] = ["operating", "tax_reserve", "dispute_buffer", "ad_spend"];

/** One clean list: which accounts Bundo may move money between, and whether each is ready. Everything else
 * (emails, editing, verifying) is one tap away in a sheet. */
export default function AccountsPage() {
  const { data, reload } = useLive<Overview>("/treasury/overview", 60_000);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  if (!data) return <div className="space-y-3"><Skeleton className="h-20" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div>;

  const taken = new Set(data.accounts.map((a) => a.role));
  const free = ROLES.filter((r) => !taken.has(r));
  const accounts = [...data.accounts].sort((x, y) => ROLE_ORDER.indexOf(x.role) - ROLE_ORDER.indexOf(y.role));
  const balance = (a: Account) => data.positions.find((p) => p.account_id === a.id)?.balance ?? null;
  const current = accounts.find((a) => a.id === openId) ?? null;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <ul className="overflow-hidden rounded-[20px] bg-card shadow-card">
        {accounts.map((a, i) => (
          <li key={a.id} className="border-b border-ink/[0.06] last:border-b-0">
            <Reveal index={i}>
              <button onClick={() => setOpenId(a.id)} className="press flex w-full items-center gap-4 px-5 py-4 text-left transition hover:bg-soft/60">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary-fixed text-primary"><Icon name={ROLE_ICON[a.role] ?? "wallet"} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{ROLE_LABELS[a.role]}</span>
                  {/* The merchant's own name for it, only when it says something the jar name doesn't. */}
                  {a.name.trim().toLowerCase() !== ROLE_LABELS[a.role].toLowerCase() && <span className="mt-0.5 block truncate text-[13px] text-muted">{a.name}</span>}
                </span>
                <span className="text-right">
                  <span className="block font-semibold tabular-nums">{money(balance(a), data.limits.currency)}</span>
                  <span className="mt-1 inline-block">
                    {a.verified_at ? <Pill tone="cerulean"><Icon name="verified" className="text-[14px]" /> Ready</Pill> : <Pill tone="danger"><Icon name="error" className="text-[14px]" /> Needs verifying</Pill>}
                  </span>
                </span>
              </button>
            </Reveal>
          </li>
        ))}
        {!accounts.length && <li className="px-5 py-10 text-center text-sm text-muted">No accounts yet. Start with the one your business runs on.</li>}
      </ul>

      {free.length > 0 && (
        <Button onClick={() => setAdding(true)} className="w-full sm:w-auto"><Icon name="add" className="text-[18px]" /> Add account</Button>
      )}

      <LimitsSummary limits={data.limits} onSaved={reload} />

      <Sheet open={!!current} onClose={() => setOpenId(null)} title={current ? ROLE_LABELS[current.role] : "Account"}>
        {current && <AccountDetail a={current} onChanged={() => { changed(); reload(); }} />}
      </Sheet>
      <Sheet open={adding} onClose={() => setAdding(false)} title="Add an account">
        <AddAccount roles={free} onAdded={() => { changed(); reload(); setAdding(false); }} />
      </Sheet>
    </div>
  );
}

function AccountDetail({ a, onChanged }: { a: Account; onChanged: () => void }) {
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState({ name: a.name, paypal_email: a.paypal_email });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function run(fn: () => Promise<{ verified?: boolean; message?: string } | unknown>, ok: string) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = (await fn()) as { verified?: boolean; message?: string } | undefined;
      if (r && r.verified === false) {
        setError(r.message ?? "PayPal couldn't confirm this account.");
        feedback("error");
      } else {
        setDone(ok);
        setEdit(false);
        feedback("approved");
      }
      onChanged();
    } catch (e) {
      setError((e as Error).message);
      feedback("error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {edit ? (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); run(() => treasury.editAccount(a.id, form), "Saved. Verify it again before money can be sent here."); }}>
          <label className="block"><span className="text-[15px] font-medium">Name</span>
            <input data-autofocus className={`${fieldClass} mt-1.5`} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="block"><span className="text-[15px] font-medium">PayPal email</span>
            <input type="email" className={`${fieldClass} mt-1.5`} value={form.paypal_email} onChange={(e) => setForm({ ...form, paypal_email: e.target.value })} />
          </label>
          <div className="flex gap-2">
            <Button variant="primary" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
            <Button type="button" variant="ghost" onClick={() => setEdit(false)}>Cancel</Button>
          </div>
        </form>
      ) : (
        <dl className="divide-y divide-ink/[0.06] rounded-2xl bg-card px-5">
          <Row label="Name">{a.name}</Row>
          <Row label="PayPal email"><span className="break-all">{a.paypal_email}</span></Row>
          <Row label="Status">{a.verified_at ? "Verified with PayPal" : a.role === "operating" ? "Not confirmed yet" : "Not verified: nothing can be sent here yet"}</Row>
        </dl>
      )}

      {!edit && (
        <div className="flex flex-wrap gap-2">
          {!a.verified_at && (
            <Button variant="primary" disabled={busy} data-autofocus onClick={() => run(() => treasury.verifyAccount(a.id), "Verified. Money can now be sent here.")}>
              {busy ? "Checking with PayPal…" : a.role === "operating" ? "Confirm with PayPal" : "Verify with $0.01"}
            </Button>
          )}
          <Button onClick={() => setEdit(true)}><Icon name="edit" className="text-[18px]" /> Edit</Button>
        </div>
      )}
      {!a.verified_at && a.role !== "operating" && (
        <p className="text-xs leading-relaxed text-muted">Verifying sends $0.01 to this PayPal email to prove it&rsquo;s real. In testing, use a sandbox account from developer.paypal.com.</p>
      )}
      {done && <p role="status" className="flex items-center gap-2 text-sm font-medium text-ink-2"><SuccessTick /> {done}</p>}
      {error && <p role="alert" className="text-sm leading-relaxed text-danger">{error}</p>}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-6 py-3.5 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}

function AddAccount({ roles, onAdded }: { roles: Role[]; onAdded: () => void }) {
  const [form, setForm] = useState({ role: roles[0], name: ROLE_LABELS[roles[0]], paypal_email: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setForm((f) => (roles.includes(f.role) ? f : { ...f, role: roles[0], name: ROLE_LABELS[roles[0]] })), [roles]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await treasury.addAccount(form);
      feedback("approved");
      onAdded();
    } catch (err) {
      setError((err as Error).message);
      feedback("error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={add} className="space-y-5">
      <fieldset>
        <legend className="text-[15px] font-medium">What is it for?</legend>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {roles.map((r) => (
            <label key={r} className={`press flex cursor-pointer items-center gap-2.5 rounded-xl px-3.5 py-3 text-sm ring-1 transition ${form.role === r ? "bg-primary-fixed font-semibold ring-primary" : "bg-card ring-ink/[0.12] hover:ring-ink/25"}`}>
              <input type="radio" name="role" value={r} checked={form.role === r} className="sr-only" onChange={() => setForm({ ...form, role: r, name: ROLE_LABELS[r] })} />
              <Icon name={ROLE_ICON[r]} className="text-[18px] text-primary" /> {ROLE_LABELS[r]}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block"><span className="text-[15px] font-medium">Name</span>
        <input className={`${fieldClass} mt-1.5`} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </label>
      <label className="block"><span className="text-[15px] font-medium">PayPal email</span>
        <input data-autofocus className={`${fieldClass} mt-1.5`} type="email" required value={form.paypal_email} onChange={(e) => setForm({ ...form, paypal_email: e.target.value })} />
        <span className="mt-1 block text-xs text-muted">You&rsquo;ll verify it next. Nothing is sent to an account until it&rsquo;s verified.</span>
      </label>
      <Button variant="primary" disabled={busy}>{busy ? "Adding…" : "Add account"}</Button>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </form>
  );
}
