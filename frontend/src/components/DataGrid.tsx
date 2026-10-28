"use client";

import { AllCommunityModule, type ColDef, type GridApi, type GridReadyEvent, ModuleRegistry, type ValueGetterParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useCallback, useId, useMemo, useRef, useState } from "react";

import { useNarrow } from "@/lib/hooks";
import { gridTheme } from "@/lib/studio/theme";
import { downloadCsv } from "@/lib/treasury";

import { Button, Icon } from "./ui";

ModuleRegistry.registerModules([AllCommunityModule]);

export type DataGridProps<T> = {
  /** What the grid holds, in a few words ("Your ledger"). It names the grid for screen readers and the search box. */
  label: string;
  rows: T[];
  columns: ColDef<T>[];
  getRowId: (row: T) => string;
  /** How one row reads on a phone, where a wide grid would scroll sideways. */
  card: (row: T) => React.ReactNode;
  /** CSV file name, without the date or extension. */
  csvName: string;
  /** Controls that sit beside the search box, such as an "Only problems" toggle. */
  toolbar?: React.ReactNode;
  /** Shown instead of the whole grid when there are no rows at all. */
  empty?: React.ReactNode;
  /** Shown inside the grid when rows exist but none are shown, e.g. a toggle filtered them all out. */
  noRowsText?: string;
};

/** The one AG Grid wrapper for reading records: sortable columns, a labelled search, CSV download, and a card list
 * on phones. Cells stay focusable so the grid works with arrow keys and screen readers, as AG Grid intends. */
export function DataGrid<T>({ label, rows, columns, getRowId, card, csvName, toolbar, empty, noRowsText = "Nothing to show." }: DataGridProps<T>) {
  const narrow = useNarrow();
  const searchId = useId();
  const [query, setQuery] = useState("");
  const api = useRef<GridApi<T> | null>(null);
  const [shown, setShown] = useState(rows.length);

  const onGridReady = useCallback(
    (e: GridReadyEvent<T>) => {
      api.current = e.api;
      // AG Grid has no option for the grid's accessible name, so it's set on its grid role element.
      const root = document.querySelector(`[data-grid="${CSS.escape(searchId)}"] [role="grid"], [data-grid="${CSS.escape(searchId)}"] [role="treegrid"]`);
      root?.setAttribute("aria-label", label);
    },
    [label, searchId],
  );

  const cardRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => columns.some((c) => String(cellValue(c, r) ?? "").toLowerCase().includes(q)));
  }, [rows, columns, query]);

  const count = narrow ? cardRows.length : query ? shown : rows.length;
  const file = `bundopay-${csvName}-${new Date().toISOString().slice(0, 10)}.csv`;

  function download() {
    if (!narrow && api.current) return api.current.exportDataAsCsv({ fileName: file });
    // Phones have no grid; build the same columns from the rows shown.
    const cols = columns.filter((c) => c.headerName);
    downloadCsv(file, [cols.map((c) => c.headerName!), ...cardRows.map((r) => cols.map((c) => String(cellValue(c, r) ?? "")))]);
  }

  if (!rows.length && empty) return <>{empty}</>;

  return (
    <div role="region" aria-label={label}>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-[200px] flex-1">
          <label htmlFor={searchId} className="mb-1.5 block text-[13px] font-medium text-ink-2">Search {label.toLowerCase()}</label>
          <div className="relative">
            <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-muted" />
            <input
              id={searchId}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="min-h-10 w-full rounded-full bg-card pl-9 pr-4 text-sm ring-1 ring-inset ring-ink/30 placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
        </div>
        {toolbar}
        <Button onClick={download}><Icon name="download" className="text-[18px]" /> Download CSV</Button>
      </div>
      <p className="sr-only" aria-live="polite">{query ? `${count} ${count === 1 ? "row" : "rows"} match` : ""}</p>
      {narrow ? (
        cardRows.length ? (
          <ul className="-mx-1 divide-y divide-ink/[0.06]">
            {cardRows.map((r) => <li key={getRowId(r)} className="px-2 py-4">{card(r)}</li>)}
          </ul>
        ) : (
          <p className="py-4 text-sm text-muted">{query ? <>Nothing matches &ldquo;{query}&rdquo;.</> : noRowsText}</p>
        )
      ) : (
        <div className="-mx-5 sm:-mx-7" data-grid={searchId}>
          <AgGridReact<T>
            theme={gridTheme}
            rowData={rows}
            columnDefs={columns}
            defaultColDef={{ sortable: true, resizable: true, suppressMovable: true, cellClass: "flex items-center" }}
            getRowId={(p) => getRowId(p.data)}
            quickFilterText={query}
            onGridReady={onGridReady}
            onModelUpdated={(e) => setShown(e.api.getDisplayedRowCount())}
            overlayNoRowsTemplate={noRowsText.replace(/[<>&]/g, "")}
            domLayout="autoHeight"
            ensureDomOrder
          />
        </div>
      )}
    </div>
  );
}

/** A column's value for a row, the way the grid would read it; used for phone search and CSV. */
function cellValue<T>(c: ColDef<T>, row: T): unknown {
  const raw = typeof c.valueGetter === "function" ? c.valueGetter({ data: row } as ValueGetterParams<T>) : c.field ? (row as Record<string, unknown>)[c.field as string] : undefined;
  return typeof c.valueFormatter === "function" ? c.valueFormatter({ value: raw, data: row } as Parameters<typeof c.valueFormatter>[0]) : raw;
}
