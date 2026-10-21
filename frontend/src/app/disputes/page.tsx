"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Countdown } from "@/components/Countdown";
import { api, ApiError } from "@/lib/api";
import { STAGE_LABELS, STATUS_LABELS, money } from "@/lib/format";
import type { DisputeSummary } from "@/lib/types";

type Status = { grant_status: string; last_synced_at: string | null };

export default function Inbox() {
  const [items, setItems] = useState<DisputeSummary[] | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [s, d] = await Promise.all([api<Status>("/onboarding/status"), api<DisputeSummary[]>("/disputes")]);
    setStatus(s);
    setItems(d);
  }, []);

  useEffect(() => {
    load().catch((e) => setError(e.message));
    const id = setInterval(() => load().catch(() => {}), 30_000);
    return () => clearInterval(id);
  }, [load]);

  async function syncNow() {
    setSyncing(true);
    setError(null);
    try {
      await api("/disputes/sync", { method: "POST" });
      await load();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "reconnect_required")) setError((e as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  if (status && status.grant_status !== "granted") {
    return (
      <div className="narrow stack">
        <h1>Connect PayPal to see your disputes</h1>
        <p className="lede">
          {status.grant_status === "revoked"
            ? "PayPal reports that access was revoked. Reconnect to continue."
            : "BundoPay works from your PayPal dispute data. Start by reviewing the permissions it needs."}
        </p>
        <Link href="/onboarding" className="btn primary">
          {status.grant_status === "revoked" ? "Reconnect PayPal" : "Review permissions"}
        </Link>
      </div>
    );
  }

  const open = items?.filter((d) => d.status !== "RESOLVED") ?? [];
  const resolved = items?.filter((d) => d.status === "RESOLVED") ?? [];

  return (
    <div>
      <div className="section-head" style={{ borderBottom: 0 }}>
        <div>
          <p className="eyebrow">Inbox · soonest deadline first</p>
          <h1>Disputes</h1>
        </div>
        <div className="row-actions">
          <span className="muted" style={{ fontSize: "0.85rem" }}>
            {status?.last_synced_at ? `Synced ${new Date(status.last_synced_at).toLocaleTimeString()}` : "Not synced yet"}
          </span>
          <button className="btn" onClick={syncNow} disabled={syncing}>
            {syncing ? "Syncing…" : "Sync with PayPal"}
          </button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {items && items.length === 0 && <p className="muted">No disputes on this PayPal account.</p>}
      <ul className="inbox">
        {open.map((d) => (
          <Row key={d.id} d={d} />
        ))}
      </ul>
      {resolved.length > 0 && (
        <div className="section">
          <div className="section-head">
            <h2>Resolved</h2>
          </div>
          <ul className="inbox">
            {resolved.map((d) => (
              <Row key={d.id} d={d} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Row({ d }: { d: DisputeSummary }) {
  return (
    <li className={d.status === "RESOLVED" ? "resolved" : undefined}>
      <Link href={`/disputes/${d.id}`}>
        <span className="reason">{d.reason_label ?? "Dispute"}</span>
        <span className="amount">{money(d.amount, d.currency)}</span>
        <span className="meta">
          {STATUS_LABELS[d.status] ?? d.status} · {STAGE_LABELS[d.lifecycle_stage ?? ""] ?? d.lifecycle_stage} ·{" "}
          <span className="mono">{d.paypal_dispute_id}</span>
        </span>
        {d.status === "RESOLVED" ? <span className="countdown">Closed</span> : <Countdown due={d.due_date} />}
      </Link>
    </li>
  );
}
