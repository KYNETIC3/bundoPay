"use client";

import { useEffect, useState } from "react";

import { feedback } from "@/lib/feedback";
import { money } from "@/lib/format";
import { type Limits, treasury } from "@/lib/treasury";

import { Sheet } from "./overlay";
import { Button, Details, Icon } from "./ui";

export const fieldClass = "min-h-11 w-full rounded-xl bg-card px-3.5 text-[15px] ring-1 ring-inset ring-ink/20 focus:outline-none focus:ring-2 focus:ring-primary";

/** The safety limits in one sentence, for overview pages. Tapping it opens the full limits sheet. */
export function LimitsSummary({ limits, onSaved }: { limits: Limits; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const c = limits.currency;
  return (
    <>
      <button onClick={() => setOpen(true)} className="press group flex w-full items-center gap-4 rounded-[20px] bg-card p-5 text-left shadow-card transition hover:shadow-lift">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-fixed text-primary"><Icon name="shield" /></span>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">Safety limits</span>
          <span className="mt-0.5 block text-sm text-muted">
            Always keeps <b className="font-semibold text-ink-2 tabular-nums">{money(limits.liquidity_floor, c)}</b> in Operating; moves up to{" "}
            <b className="font-semibold text-ink-2 tabular-nums">{money(limits.solo_limit, c)}</b> without asking you.
          </span>
        </span>
        <Icon name="chevron_right" className="text-muted transition group-hover:translate-x-0.5 group-hover:text-ink" />
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Safety limits">
        <LimitsForm limits={limits} onSaved={() => { onSaved(); setOpen(false); }} />
      </Sheet>
    </>
  );
}

/** Every rule stays inside these, even with your approval. Three limits most people set; the rest are tucked away. */
export function LimitsForm({ limits, onSaved }: { limits: Limits; onSaved: () => void }) {
  const [form, setForm] = useState(limits);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  // Pick up changes made elsewhere, but never overwrite what the person is typing.
  useEffect(() => { if (!dirty) setForm(limits); }, [limits, dirty]);
  const field = (key: keyof Limits, label: string, hint: string, optional = false, autofocus = false) => (
    <label className="block">
      <span className="text-[15px] font-medium text-ink">{label}</span>
      <input className={`${fieldClass} mt-1.5 tabular-nums`} inputMode="decimal" placeholder={optional ? "No cap" : undefined} data-autofocus={autofocus || undefined}
        value={form[key] ?? ""} onChange={(e) => { setDirty(true); setForm({ ...form, [key]: e.target.value === "" && optional ? null : e.target.value }); }} />
      <span className="mt-1 block text-xs text-muted">{hint}</span>
    </label>
  );

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const bad = (["liquidity_floor", "solo_limit", "hard_cap_per_run", "hard_cap_per_week", "hard_cap_per_day", "hard_cap_per_month", "movable_when_unknown"] as const)
      .find((k) => form[k] !== null && form[k] !== "" && !/^\d+(\.\d{1,2})?$/.test(String(form[k])));
    if (bad) return setNote("Use plain numbers with up to 2 decimals, like 1500 or 1500.50.");
    if (Number(form.solo_limit) > Number(form.hard_cap_per_run)) return setNote("“Move without asking up to” can't be more than the per-run cap.");
    setBusy(true);
    setNote(null);
    try {
      const { currency: _c, ...rest } = form;
      await treasury.putLimits({ ...rest, movable_when_unknown: rest.movable_when_unknown === "" ? null : rest.movable_when_unknown });
      setDirty(false);
      feedback("approved");
      onSaved();
    } catch (err) {
      setNote((err as Error).message);
      feedback("error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-5">
      <p className="text-sm leading-relaxed text-muted">Every rule stays inside these, even when you approve a transfer.</p>
      {field("liquidity_floor", "Keep at least", "In Operating. Nothing moves if Operating would drop below this.", false, true)}
      {field("solo_limit", "Approve anything over", "Smaller moves run on their own; anything over this waits for your OK.")}
      {field("hard_cap_per_week", "Never move more than, per 7 days", "Counts everything moved in the last 7 days.")}
      <Details summary="More limits">
        <div className="space-y-5">
          {field("hard_cap_per_run", "Never more than, per run", "Stopped above this, even if you approve.")}
          {field("hard_cap_per_day", "Never more than, per 24 hours", "Optional.", true)}
          {field("hard_cap_per_month", "Never more than, per 30 days", "Optional.", true)}
          {field("movable_when_unknown", "If PayPal won't show Operating's balance, allow up to", "Your own number, used only when PayPal gives none. Leave empty to block moves instead.", true)}
        </div>
      </Details>
      <div className="flex items-center gap-3 pt-1">
        <Button variant="primary" disabled={busy}>{busy ? "Saving…" : "Save limits"}</Button>
        {note && <span role="alert" className="text-sm text-danger">{note}</span>}
      </div>
    </form>
  );
}
