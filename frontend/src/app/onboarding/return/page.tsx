"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";

import { api, json } from "@/lib/api";
import { FEATURE_COPY } from "@/lib/format";

function ReturnInner() {
  const params = useSearchParams();
  const [result, setResult] = useState<{ paypal_merchant_id: string; granted_features: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    const trackingId = params.get("merchantId");
    const merchantIdInPayPal = params.get("merchantIdInPayPal");
    if (!trackingId || !merchantIdInPayPal) {
      setError("PayPal didn't return the details needed to finish connecting.");
      return;
    }
    api<{ paypal_merchant_id: string; granted_features: string[] }>(
      "/onboarding/complete",
      json({
        tracking_id: trackingId,
        merchant_id_in_paypal: merchantIdInPayPal,
        permissions_granted: params.get("permissionsGranted") === "true",
      }),
    )
      .then(setResult)
      .catch((e: Error) => setError(e.message));
  }, [params]);

  if (error)
    return (
      <div className="narrow stack">
        <p className="eyebrow">Step 2 of 2 · Not connected</p>
        <h1>The connection didn&rsquo;t complete</h1>
        <p className="notice gap">{error}</p>
        <Link className="btn" href="/onboarding">
          Try again
        </Link>
      </div>
    );

  if (!result)
    return (
      <div className="narrow">
        <p className="eyebrow">Step 2 of 2</p>
        <h1>Confirming your permissions with PayPal…</h1>
      </div>
    );

  return (
    <div className="narrow stack">
      <p className="eyebrow">Step 2 of 2 · Connected</p>
      <h1>PayPal confirmed the connection</h1>
      <p className="lede">
        Merchant ID <span className="mono">{result.paypal_merchant_id}</span>. We checked with PayPal directly; these are
        the permissions it reports as granted:
      </p>
      <ul className="permissions">
        {result.granted_features.map((f) => (
          <li key={f}>
            <span className="tick">✓</span>
            <div>
              <h3>{FEATURE_COPY[f]?.title ?? f}</h3>
              <p className="mono muted">{f}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="muted">Your disputes are syncing now. That can take a minute.</p>
      <div className="row-actions">
        <Link className="btn primary" href="/disputes">
          Go to disputes
        </Link>
        <Link className="btn" href="/data">
          Add your order records
        </Link>
      </div>
    </div>
  );
}

export default function OnboardingReturn() {
  return (
    <Suspense>
      <ReturnInner />
    </Suspense>
  );
}
