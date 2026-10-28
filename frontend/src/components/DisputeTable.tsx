"use client";

import { AllCommunityModule, ModuleRegistry, type ColDef, type ICellRendererParams, type PostSortRowsParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import Link from "next/link";
import { useMemo, useRef } from "react";

import { api } from "@/lib/api";
import { money } from "@/lib/format";
import { useNarrow } from "@/lib/hooks";
import { agentState, disputeStatus } from "@/lib/status";
import { gridTheme } from "@/lib/studio/theme";
import type { DisputeSummary } from "@/lib/types";

import { Countdown } from "./Countdown";
import { Button, Icon, Pill } from "./ui";

ModuleRegistry.registerModules([AllCommunityModule]);


/** What row buttons can do; passed to cells through the grid's context so the column defs stay static. */
type Ctx = { act: (id: string, what: "clear" | "restore") => void };
type Cell = ICellRendererParams<DisputeSummary, unknown, Ctx>;

const isOpen = (d: DisputeSummary) => d.status !== "RESOLVED";

/** Whole days since PayPal opened the dispute. */
function ageDays(d: DisputeSummary): number | null {
  if (!d.opened_at) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(d.opened_at).getTime()) / 86_400_000));
}

const columns: ColDef<DisputeSummary>[] = [
  {
    headerName: "Dispute",
    colId: "dispute",
    valueGetter: (p) => p.data?.reason_label ?? "Dispute",
    pinned: "left",
    minWidth: 200,
    flex: 2,
    cellRenderer: ({ data: d }: Cell) =>
      d && (
        <div className="flex h-full flex-col justify-center leading-tight">
          <Link href={`/money/disputes/${d.id}`} className="font-semibold text-ink hover:text-primary">{d.reason_label ?? "Dispute"}</Link>
          <span className="mt-1 text-xs text-muted">{d.paypal_dispute_id}</span>
        </div>
      ),
  },
  {
    headerName: "Amount",
    colId: "amount",
    valueGetter: (p) => (p.data?.amount != null ? Number(p.data.amount) : null),
    type: "rightAligned",
    width: 120,
    cellRenderer: ({ data: d }: Cell) => d && <span className="font-semibold tabular-nums">{money(d.amount, d.currency)}</span>,
  },
  {
    headerName: "Status",
    colId: "status",
    valueGetter: (p) => (p.data ? disputeStatus(p.data.status).label : ""),
    width: 160,
    cellRenderer: ({ data: d }: Cell) => {
      if (!d) return null;
      const s = disputeStatus(d.status);
      return <Pill tone={s.tone}>{s.label}</Pill>;
    },
  },
  {
    headerName: "Deadline",
    colId: "deadline",
    valueGetter: (p) => (p.data && isOpen(p.data) && p.data.due_date ? new Date(p.data.due_date).getTime() : null),
    sort: "asc",
    width: 150,
    cellRenderer: ({ data: d }: Cell) => d && (isOpen(d) ? <Countdown due={d.due_date} /> : <span className="text-muted">—</span>),
  },
  {
    headerName: "Age",
    colId: "age",
    valueGetter: (p) => (p.data ? ageDays(p.data) : null),
    width: 90,
    cellRenderer: ({ data: d, value }: ICellRendererParams<DisputeSummary, number | null, Ctx>) =>
      d && (value == null ? (
        <span className="text-muted">—</span>
      ) : (
        <span className="text-[13px] tabular-nums text-muted" title={`Opened ${new Date(d.opened_at!).toLocaleString()}`}>
          {value}d
        </span>
      )),
  },
  {
    headerName: "Bundo",
    colId: "agent",
    valueGetter: (p) => (p.data ? agentState({ status: p.data.status, draft_status: p.data.draft_status ?? null, draft_action: p.data.draft_action ?? null }).label : ""),
    width: 160,
    cellRenderer: ({ data: d }: Cell) => {
      if (!d) return null;
      const a = agentState({ status: d.status, draft_status: d.draft_status ?? null, draft_action: d.draft_action ?? null });
      return <Pill tone={a.tone}>{a.label}</Pill>;
    },
  },
  {
    headerName: "",
    colId: "action",
    sortable: false,
    width: 200,
    cellClass: "flex items-center justify-end",
    cellRenderer: ({ data: d, context }: Cell) => {
      if (!d) return null;
      const ready = d.draft_status === "awaiting_approval" && isOpen(d);
      return (
        <div className="inline-flex items-center gap-1.5">
          {d.cleared ? (
            <Button onClick={() => context.act(d.id, "restore")} variant="ghost" className="min-h-8 text-[13px]">
              <Icon name="unarchive" className="text-[16px]" /> Restore
            </Button>
          ) : d.clearable ? (
            <Button onClick={() => context.act(d.id, "clear")} variant="ghost" className="min-h-8 text-[13px]">
              <Icon name="inventory_2" className="text-[16px]" /> Clear
            </Button>
          ) : null}
          {ready ? (
            <Button variant="primary" href={`/money/disputes/${d.id}/approve`} className="min-h-8 px-3.5 text-[13px]">Review</Button>
          ) : (
            <Button href={`/money/disputes/${d.id}`} className="min-h-8 px-3.5 text-[13px]">Open</Button>
          )}
        </div>
      );
    },
  },
];

