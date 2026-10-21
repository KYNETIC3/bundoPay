"use client";

import { useState } from "react";

import { DisputeTable } from "@/components/DisputeTable";
import { Button, Card, Empty, Icon } from "@/components/ui";
import { api } from "@/lib/api";
import { useLive } from "@/lib/hooks";
import type { DisputeSummary } from "@/lib/types";

const FILTERS: { key: string; label: string; test: (d: DisputeSummary) => boolean; on: string; off: string }[] = [
  { key: "all", label: "All", test: () => true, on: "bg-ink text-white", off: "border border-line-strong bg-card" },
  { key: "you", label: "Needs you", test: (d) => d.status === "WAITING_FOR_SELLER_RESPONSE" && d.draft_status !== "submitted", on: "bg-coral text-white", off: "border-2 border-coral bg-card" },
  { key: "ready", label: "Ready to approve", test: (d) => d.draft_status === "awaiting_approval" && d.status !== "RESOLVED", on: "bg-plum text-white", off: "border-2 border-plum bg-card" },
  { key: "finished", label: "Finished", test: (d) => !!d.clearable, on: "bg-steel text-white", off: "border-2 border-steel bg-card" },
];

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
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Filter disputes" className="flex flex-wrap gap-2">
          {FILTERS.map((f) => {
            const on = !showCleared && f.key === filter;
            return (
              <button key={f.key} role="tab" aria-selected={on}
                onClick={() => { setShowCleared(false); setFilter(f.key); }}
                className={`rounded-full px-4 py-1 text-xs font-bold tracking-wide transition active:scale-95 ${on ? f.on : f.off}`}>
                {f.label} ({(data ?? []).filter(f.test).length})
              </button>
            );
          })}
          <button role="tab" aria-selected={showCleared} onClick={() => setShowCleared(true)}
            className={`rounded-full px-4 py-1 text-xs font-bold tracking-wide transition active:scale-95 ${showCleared ? "bg-muted text-white" : "border border-line-strong bg-card"}`}>
            Cleared
          </button>
        </div>
        {!showCleared && finished > 0 && (
          <Button onClick={clearFinished} disabled={busy} className="text-xs">
            <Icon name="inventory_2" className="text-[16px]" /> Clear all finished ({finished})
          </Button>
        )}
      </div>

      {(error || cleared.error) && <p className="text-sm text-danger">{error ?? cleared.error}</p>}
      {(showCleared ? cleared.data : data) && items.length === 0 ? (
        <Empty icon={showCleared ? "inventory_2" : "inbox"} title={showCleared ? "Nothing cleared" : filter === "all" ? "No disputes" : "Nothing here"}>
          {!showCleared && filter === "all" && "When a buyer opens a dispute on PayPal, it appears here within 15 minutes, or right away if you press Sync."}
        </Empty>
      ) : (
        <DisputeTable items={items} onChanged={refresh} />
      )}
    </Card>
  );
}
