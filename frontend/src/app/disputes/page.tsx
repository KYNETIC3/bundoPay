"use client";

import { useState } from "react";

import { DisputeTable, unresolvedCount } from "@/components/DisputeTable";
import { Card, Empty, Pill } from "@/components/ui";
import { useLive } from "@/lib/hooks";
import type { DisputeSummary } from "@/lib/types";

const FILTERS: { key: string; label: string; test: (d: DisputeSummary) => boolean; on: string; off: string }[] = [
  { key: "all", label: "All", test: () => true, on: "bg-ink text-white", off: "border border-line-strong bg-card" },
  { key: "you", label: "Needs you", test: (d) => d.status === "WAITING_FOR_SELLER_RESPONSE", on: "bg-coral text-white", off: "border-2 border-coral bg-card" },
  { key: "ready", label: "Ready to approve", test: (d) => d.draft_status === "awaiting_approval" && d.status !== "RESOLVED", on: "bg-plum text-white", off: "border-2 border-plum bg-card" },
  { key: "paypal", label: "With PayPal / buyer", test: (d) => ["UNDER_REVIEW", "WAITING_FOR_BUYER_RESPONSE", "OPEN"].includes(d.status), on: "bg-steel text-white", off: "border-2 border-steel bg-card" },
  { key: "closed", label: "Closed", test: (d) => d.status === "RESOLVED", on: "bg-muted text-white", off: "border border-line-strong bg-card" },
];

export default function DisputesPage() {
  const { data, error } = useLive<DisputeSummary[]>("/disputes");
  const [filter, setFilter] = useState("all");
  const active = FILTERS.find((f) => f.key === filter)!;
  const items = (data ?? []).filter(active.test);

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Filter disputes" className="flex flex-wrap gap-2">
          {FILTERS.map((f) => {
            const count = (data ?? []).filter(f.test).length;
            const on = f.key === filter;
            return (
              <button
                key={f.key}
                role="tab"
                aria-selected={on}
                onClick={() => setFilter(f.key)}
                className={`rounded-full px-4 py-1 text-xs font-bold tracking-wide transition active:scale-95 ${on ? f.on : f.off}`}
              >
                {f.label} ({count})
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
