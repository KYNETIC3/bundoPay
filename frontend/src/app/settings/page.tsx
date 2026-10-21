"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { api } from "@/lib/api";
import { FEATURE_COPY, dateTime } from "@/lib/format";

type Status = {
  email: string;
  paypal_merchant_id: string | null;
  grant_status: string;
  granted_scopes: string[];
  connected_at: string | null;
  last_synced_at: string | null;
};

export default function Settings() {
  const [s, setS] = useState<Status | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    api<Status>("/onboarding/status").then(setS);
  }, []);

  async function disconnect() {
    await api("/onboarding/disconnect", { method: "POST" });
    setS(await api<Status>("/onboarding/status"));
    setConfirming(false);
  }

  if (!s) return null;
  return (
    <div className="narrow stack">
      <h1>Settings</h1>

      <div className="section">
        <div className="section-head">
          <h2>Connected account</h2>
        </div>
        <dl style={{ display: "grid", gridTemplateColumns: "10rem 1fr", gap: "6px 16px", margin: 0 }}>
          <dt className="muted">Signed in as</dt>
          <dd style={{ margin: 0 }}>{s.email}</dd>
          <dt className="muted">PayPal merchant ID</dt>
          <dd className="mono" style={{ margin: 0 }}>{s.paypal_merchant_id ?? "Not connected"}</dd>
          <dt className="muted">Status</dt>
          <dd style={{ margin: 0 }}>{s.grant_status.replace("_", " ")}</dd>
          <dt className="muted">Connected</dt>
          <dd style={{ margin: 0 }}>{dateTime(s.connected_at)}</dd>
          <dt className="muted">Last sync</dt>
          <dd style={{ margin: 0 }}>{dateTime(s.last_synced_at)}</dd>
        </dl>
      </div>

      <div className="section">
        <div className="section-head">
          <h2>Granted permissions</h2>
          <span className="muted">as reported by PayPal</span>
        </div>
        {s.granted_scopes.length === 0 ? (
          <p className="muted">None.</p>
        ) : (
          <ul className="permissions">
            {s.granted_scopes.map((f) => (
              <li key={f}>
                <span className="tick">✓</span>
                <div>
                  <h3>{FEATURE_COPY[f]?.title ?? f}</h3>
                  <p className="muted">{FEATURE_COPY[f]?.why}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="section">
        <div className="section-head">
          <h2>Disconnect</h2>
        </div>
        {s.grant_status === "granted" ? (
          confirming ? (
            <div className="notice stack">
              <p>
                Dispute Agent will stop reading and responding to your disputes. To revoke the permission on PayPal&rsquo;s side
                as well, remove Dispute Agent under <em>Account Settings → API access</em> in your PayPal account.
              </p>
              <div className="row-actions">
                <button className="btn" onClick={disconnect}>
                  Disconnect
                </button>
                <button className="btn quiet" onClick={() => setConfirming(false)}>
                  Keep connected
                </button>
              </div>
            </div>
          ) : (
            <button className="btn" onClick={() => setConfirming(true)}>
              Disconnect PayPal…
            </button>
          )
        ) : (
          <Link className="btn primary" href="/onboarding">
            Connect PayPal
          </Link>
        )}
      </div>
    </div>
  );
}
