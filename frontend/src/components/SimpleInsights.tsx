"use client";

import { useMemo, useState } from "react";

import { money } from "@/lib/format";
import { ROLE_LABELS, type Insights, type Role } from "@/lib/treasury";
import type { DisputeSummary } from "@/lib/types";

/** The Insights board without AG Studio, used when no AG Studio licence is set (which would otherwise watermark it).
 * Same four numbers and the same chart as the curated board, drawn in plain SVG. */

const DAY = 86_400_000;
// Validated (dataviz validate_palette.js): passes light; dark contrast is relieved by the legend and tooltips.
const RESERVE_COLOR: Partial<Record<Role, string>> = { tax_reserve: "#6b4fa0", dispute_buffer: "#1f9a9a", ad_spend: "#c06a2b" };
const ORDER: Role[] = ["tax_reserve", "dispute_buffer", "ad_spend"];
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

type Props = { currency: string; disputes: DisputeSummary[]; insights: Insights; days: number };

export default function SimpleInsights({ currency, disputes, insights, days }: Props) {
  const since = Date.now() - days * DAY;
  const inRange = (at: string | null) => !!at && new Date(at).getTime() >= since;
  const refunded = useMemo(() => new Set(insights.auto_refunded), [insights.auto_refunded]);
  const moves = insights.movements.filter((m) => inRange(m.created_at));
  const setAside = (m: Insights["movements"][number]) =>
    m.role && m.role !== "operating" && ["executing", "unconfirmed", "succeeded"].includes(m.status) ? Number(m.amount) : 0;

  const open = disputes.filter((d) => d.status !== "RESOLVED");
  const inWindow = disputes.filter((d) => d.status !== "RESOLVED" || inRange(d.opened_at));
  const handled = inWindow.length ? inWindow.filter((d) => d.draft_status === "submitted" || refunded.has(d.id)).length / inWindow.length : null;
  const kpis = [
    { title: "At stake in disputes", caption: "Open disputes, any age", value: money(String(open.reduce((n, d) => n + Number(d.amount ?? 0), 0)), currency) },
    { title: "Set aside", caption: "Moved into your reserves", value: money(String(moves.reduce((n, m) => n + setAside(m), 0)), currency) },
    { title: "Handled by Bundo", caption: "Disputes Bundo answered or refunded", value: handled === null ? "—" : `${Math.round(handled * 100)}%` },
    { title: "Stopped by safety checks", caption: "Transfers blocked or held for you", value: String(moves.filter((m) => m.verdict === "block" || m.verdict === "ask").length) },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {kpis.map((k) => (
          <div key={k.title} className="rounded-[20px] bg-card p-5 shadow-card">
            <p className="text-sm font-semibold">{k.title}</p>
            <p className="mt-2 text-[26px] font-semibold tabular-nums tracking-[-0.02em]">{k.value}</p>
            <p className="mt-1 text-xs text-muted">{k.caption}</p>
          </div>
        ))}
      </div>
      <ReserveChart moves={moves} setAside={setAside} days={days} currency={currency} />
    </div>
  );
}

function ReserveChart({ moves, setAside, days, currency }: {
  moves: Insights["movements"]; setAside: (m: Insights["movements"][number]) => number; days: number; currency: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const today = startOfDay(new Date());
  const buckets = Array.from({ length: days }, (_, i) => {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1 - i));
    return { day, byRole: {} as Partial<Record<Role, number>> };
  });
  for (const m of moves) {
    const v = setAside(m);
    if (!v || !m.role) continue;
    const i = Math.round((startOfDay(new Date(m.created_at)).getTime() - buckets[0].day.getTime()) / DAY);
    if (buckets[i]) buckets[i].byRole[m.role] = (buckets[i].byRole[m.role] ?? 0) + v;
  }
  const roles = ORDER.filter((r) => buckets.some((b) => b.byRole[r]));
  const max = Math.max(1, ...buckets.map((b) => roles.reduce((n, r) => n + (b.byRole[r] ?? 0), 0)));
  const W = 720, H = 220, PAD_L = 8, PAD_B = 22, plotH = H - PAD_B - 8;
  const slot = (W - PAD_L) / days, barW = Math.max(3, Math.min(28, slot - 4));
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const ticks = [0, Math.floor((days - 1) / 2), days - 1];

  return (
    <figure className="rounded-[20px] bg-card p-5 shadow-card">
      <figcaption className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm font-semibold">Money set aside, by reserve</span>
        {roles.length > 0 && (
          <ul className="flex flex-wrap gap-4 text-xs text-ink-2">
            {roles.map((r) => (
              <li key={r} className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: RESERVE_COLOR[r] }} aria-hidden />{ROLE_LABELS[r]}
              </li>
            ))}
          </ul>
        )}
      </figcaption>
      {roles.length === 0 ? (
        <p className="mt-6 text-sm text-muted">Nothing set aside in this period yet.</p>
      ) : (
        <div className="relative mt-4">
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Money set aside per day, stacked by reserve">
            <line x1={PAD_L} x2={W} y1={plotH + 8} y2={plotH + 8} className="stroke-line" strokeWidth={1} />
            {buckets.map((b, i) => {
              let y = plotH + 8;
              const x = PAD_L + i * slot + (slot - barW) / 2;
              const segs = roles.filter((r) => b.byRole[r]);
              return (
                <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                  <rect x={PAD_L + i * slot} y={0} width={slot} height={plotH + 8} fill="transparent" />
                  {segs.map((r, j) => {
                    const h = Math.max(2, ((b.byRole[r] ?? 0) / max) * plotH);
                    y -= h;
                    const top = j === segs.length - 1;
                    // 2px surface gap between stacked segments; only the top segment gets the rounded end.
                    return <rect key={r} x={x} y={y} width={barW} height={Math.max(1, h - (top ? 0 : 2))} rx={top ? Math.min(4, barW / 2) : 0}
                      fill={RESERVE_COLOR[r]} opacity={hover === null || hover === i ? 1 : 0.45} />;
                  })}
                </g>
              );
            })}
            {ticks.map((i) => (
              <text key={i} x={PAD_L + i * slot + slot / 2} y={H - 4} textAnchor={i === 0 ? "start" : i === days - 1 ? "end" : "middle"}
                className="fill-muted text-[11px]">{fmt(buckets[i].day)}</text>
            ))}
          </svg>
          {hover !== null && (
            <div className="pointer-events-none absolute top-0 rounded-xl bg-ink px-3 py-2 text-xs text-white shadow-lift"
              style={{ left: `${Math.min(80, (hover / days) * 100)}%` }}>
              <p className="font-semibold">{fmt(buckets[hover].day)}</p>
              {roles.map((r) => (
                <p key={r} className="tabular-nums">{ROLE_LABELS[r]}: {money(String(buckets[hover].byRole[r] ?? 0), currency)}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}
