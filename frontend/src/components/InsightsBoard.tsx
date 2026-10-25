"use client";

import { type AgDataSourcesDefinition, type AgReportState, enableStudioDevValidations, studioTheme } from "ag-studio";
import { AgStudio, AgStudioProvider } from "ag-studio-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ROLE_LABELS, type Insights } from "@/lib/treasury";
import type { DisputeSummary } from "@/lib/types";

if (process.env.NODE_ENV !== "production") enableStudioDevValidations();

const STORAGE_KEY = "bundo.insights.v1";
const ROW_HEIGHT = 40;
const KPI_ROWS = 4;
const CHART_ROWS = 8;
/** Gap between widgets; AG Studio also uses it as the page's outer padding, which we cancel with a negative margin. */
const GAP = 16;

/** Matches the app: each widget is its own white card on the page background, like the summary cards it replaces. */
const theme = studioTheme.withParams({
  fontFamily: "inherit",
  backgroundColor: "var(--color-card)",
  foregroundColor: "var(--color-ink)",
  accentColor: "var(--color-primary)",
  borderColor: "var(--color-line)",
  studioWrapperBackgroundColor: "transparent",
  studioWrapperBorder: false,
  studioWrapperSpacing: 0,
  studioCanvasBackgroundColor: "transparent",
  studioCanvasPadding: 0,
  // AG Studio defaults to a 600px/720px minimum, which pushes phones sideways; the board fits any width.
  studioMinWidth: 0,
  studioMinHeight: 0,
  studioCanvasMinWidth: 280,
  studioCanvasBorder: false,
  studioCanvasShadow: "none",
  studioWidgetBackgroundColor: "var(--color-card)",
  studioWidgetBorder: false,
  studioWidgetBorderRadius: 20,
  studioWidgetTitleFontSize: 14,
  studioWidgetCaptionTextColor: "var(--color-muted)",
  chartPaletteFills1Color: "#554971",
  chartPaletteFills2Color: "#8ac6d0",
  chartPaletteFills3Color: "#5a6c84",
  chartPaletteFills4Color: "#b8f3ff",
  chartPaletteStrokes1Color: "#554971",
  chartPaletteStrokes2Color: "#8ac6d0",
  chartPaletteStrokes3Color: "#5a6c84",
  chartPaletteStrokes4Color: "#b8f3ff",
});

// Viewers get a clean board; the field and widget panels only appear after Customize.
const PANELS = { view: { left: [] }, edit: { left: ["data" as const], right: ["edit" as const] } };

const kpi = (title: string, caption: string, id: string, aggregation: "sum" | "avg") => ({
  type: "value" as const,
  dataMapping: { value: [{ id, aggregation }] },
  format: { title: { enabled: true, text: title, wrapping: true }, caption: { enabled: true, text: caption, wrapping: true }, crossFilter: "none" as const },
});

/** The curated board: four KPIs, then one trend. Every number answers a question the balance above doesn't. */
function curated(columns: 2 | 4): AgReportState {
  const wide = columns === 4;
  // Phone tiles are half as wide, so their titles wrap; give them an extra row.
  const kpiRows = wide ? KPI_ROWS : KPI_ROWS + 1;
  const tile = (i: number) => ({ xTrack: wide ? i : i % 2, yTrack: wide ? 0 : Math.floor(i / 2) * kpiRows, xSpan: 1, ySpan: kpiRows });
  return {
    selectedPageId: "insights",
    pages: [
      {
        id: "insights",
        // Each widget is its own white card on the page background, like the summary cards it replaces.
        layout: {
          columns,
          rowHeight: ROW_HEIGHT,
          minWidth: 280,
          pagePadding: 0,
          backgroundColor: "transparent",
          widgetBackgroundColor: "#ffffff",
          widgetBorderEnabled: false,
          widgetBorderRadius: 20,
          widgetPadding: GAP,
        },
        widgets: {
          atStake: kpi("At stake in disputes", "Open disputes, any age", "disputes.at_stake", "sum"),
          setAside: kpi("Set aside", "Moved into your reserves", "movements.set_aside", "sum"),
          handled: kpi("Handled by Bundo", "Disputes Bundo answered or refunded", "disputes.handled", "avg"),
          stopped: kpi("Stopped by safety checks", "Transfers blocked or held for you", "movements.stopped", "sum"),
          trend: {
            // Columns, not an area: a few transfers on a few days still read clearly.
            type: "column-chart-stacked",
            dataMapping: {
              categoryKey: [{ id: "reserves.day" }],
              valueKey: [{ id: "reserves.amount", aggregation: "sum" }],
              legendKey: [{ id: "reserves.reserve" }],
            },
            sort: [{ field: { id: "reserves.day" }, direction: "asc" }],
            format: { title: { enabled: true, text: "Money set aside, by reserve" } },
          },
        },
        widgetLayout: {
          atStake: tile(0),
          setAside: tile(1),
          handled: tile(2),
          stopped: tile(3),
          trend: { xTrack: 0, yTrack: wide ? kpiRows : kpiRows * 2, xSpan: columns, ySpan: CHART_ROWS },
        },
      },
    ],
  };
}

const DAY = 86_400_000;
const isOpen = (d: DisputeSummary) => d.status !== "RESOLVED";

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** A zero for every day in the range, so the axis shows the whole period rather than one wide bar. */
function quietDays(days: number, reserve: string | undefined) {
  if (!reserve) return [];
  const today = startOfDay(new Date());
  return Array.from({ length: days }, (_, i) => ({ day: new Date(today.getFullYear(), today.getMonth(), today.getDate() - i), reserve, amount: 0 }));
}

