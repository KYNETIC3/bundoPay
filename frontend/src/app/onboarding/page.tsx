"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Icon } from "@/components/ui";
import { api } from "@/lib/api";
import { FEATURE_COPY } from "@/lib/format";

export default function OnboardingPage() {
  const [features, setFeatures] = useState<string[]>([]);
  const [devMode, setDevMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    api<{ features: string[]; dev_test_mode: boolean }>("/onboarding/permissions")
      .then((r) => {
        setFeatures(r.features);
        setDevMode(r.dev_test_mode);
      })
      .catch(() => {});
  }, []);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  const connect = () => run(async () => window.location.assign((await api<{ action_url: string }>("/onboarding/start", { method: "POST" })).action_url));
  const useTestAccount = () => run(async () => { await api("/onboarding/dev-connect", { method: "POST" }); setDone(true); setBusy(false); });

  if (done)
    return (
      <div className="mx-auto max-w-md rounded-[20px] bg-card p-10 text-center shadow-card">
        <Icon name="check_circle" className="text-[44px] text-primary" />
        <h1 className="mt-2 text-2xl font-bold">Connected</h1>
        <p className="mt-2 text-sm text-muted">Using your app&rsquo;s sandbox account for testing.</p>
        <Link href="/" className="mt-6 inline-flex rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white hover:bg-primary-container">Go to overview</Link>
      </div>
    );

  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-[32px] font-semibold tracking-[-0.025em]">Connect PayPal</h1>
      <p className="mt-2 text-sm text-muted">You approve on PayPal&rsquo;s site. BundoPay never sees your PayPal password.</p>

      <div className="mt-6 rounded-[20px] bg-card p-7 shadow-card">
        <p className="text-xs font-bold text-muted">BundoPay will be able to</p>
        <ul className="mt-3 space-y-2.5">
          {features.map((f) => (
            <li key={f} className="flex items-center gap-2.5 text-sm">
              <Icon name="check" className="text-[18px] text-primary" />
              {FEATURE_COPY[f]?.title ?? f}
            </li>
          ))}
        </ul>
        <button onClick={connect} disabled={busy || !features.length} className="mt-6 w-full rounded-full bg-primary py-3 text-sm font-semibold text-white hover:bg-primary-container disabled:opacity-60">
          {busy ? "Opening PayPal…" : "Connect PayPal"}
        </button>
        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      </div>

      {devMode && (
        <div className="mt-4 rounded-[20px] bg-card p-6 shadow-card">
          <p className="text-sm font-semibold">Testing before PayPal partner approval?</p>
          <p className="mt-1 text-sm text-ink-2">Use the sandbox business account that owns your PayPal app.</p>
          <button onClick={useTestAccount} disabled={busy} className="mt-3 rounded-full bg-card px-4 py-2 ring-1 ring-ink/[0.12] text-sm font-semibold hover:bg-soft disabled:opacity-60">
            Use test account
          </button>
        </div>
      )}
      <Link href="/" className="mt-6 inline-block text-sm text-muted hover:text-ink">← Back</Link>
    </div>
  );
}
