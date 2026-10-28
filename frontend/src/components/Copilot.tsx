"use client";

import Link from "next/link";
import { useState } from "react";

import { money } from "@/lib/format";
import { CHECK_LABELS, type CopilotResult, KIND_LABELS, changed, describePolicy, treasury } from "@/lib/treasury";

import { Sheet } from "./overlay";
import { Button, Icon, IconButton, SendButton } from "./ui";

const EXAMPLE =
  "Hold 8.25% of every sale for tax. Keep dispute cover of 100% of open disputes plus 2% of 30-day sales. " +
  "Every Friday, sweep anything above a $25k operating floor into ad spend, up to $15k. Auto-run under $5k.";

/** Plain words in, draft policies out. The copilot can't activate anything: drafts still go through the
 * simulator and your approval, and a "move money now" request is shown being blocked by the engine. */
export function CopilotButton({ currency, onChanged }: { currency: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton icon="auto_awesome" label="Draft a rule in plain words" tone="soft" onClick={() => setOpen(true)} />
      <Sheet open={open} onClose={() => setOpen(false)} title="Rules Copilot">
        <Copilot currency={currency} onChanged={onChanged} />
      </Sheet>
    </>
  );
}

function Copilot({ currency, onChanged }: { currency: string; onChanged: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CopilotResult | null>(null);
  const [kept, setKept] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    setKept(null);
    try {
      setResult(await treasury.copilot(text));
      changed();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function keep() {
    if (!result?.drafts.length) return;
    setBusy(true);
    try {
      const r = await treasury.acceptDrafts(result.drafts);
      setKept(`Saved ${r.created.length} draft${r.created.length === 1 ? "" : "s"}. Open each one in Rules to preview and approve it.`);
      changed();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="mb-5 text-sm leading-relaxed text-muted">
        Describe how you&rsquo;d like money set aside. Copilot drafts the policies; nothing changes until you preview and approve each one.
      </p>
      <form onSubmit={ask} className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          data-autofocus
          placeholder="Describe your rule in plain words…"
          aria-label="Describe your rule"
          className="min-h-12 min-w-0 flex-1 resize-y rounded-2xl bg-card px-4 py-3 text-[15px] ring-1 ring-inset ring-ink/30 placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-primary"
        />
        <SendButton disabled={busy || !text.trim()} />
      </form>
      {!result && (
        <button type="button" onClick={() => setText(EXAMPLE)} className="mt-2 text-left text-[13px] text-primary hover:text-ink">
          Try an example
        </button>
      )}
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}

      {result && (
        <div className="mt-5 space-y-4">
          {result.intent === "move_now" && result.verdict ? (
            <div className="rounded-[14px] bg-danger-soft px-4 py-3 text-sm">
              <p className="flex items-center gap-2 font-semibold text-danger">
                <Icon name="block" className="text-[18px]" /> Copilot can&rsquo;t move money</p>
              <p className="mt-1 text-ink-2">
                Money only moves through a rule you approved, or your own tap on an approval. Nothing moved ({CHECK_LABELS[result.verdict.check]?.toLowerCase() ?? "not allowed"}).
              </p>
            </div>
          ) : (
            <p className="text-sm text-ink-2">{result.summary}</p>
          )}

          {result.drafts.length > 0 && (
            <ul className="space-y-2">
              {result.drafts.map((d) => (
                <li key={d.spec.kind} className="flex items-start gap-3 rounded-[14px] px-4 py-3 ring-1 ring-ink/[0.12]">
                  <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary-fixed text-primary">
                    <Icon name={KIND_LABELS[d.spec.kind].icon} className="text-[18px]" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{d.name}</p>
                    <p className="text-[13px] text-muted">{describePolicy(d, currency)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {Object.keys(result.limit_suggestions).length > 0 && (
            <p className="rounded-xl bg-soft px-4 py-3 text-[13px] text-ink-2">
              You mentioned{" "}
              {[
                result.limit_suggestions.liquidity_floor && `a ${money(result.limit_suggestions.liquidity_floor, currency)} floor`,
                result.limit_suggestions.solo_limit && `auto-running up to ${money(result.limit_suggestions.solo_limit, currency)}`,
              ].filter(Boolean).join(" and ")}
              . Those are account limits, so the copilot can&rsquo;t set them. Check them in{" "}
              <Link href="/money/jars/accounts" className="font-semibold text-primary">Accounts</Link>.
            </p>
          )}

          {result.questions.length > 0 && (
            <ul className="space-y-1 text-[13px] text-ink-2">
              {result.questions.map((q) => <li key={q} className="flex gap-2"><Icon name="help" className="text-[16px] text-primary" />{q}</li>)}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-3">
            {result.drafts.length > 0 && !kept && (
              <Button variant="primary" disabled={busy} onClick={keep}>
                <Icon name="note_add" className="text-[18px]" /> Save as drafts
              </Button>
            )}
            {kept && <span className="text-sm font-semibold text-ink-2">{kept}</span>}
            <span className="text-xs text-muted">Drafts only: nothing changes until you approve.</span>
          </div>
        </div>
      )}
    </div>
  );
}