function sources(disputes: DisputeSummary[], insights: Insights, days: number, autoRefunded: Set<string>, currency: string): AgDataSourcesDefinition {
  // Excel-style format strings; AG Studio's validator rejects Intl objects here.
  const symbol = new Intl.NumberFormat("en", { style: "currency", currency }).formatToParts(0).find((p) => p.type === "currency")?.value ?? "$";
  const cash = { format: `"${symbol}"#,##0` };
  const since = Date.now() - days * DAY;
  const inRange = (at: string | null) => !!at && new Date(at).getTime() >= since;
  // Allowed and on its way or landed; blocked and failed moves never left the operating account.
  const setAside = (m: Insights["movements"][number]) =>
    m.role && m.role !== "operating" && ["executing", "unconfirmed", "succeeded"].includes(m.status) ? Number(m.amount) : 0;
  const moves = insights.movements.filter((m) => inRange(m.created_at));
  const moved = moves
    .filter((m) => setAside(m) > 0)
    .map((m) => ({ day: startOfDay(new Date(m.created_at)), reserve: ROLE_LABELS[m.role!], amount: setAside(m) }));
  return {
    sources: [
      {
        id: "disputes",
        name: "Disputes",
        // Open ones count however old they are (money is at stake today); closed ones only within the range.
        data: disputes
          .filter((d) => isOpen(d) || inRange(d.opened_at))
          .map((d) => ({
            reason: d.reason_label ?? "Other",
            at_stake: isOpen(d) ? Number(d.amount ?? 0) : 0,
            handled: d.draft_status === "submitted" || autoRefunded.has(d.id) ? 1 : 0,
          })),
        fields: [
          { id: "reason", name: "Reason", format: "textFormat" },
          { id: "at_stake", name: "At stake", format: "currencyFormat", formatOptions: cash },
          { id: "handled", name: "Handled by Bundo", format: "percentageFormat", formatOptions: { format: "0%" } },
        ],
      },
      {
        id: "movements",
        name: "Transfers",
        data: moves.map((m) => ({
          set_aside: setAside(m),
          stopped: m.verdict === "block" || m.verdict === "ask" ? 1 : 0,
        })),
        fields: [
          { id: "set_aside", name: "Set aside", format: "currencyFormat", formatOptions: cash },
          { id: "stopped", name: "Stopped", format: "integerFormat" },
        ],
      },
      {
        id: "reserves",
        name: "Money set aside",
        // Only money that moved, so the legend lists reserves that actually received something.
        data: [...moved, ...quietDays(days, moved[0]?.reserve)],
        fields: [
          { id: "day", name: "Day", format: "dateFormat", formatOptions: { format: "d mmm" } },
          { id: "reserve", name: "Reserve", format: "textFormat" },
          { id: "amount", name: "Amount", format: "currencyFormat", formatOptions: cash },
        ],
      },
    ],
  };
}

function rowsUsed(state: AgReportState): number {
  const page = state.pages.find((p) => p.id === state.selectedPageId) ?? state.pages[0];
  return Math.max(1, ...Object.values(page?.widgetLayout ?? {}).map((l) => (l ? l.yTrack + l.ySpan : 0)));
}

function saved(): AgReportState | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AgReportState) : undefined;
  } catch {
    return undefined;
  }
}

export type InsightsBoardProps = {
  currency: string;
  disputes: DisputeSummary[];
  insights: Insights;
  days: number;
  editing: boolean;
  /** Bumped by the page's Reset button; restores the curated layout. */
  resetSignal: number;
};

export default function InsightsBoard({ currency, disputes, insights, days, editing, resetSignal }: InsightsBoardProps) {
  const studio = useRef<AgStudio>(null);
  // Phones get a 2×2 tile layout; only the wide layout can be customised and saved.
  const [columns] = useState<2 | 4>(() => (typeof window !== "undefined" && window.innerWidth < 640 ? 2 : 4));
  const [initialState] = useState(() => (columns === 4 && saved()) || curated(columns));
  const autoRefunded = useMemo(() => new Set(insights.auto_refunded), [insights.auto_refunded]);
  const data = useMemo(() => sources(disputes, insights, days, autoRefunded, currency), [disputes, insights, days, autoRefunded, currency]);

  // The board is exactly as tall as its widgets, so a customised layout is never clipped or padded.
  const [rows, setRows] = useState(() => rowsUsed(initialState));
  const onStateUpdated = useCallback(
    (e: { state: AgReportState }) => {
      setRows(rowsUsed(e.state));
      if (!editing) return;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(e.state));
      } catch {}
    },
    [editing],
  );

  // Only a real click resets: comparing values (not a first-run flag) survives React's double-run of effects in dev.
  const appliedReset = useRef(resetSignal);
  useEffect(() => {
    if (resetSignal === appliedReset.current) return;
    appliedReset.current = resetSignal;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
    studio.current?.api?.setState(curated(columns));
  }, [resetSignal, columns]);

  return (
    <div
      style={{ height: editing ? 680 : rows * ROW_HEIGHT + 2 * GAP, margin: editing ? 0 : -GAP }}
      className="insights-board transition-[height] duration-300 motion-reduce:transition-none">
      <AgStudioProvider licenseKey={process.env.NEXT_PUBLIC_AG_STUDIO_LICENSE}>
        <AgStudio
          ref={studio}
          theme={theme}
          data={data}
          initialState={initialState}
          mode={editing ? "edit" : "view"}
          panels={PANELS}
          onStateUpdated={onStateUpdated}
          style={{ height: "100%", width: "100%" }}
        />
      </AgStudioProvider>
    </div>
  );
}
