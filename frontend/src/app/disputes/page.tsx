"use client";

import { useState } from "react";

import { DisputeTable, unresolvedCount } from "@/components/DisputeTable";
import { Card, Empty, Pill } from "@/components/ui";
import { useLive } from "@/lib/hooks";
import type { DisputeSummary } from "@/lib/types";

const FILTERS: { key: string; label: string; test: (d: DisputeSummary) => boolean }[] = [
  { key: "all", label: "All", test: () => true },
  { key: "you", label: "Needs you", test: (d) => d.status === "WAITING_FOR_SELLER_RESPONSE" },
  { key: "ready", label: "Ready to approve", test: (d) => d.draft_status === "awaiting_approval" && d.status !== "RESOLVED" },
  { key: "paypal", label: "With PayPal or buyer", test: (d) => ["UNDER_REVIEW", "WAITING_FOR_BUYER_RESPONSE", "OPEN"].includes(d.status) },
  { key: "closed", label: "Closed", test: (d) => d.status === "RESOLVED" },
];

export default function DisputesPage() {
  const { data, error } = useLive<DisputeSummary[]>("/disputes");
  const [filter, setFilter] = useState("all");
  const active = FILTERS.find((f) => f.key === filter)!;
  const items = (data ?? []).filter(active.test);

  return (
    <Card>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Filter disputes" className="inline-flex flex-wrap gap-1 rounded-full bg-soft p-1">
          {FILTERS.map((f) => {
            const count = (data ?? []).filter(f.test).length;
            const on = f.key === filter;
            return (
              <button
                key={f.key}
                role="tab"
                aria-selected={on}
                onClick={() => setFilter(f.key)}
                className={`inline-flex min-h-[34px] items-center gap-2 rounded-full px-4 text-[13px] transition ${on ? "bg-card font-semibold text-ink shadow-[0_1px_3px_rgb(54_33_62/0.1)]" : "font-medium text-ink-2 hover:text-ink"}`}
              >
                {f.label}<span className="text-xs text-muted tabular-nums">{count}</span>
              </button>
            );
          })}
        </div>
        {data && <Pill tone={unresolvedCount(data) ? "coral" : "soft"}>{unresolvedCount(data)} unresolved</Pill>}
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {data && items.length === 0 ? (
        <Empty icon="inbox" title={filter === "all" ? "No disputes yet" : "Nothing here"}>
          {filter === "all" && "When a buyer opens a dispute on PayPal, it appears here within 15 minutes, or right away if you press Refresh."}
        </Empty>
      ) : (
        data && <DisputeTable items={items} />
      )}
    </Card>
  );
}
