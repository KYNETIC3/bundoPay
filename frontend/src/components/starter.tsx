"use client";

import { useState } from "react";

import { Button, Card, Empty, Icon } from "@/components/ui";
import { GLOSSARY, changed, treasury } from "@/lib/treasury";

const input = "min-h-11 w-full rounded-xl bg-card px-3.5 text-[15px] ring-1 ring-inset ring-ink/20 focus:outline-none focus:ring-2 focus:ring-primary";

/** First run: one email, one button. Everything else is set up for you. */
export function StarterSetup({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await treasury.starter(email.trim());
      if (!r.verified) setError(r.message);
      changed();
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <Empty icon="account_balance" title="Set aside tax money automatically">
        Treasury moves a share of each sale into a separate PayPal account, within limits you control. To try it in the sandbox you need
        one extra sandbox account to hold the savings.
        <form onSubmit={go} className="mx-auto mt-6 max-w-md space-y-3 text-left">
          <label className="block">
            <span className="text-[13px] font-semibold text-ink-2">Email of a sandbox account for your tax savings</span>
            <input className={`${input} mt-1.5`} type="email" required placeholder="tax-reserve@business.example.com" value={email}
              onChange={(e) => setEmail(e.target.value)} />
            <span className="mt-1 block text-xs text-muted">
              Create one free at developer.paypal.com &rarr; Testing Tools &rarr; Sandbox Accounts &rarr; Create account (Business).
              We prove it&rsquo;s real by sending it $0.01.
            </span>
          </label>
          <Button variant="primary" disabled={busy || !email}>{busy ? "Checking with PayPal…" : "Start with a safe starter plan"}</Button>
          {error && <p className="text-xs leading-relaxed text-danger" role="alert">{error}</p>}
          <p className="text-xs leading-relaxed text-muted">
            You get: a 10% tax-reserve rule, small test-friendly limits (moves on its own up to $500) and nothing sent until the account is verified.
            Everything can be changed later.
          </p>
        </form>
      </Empty>
    </Card>
  );
}

/** Three steps to see it work, until the first transfer exists. */
export function TryItChecklist({ reserveVerified, hasSale, hasMove }: { reserveVerified: boolean; hasSale: boolean; hasMove: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sale() {
    setBusy(true);
    setError(null);
    try {
      const r = await treasury.startTestSale("100.00");
      window.location.href = r.approve_url;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const steps = [
    { done: reserveVerified, title: "Reserve account verified", body: "PayPal confirmed your savings account is real." },
    { done: hasSale, title: "Make a test sale", body: "Pays your business $100.00 from a sandbox buyer, through real PayPal checkout.",
      action: <Button variant="primary" disabled={busy || !reserveVerified} className="min-h-9 px-3.5 text-[13px]" onClick={sale}>{busy ? "Opening PayPal…" : "Simulate a $100 sale"}</Button> },
    { done: hasMove, title: "Watch it move", body: "10% ($10.00) goes to your Tax Reserve within a few seconds. See it under Recent activity." },
  ];
  return (
    <Card>
      <h2 className="text-[19px] font-semibold tracking-[-0.015em]">Try it in 3 steps</h2>
      <ol className="mt-4 space-y-4">
        {steps.map((s, i) => (
          <li key={i} className="flex items-start gap-3">
            <Icon name={s.done ? "check_circle" : "radio_button_unchecked"} className={s.done ? "text-primary" : "text-muted"} />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{s.title}</p>
              <p className="text-sm text-muted">{s.body}</p>
              {!s.done && s.action && <div className="mt-2">{s.action}</div>}
            </div>
          </li>
        ))}
      </ol>
      {error && <p className="mt-3 text-xs text-danger" role="alert">{error}</p>}
    </Card>
  );
}

export function Glossary() {
  return (
    <details className="group/g rounded-[20px] bg-card p-6 shadow-card">
      <summary className="flex cursor-pointer list-none items-center justify-between text-[15px] font-semibold [&::-webkit-details-marker]:hidden">
        What do these words mean? <Icon name="expand_more" className="text-[20px] transition-transform group-open/g:rotate-180" />
      </summary>
      <dl className="mt-4 space-y-3 text-sm">
        {GLOSSARY.map((g) => (
          <div key={g.term}><dt className="font-semibold">{g.term}</dt><dd className="text-muted">{g.meaning}</dd></div>
        ))}
      </dl>
    </details>
  );
}
