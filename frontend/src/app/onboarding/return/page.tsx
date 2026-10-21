"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";

import { Icon } from "@/components/ui";
import { api, json } from "@/lib/api";
import { FEATURE_COPY } from "@/lib/format";

type Result = { paypal_merchant_id: string; granted_features: string[] };

function ReturnInner() {
  const params = useSearchParams();
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    const trackingId = params.get("merchantId");
    const merchantIdInPayPal = params.get("merchantIdInPayPal");
    if (!trackingId || !merchantIdInPayPal) {
      setError("PayPal didn't send back the details needed to finish.");
      return;
    }
    api<Result>("/onboarding/complete", json({
      tracking_id: trackingId,
      merchant_id_in_paypal: merchantIdInPayPal,
      permissions_granted: params.get("permissionsGranted") === "true",
    }))
      .then(setResult)
      .catch((e: Error) => setError(e.message));
  }, [params]);

  return (
    <div className="mx-auto max-w-md rounded-2xl border border-line bg-card p-8 text-center shadow-sm">
      {error ? (
        <>
          <Icon name="error" className="text-[44px] text-danger" />
          <h1 className="mt-2 text-2xl font-bold">Not connected</h1>
          <p className="mt-2 text-sm text-muted">{error}</p>
          <Link href="/onboarding" className="mt-6 inline-flex rounded-lg border border-line-strong px-4 py-2 text-sm font-semibold hover:bg-soft">Try again</Link>
        </>
      ) : !result ? (
        <>
          <Icon name="progress_activity" className="animate-spin text-[36px] text-primary" />
          <p className="mt-3 text-sm text-muted">Confirming with PayPal…</p>
        </>
      ) : (
        <>
          <Icon name="check_circle" className="text-[44px] text-primary" />
          <h1 className="mt-2 text-2xl font-bold">PayPal connected</h1>
          <ul className="mt-4 space-y-2 text-left text-sm">
            {result.granted_features.map((f) => (
              <li key={f} className="flex items-center gap-2"><Icon name="check" className="text-[18px] text-primary" />{FEATURE_COPY[f]?.title ?? f}</li>
            ))}
          </ul>
          <Link href="/" className="mt-6 inline-flex rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-container">Go to overview</Link>
        </>
      )}
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
