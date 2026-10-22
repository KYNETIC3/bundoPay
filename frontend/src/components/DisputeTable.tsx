"use client";

import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type ICellRendererParams, type PostSortRowsParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import Link from "next/link";

import { money } from "@/lib/format";
import { agentState, disputeStatus } from "@/lib/status";
import type { DisputeSummary } from "@/lib/types";

import { Countdown } from "./Countdown";
import { Button, Pill } from "./ui";

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({
  fontFamily: "inherit",
  fontSize: 14,
  foregroundColor: "var(--color-ink)",
  backgroundColor: "var(--color-card)",
  accentColor: "var(--color-primary)",
  borderColor: "var(--color-line)",
  headerBackgroundColor: "var(--color-soft)",
  headerTextColor: "var(--color-ink-2)",
  headerFontSize: 11,
  headerFontWeight: 700,
  rowHoverColor: "var(--color-cream)",
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  rowHeight: 58,
  headerHeight: 38,
  cellHorizontalPadding: 14,
});

type Cell = ICellRendererParams<DisputeSummary>;

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
          <Link href={`/disputes/${d.id}`} className="font-medium hover:underline">{d.reason_label ?? "Dispute"}</Link>
          <span className="font-mono text-[11px] text-muted">{d.paypal_dispute_id}</span>
        </div>
      ),
  },
  {
    headerName: "Amount",
    colId: "amount",
    valueGetter: (p) => (p.data?.amount != null ? Number(p.data.amount) : null),
    type: "rightAligned",
    width: 120,
    cellRenderer: ({ data: d }: Cell) => d && <span className="font-mono font-semibold tabular-nums">{money(d.amount, d.currency)}</span>,
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
    cellRenderer: ({ data: d, value }: Cell) =>
      d && (value == null ? (
        <span className="text-muted">—</span>
      ) : (
        <span className="font-mono text-xs tabular-nums text-ink-2" title={`Opened ${new Date(d.opened_at!).toLocaleString()}`}>
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
    width: 100,
    cellClass: "flex items-center justify-end",
    cellRenderer: ({ data: d }: Cell) => {
      if (!d) return null;
      const ready = d.draft_status === "awaiting_approval" && isOpen(d);
      return ready ? (
        <Button variant="primary" href={`/disputes/${d.id}/approve`} className="px-2.5 py-1 text-xs">Review</Button>
      ) : (
        <Button href={`/disputes/${d.id}`} className="px-2.5 py-1 text-xs">Open</Button>
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

export function DisputeTable({ items }: { items: DisputeSummary[] }) {
  return (
    <div className="-mx-5 border-y border-line">
      <AgGridReact<DisputeSummary>
        theme={theme}
        rowData={items}
        columnDefs={columns}
        defaultColDef={{ sortable: true, resizable: false, suppressMovable: true, cellClass: "flex items-center", headerClass: "uppercase tracking-wider" }}
        getRowId={(p) => p.data.id}
        postSortRows={unresolvedFirst}
        rowClassRules={{ "opacity-60": (p) => !!p.data && !isOpen(p.data) }}
        domLayout="autoHeight"
        suppressCellFocus
      />
    </div>
  );
}

export function unresolvedCount(items: DisputeSummary[] | null | undefined): number {
  return (items ?? []).filter(isOpen).length;
}
