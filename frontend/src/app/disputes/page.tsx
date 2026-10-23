"use client";

import { useState } from "react";

import { DisputeTable, unresolvedCount } from "@/components/DisputeTable";
import { Button, Card, Empty, Icon, Pill } from "@/components/ui";
import { api } from "@/lib/api";
import { useLive } from "@/lib/hooks";
import type { DisputeSummary } from "@/lib/types";

const FILTERS: { key: string; label: string; test: (d: DisputeSummary) => boolean }[] = [
  { key: "all", label: "All", test: () => true },
  { key: "you", label: "Needs you", test: (d) => d.status === "WAITING_FOR_SELLER_RESPONSE" && d.draft_status !== "submitted" },
  { key: "ready", label: "Ready to approve", test: (d) => d.draft_status === "awaiting_approval" && d.status !== "RESOLVED" },
  { key: "paypal", label: "With PayPal or buyer", test: (d) => ["UNDER_REVIEW", "WAITING_FOR_BUYER_RESPONSE", "OPEN"].includes(d.status) },
  { key: "finished", label: "Finished", test: (d) => !!d.clearable },
];

const tab = (on: boolean) =>
  `inline-flex min-h-[34px] items-center gap-2 rounded-full px-4 text-[13px] transition ${
    on ? "bg-card font-semibold text-ink shadow-[0_1px_3px_rgb(54_33_62/0.1)]" : "font-medium text-ink-2 hover:text-ink"
  }`;

export default function DisputesPage() {
  const { data, error, reload } = useLive<DisputeSummary[]>("/disputes");
  const [showCleared, setShowCleared] = useState(false);
  const cleared = useLive<DisputeSummary[]>(showCleared ? "/disputes?cleared=true" : null);
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(false);

  const active = FILTERS.find((f) => f.key === filter)!;
  const items = showCleared ? cleared.data ?? [] : (data ?? []).filter(active.test);
  const finished = (data ?? []).filter((d) => d.clearable).length;

  async function clearFinished() {
    setBusy(true);
    try {
      await api("/disputes/clear-finished", { method: "POST" });
      await reload();
    } finally {
      setBusy(false);
    }
  }
  const refresh = () => {
    reload();
    cleared.reload();
  };

  return (
    <Card>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Filter disputes" className="inline-flex flex-wrap gap-1 rounded-full bg-soft p-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              role="tab"
              aria-selected={!showCleared && f.key === filter}
              onClick={() => {
                setShowCleared(false);
                setFilter(f.key);
              }}
              className={tab(!showCleared && f.key === filter)}
            >
              {f.label}<span className="text-xs text-muted tabular-nums">{(data ?? []).filter(f.test).length}</span>
            </button>
          ))}
          <button role="tab" aria-selected={showCleared} onClick={() => setShowCleared(true)} className={tab(showCleared)}>
            Cleared
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {!showCleared && finished > 0 && (
            <Button onClick={clearFinished} disabled={busy} className="min-h-8 px-3.5 text-[13px]">
              <Icon name="inventory_2" className="text-[16px]" /> Clear all finished ({finished})
            </Button>
          )}
          {data && <Pill tone={unresolvedCount(data) ? "coral" : "soft"}>{unresolvedCount(data)} unresolved</Pill>}
        </div>
      </div>

      {(error || cleared.error) && <p className="text-sm text-danger">{error ?? cleared.error}</p>}
      {(showCleared ? cleared.data : data) && items.length === 0 ? (
        <Empty icon={showCleared ? "inventory_2" : "inbox"} title={showCleared ? "Nothing cleared" : filter === "all" ? "No disputes yet" : "Nothing here"}>
          {!showCleared && filter === "all" && "When a buyer opens a dispute on PayPal, it appears here within 15 minutes, or right away if you press Refresh."}
        </Empty>
      ) : (
        <DisputeTable items={items} onChanged={refresh} />
      )}
    </Card>
  );
}
