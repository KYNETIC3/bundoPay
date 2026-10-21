"use client";

import { useEffect, useState } from "react";

import { api } from "@/lib/api";
import { dateTime } from "@/lib/format";

const KINDS: { kind: string; title: string; columns: string; optional: string }[] = [
  {
    kind: "orders",
    title: "Orders",
    columns: "order_id, order_date, total, currency",
    optional: "paypal_transaction_id, invoice_id, customer_email, items, ship_to_name, ship_to_line1, ship_to_city, ship_to_postal_code, ship_to_country",
  },
  {
    kind: "shipments",
    title: "Shipments",
    columns: "order_id, carrier, tracking_number",
    optional: "shipped_at, delivered_at, status, ship_to_line1, ship_to_postal_code, ship_to_country",
  },
  { kind: "refunds", title: "Refunds", columns: "order_id, refund_id, amount, currency", optional: "paypal_refund_id, refunded_at, reason" },
  { kind: "tickets", title: "Support tickets", columns: "order_id, ticket_id, created_at", optional: "subject, summary, status" },
];

type Summary = { kind: string; rows: number; last_import: string };

export default function DataPage() {
  const [summary, setSummary] = useState<Summary[]>([]);
  const [msg, setMsg] = useState<Record<string, string>>({});

  const load = () => api<Summary[]>("/data/summary").then(setSummary);
  useEffect(() => {
    load();
  }, []);

  async function upload(kind: string, file: File) {
    const form = new FormData();
    form.set("kind", kind);
    form.set("file", file);
    try {
      const r = await api<{ rows: number }>("/data/csv", { method: "POST", body: form });
      setMsg((m) => ({ ...m, [kind]: `Imported ${r.rows} rows.` }));
      await load();
    } catch (e) {
      setMsg((m) => ({ ...m, [kind]: (e as Error).message }));
    }
  }

  return (
    <div className="stack">
      <p className="eyebrow">Merchant records · CSV</p>
      <h1>Your records</h1>
      <p className="lede">
        The agent checks PayPal first, then these records, to answer what PayPal asks for. Rows are used exactly as
        uploaded; nothing is filled in or adjusted. Re-uploading a row with the same ID replaces it. Orders are matched to
        disputes through <span className="mono">paypal_transaction_id</span> or <span className="mono">invoice_id</span>.
      </p>
      {KINDS.map((k) => {
        const s = summary.find((x) => x.kind === k.kind);
        return (
          <div className="section" key={k.kind}>
            <div className="section-head">
              <h2>{k.title}</h2>
              <span className="muted" style={{ fontSize: "0.85rem" }}>
                {s ? `${s.rows} rows · updated ${dateTime(s.last_import)}` : "Nothing uploaded"}
              </span>
            </div>
            <p style={{ fontSize: "0.88rem" }}>
              Required columns: <span className="mono">{k.columns}</span>
            </p>
            <p className="muted" style={{ fontSize: "0.85rem" }}>
              Optional: <span className="mono">{k.optional}</span>
            </p>
            <label className="btn" style={{ marginTop: 10, display: "inline-flex" }}>
              <input
                type="file"
                accept=".csv,text/csv"
                style={{ display: "none" }}
                onChange={(e) => e.target.files?.[0] && upload(k.kind, e.target.files[0])}
              />
              Upload {k.title.toLowerCase()} CSV
            </label>
            {msg[k.kind] && <p className="muted">{msg[k.kind]}</p>}
          </div>
        );
      })}
    </div>
  );
}