/** Whatever column the merchant sorts by, unresolved disputes stay above closed ones. */
function unresolvedFirst({ nodes }: PostSortRowsParams<DisputeSummary>) {
  const open = nodes.filter((n) => n.data && isOpen(n.data));
  const closed = nodes.filter((n) => !n.data || !isOpen(n.data));
  nodes.splice(0, nodes.length, ...open, ...closed);
}

export function DisputeTable({ items, onChanged }: { items: DisputeSummary[]; onChanged?: () => void }) {
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const pending = useRef(new Set<string>());
  // Stable, because the grid reads its context once.
  const context = useMemo<Ctx>(
    () => ({
      act: async (id, what) => {
        if (pending.current.has(id)) return;
        pending.current.add(id);
        try {
          await api(`/disputes/${id}/${what}`, { method: "POST" });
          changed.current?.();
          window.dispatchEvent(new CustomEvent("disputes-synced"));
        } finally {
          pending.current.delete(id);
        }
      },
    }),
    [],
  );
  const narrow = useNarrow();
  if (narrow) return <DisputeCards items={items} act={context.act} />;
  return (
    <div className="-mx-7">
      <AgGridReact<DisputeSummary>
        theme={gridTheme}
        rowData={items}
        columnDefs={columns}
        context={context}
        defaultColDef={{ sortable: true, resizable: false, suppressMovable: true, cellClass: "flex items-center" }}
        getRowId={(p) => p.data.id}
        postSortRows={unresolvedFirst}
        rowClassRules={{ "opacity-60": (p) => !!p.data && !isOpen(p.data) }}
        domLayout="autoHeight"
        suppressCellFocus
      />
    </div>
  );
}

/** Phones get one card per dispute instead of a wide table: what it's about, how much, how long is left, and
 * the one thing to do next. */
function DisputeCards({ items, act }: { items: DisputeSummary[]; act: Ctx["act"] }) {
  const sorted = [...items].sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)) || (a.due_date ?? "~").localeCompare(b.due_date ?? "~"));
  return (
    <ul className="-mx-1 divide-y divide-ink/[0.06]">
      {sorted.map((d) => {
        const agent = agentState({ status: d.status, draft_status: d.draft_status ?? null, draft_action: d.draft_action ?? null });
        // When Bundo has nothing to say yet, the PayPal status is the useful one.
        const a = agent.label === "—" ? disputeStatus(d.status) : agent;
        const ready = d.draft_status === "awaiting_approval" && isOpen(d);
        return (
          <li key={d.id} className={`flex items-start gap-3 px-2 py-4 ${isOpen(d) ? "" : "opacity-60"}`}>
            <Link href={ready ? `/money/disputes/${d.id}/approve` : `/money/disputes/${d.id}`} className="press min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-3">
                <span className="truncate font-semibold">{d.reason_label ?? "Dispute"}</span>
                <span className="shrink-0 font-semibold tabular-nums">{money(d.amount, d.currency)}</span>
              </span>
              <span className="mt-2 flex flex-wrap items-center gap-2">
                <Pill tone={a.tone}>{a.label}</Pill>
                {isOpen(d) && d.due_date && <span className="text-[13px]"><Countdown due={d.due_date} /></span>}
              </span>
            </Link>
            {d.clearable && !d.cleared && (
              <button onClick={() => act(d.id, "clear")} aria-label="Clear" className="grid h-10 w-10 place-items-center rounded-full text-muted hover:bg-soft"><Icon name="inventory_2" className="text-[18px]" /></button>
            )}
            {d.cleared && (
              <button onClick={() => act(d.id, "restore")} aria-label="Restore" className="grid h-10 w-10 place-items-center rounded-full text-muted hover:bg-soft"><Icon name="unarchive" className="text-[18px]" /></button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function unresolvedCount(items: DisputeSummary[] | null | undefined): number {
  return (items ?? []).filter(isOpen).length;
}
