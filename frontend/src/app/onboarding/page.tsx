"use client";

import { useEffect, useState } from "react";

import { api } from "@/lib/api";
import { FEATURE_COPY } from "@/lib/format";

export default function OnboardingPage() {
  const [features, setFeatures] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ features: string[] }>("/onboarding/permissions").then((r) => setFeatures(r.features)).catch(() => {});
  }, []);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const { action_url } = await api<{ action_url: string }>("/onboarding/start", { method: "POST" });
      window.location.assign(action_url);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="narrow stack">
      <p className="eyebrow">Step 1 of 2 · Permissions</p>
      <h1>What Dispute Agent will be able to do in your PayPal account</h1>
      <p className="lede">
        You&rsquo;ll sign in on PayPal&rsquo;s own site and approve these permissions there. We receive only your PayPal
        merchant ID and confirmation of what you approved, never your password or API credentials.
      </p>

      <ul className="permissions" style={{ marginTop: 28 }}>
        {features.map((f) => (
          <li key={f}>
            <span className="tick">✓</span>
            <div>
              <h3>{FEATURE_COPY[f]?.title ?? f}</h3>
              <p className="muted">{FEATURE_COPY[f]?.why}</p>
              <p className="mono muted">{f}</p>
            </div>
          </li>
        ))}
      </ul>

      <div className="notice">
        <strong>What stays with you.</strong> Every response to PayPal (evidence, offer or acceptance) is shown to you
        word for word first and is sent only when you approve it. You can revoke access at any time from your PayPal
        account settings.
      </div>

      {error && <p className="error">{error}</p>}
      <div className="row-actions">
        <button className="btn primary" onClick={connect} disabled={busy || features.length === 0}>
          {busy ? "Opening PayPal…" : "Connect PayPal"}
        </button>
        <span className="muted">You&rsquo;ll be redirected to the PayPal sandbox.</span>
      </div>
    </div>
  );
}
