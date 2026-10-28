"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useState } from "react";

import { DisputeTable } from "@/components/DisputeTable";
import { Skeleton } from "@/components/motion";
import { Menu } from "@/components/overlay";
import { Card, Empty, Icon } from "@/components/ui";
import { api } from "@/lib/api";
import { money } from "@/lib/format";
import { useLive } from "@/lib/hooks";
import { isOpen } from "@/lib/studio/model";
import { useMoneyModel } from "@/lib/studio/useModel";
import type { DisputeSummary } from "@/lib/types";

const Board = dynamic(() => import("@/components/Board"), { ssr: false, loading: () => <Skeleton className="h-[380px]" /> });

const needsYou = (d: DisputeSummary) =>
  (d.status === "WAITING_FOR_SELLER_RESPONSE" && d.draft_status !== "submitted") || (d.draft_status === "awaiting_approval" && isOpen(d));

// Three questions a merchant actually asks; everything else lives behind the ⋯ menu.
const FILTERS: { key: string; label: string; test: (d: DisputeSummary) => boolean }[] = [
  { key: "you", label: "Needs you", test: needsYou },
  { key: "paypal", label: "With PayPal", test: (d) => isOpen(d) && !needsYou(d) },
  { key: "finished", label: "Finished", test: (d) => !isOpen(d) },
];

const tab = (on: boolean) =>
  `press inline-flex min-h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-4 text-[14px] transition ${
    on ? "bg-card font-semibold text-ink shadow-[0_1px_3px_rgb(54_33_62/0.1)]" : "font-medium text-ink-2 hover:text-ink"
  }`;

export default function DisputesPage() {
  const { model, overview, disputes, ready, currency } = useMoneyModel(90);
  const { data, error, reload } = disputes;
  const [showCleared, setShowCleared] = useState(false);
  const cleared = useLive<DisputeSummary[]>(showCleared ? "/disputes?cleared=true" : null);
  const [filter, setFilter] = useState<string | null>(null);

  const all = data ?? [];
  // Open on what needs the merchant, or on everything still open when nothing does.
  const key = filter ?? (all.some(needsYou) ? "you" : "paypal");
  const active = FILTERS.find((f) => f.key === key)!;
  const items = showCleared ? cleared.data ?? [] : all.filter(active.test);
  const finished = all.filter((d) => d.clearable).length;
  const cover = overview.data?.positions.find((p) => p.role === "dispute_buffer");

  async function clearFinished() {
    await api("/disputes/clear-finished", { method: "POST" });
    await reload();
  }
  const refresh = () => {
    reload();
    cleared.reload();
  };

  return (
    <div className="space-y-8">
      {/* The bridge to Jars: the money set aside for disputes, right above the disputes it covers. */}
      {overview.data && (
        <Link href={cover ? "/money/jars" : "/money/jars/accounts"} className="press group flex items-center gap-3 rounded-2xl bg-primary-fixed/60 px-5 py-3.5 text-[15px] text-ink-2 transition hover:bg-primary-fixed">
          <Icon name="shield" className="text-primary" />
          <span className="flex-1">
            {cover
              ? <><span className="font-semibold text-ink tabular-nums">{money(cover.balance, currency)}</span> is in your Dispute cover jar.</>
              : "No Dispute cover jar yet. Add one so refunds never come out of what you need today."}
          </span>
          <Icon name="chevron_right" className="text-muted transition group-hover:translate-x-0.5" />
        </Link>
      )}

      {ready && all.length > 0 && <Board id="disputes" data={model} />}

      <Card>
        <div className="mb-6 flex items-center justify-between gap-2">
          <div role="tablist" aria-label="Filter disputes" className="no-scrollbar inline-flex min-w-0 gap-1 overflow-x-auto rounded-full bg-soft p-1">
            {FILTERS.map((f) => (
              <button key={f.key} role="tab" aria-selected={!showCleared && f.key === key} onClick={() => { setShowCleared(false); setFilter(f.key); }} className={tab(!showCleared && f.key === key)}>
                {f.label}<span className="text-xs text-muted tabular-nums">{all.filter(f.test).length}</span>
              </button>
            ))}
            {showCleared && <button role="tab" aria-selected className={tab(true)}>Cleared</button>}
          </div>
          <Menu
            items={[
              { icon: "inventory_2", label: showCleared ? "Back to current disputes" : "Show cleared disputes", onSelect: () => setShowCleared((s) => !s) },
              ...(finished > 0 && !showCleared ? [{ icon: "done_all", label: `Clear all finished (${finished})`, onSelect: clearFinished }] : []),
            ]}
          />
        </div>

        {(error || cleared.error) && <p className="text-sm text-danger">{error ?? cleared.error}</p>}
        {!data ? (
          <div className="space-y-3"><Skeleton className="h-16" /><Skeleton className="h-16" /></div>
        ) : items.length === 0 ? (
          <Empty icon={showCleared ? "inventory_2" : key === "you" ? "task_alt" : "inbox"} title={showCleared ? "Nothing cleared" : key === "you" ? "Nothing needs you" : all.length ? "Nothing here" : "No disputes yet"}>
            {!showCleared && !all.length && "When a buyer opens a dispute on PayPal, it appears here within 15 minutes, or right away if you press Refresh."}
          </Empty>
        ) : (
          <DisputeTable items={items} onChanged={refresh} />
        )}
      </Card>
    </div>
  );
}
