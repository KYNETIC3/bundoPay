import type { AgReportState } from "ag-studio";

/** The curated boards. Each answers one question, with one hero and room to breathe; merchants can hide, reorder
 * or add to them, and Reset always brings this layout back. */

export type BoardId = "home" | "jars" | "disputes";
export type Columns = 2 | 4;

export const ROW_HEIGHT = 40;
/** Gap between widgets; AG Studio also uses it as the page's outer padding, which Board cancels with a negative margin. */
export const GAP = 16;

export type Widget = NonNullable<NonNullable<AgReportState["pages"][number]["widgets"]>[string]>;
type Place = { xTrack: number; yTrack: number; xSpan: number; ySpan: number };

const value = (title: string, caption: string, table: string, field: string, aggregation: "sum" | "avg" = "sum"): Widget => ({
  type: "value",
  dataMapping: { value: [{ id: `${table}.${field}`, aggregation }] },
  format: { title: { enabled: true, text: title, wrapping: true }, caption: { enabled: true, text: caption, wrapping: true }, crossFilter: "none" },
});

function page(id: BoardId, columns: Columns, widgets: Record<string, Widget>, layout: Record<string, Place>): AgReportState {
  return {
    selectedPageId: id,
    pages: [
      {
        id,
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
        widgets,
        widgetLayout: layout,
      },
    ],
  };
}

/** Lay widgets out top to bottom: each entry is [id, span on a 4-column board, rows]. Phones get two columns, so
 * anything narrower than the row goes half-width and anything wider goes full-width. */
function flow(columns: Columns, items: [string, 1 | 2 | 4, number][]): Record<string, Place> {
  const out: Record<string, Place> = {};
  let x = 0;
  let y = 0;
  let rowRows = 0;
  for (const [id, wide, rows] of items) {
    const span = columns === 4 ? wide : wide >= 2 ? 2 : 1;
    const r = columns === 2 && span === 1 ? rows + 1 : rows; // phone tiles are half as wide, so titles wrap
    if (x + span > columns) {
      y += rowRows;
      x = 0;
      rowRows = 0;
    }
    out[id] = { xTrack: x, yTrack: y, xSpan: span, ySpan: r };
    x += span;
    rowRows = Math.max(rowRows, r);
  }
  return out;
}

const curated: Record<BoardId, (c: Columns) => AgReportState> = {
  /** How's my money? */
  home: (c) =>
    page(
      "home",
      c,
      {
        atStake: value("At stake in disputes", "Open disputes, any age", "disputes", "at_stake"),
        handled: value("Handled by Bundo", "Disputes answered or refunded", "disputes", "handled", "avg"),
        stopped: value("Stopped by safety checks", "Transfers blocked or held for you", "transfers", "stopped"),
        trend: {
          // Columns, not an area: a few transfers on a few days still read clearly.
          type: "column-chart-stacked",
          dataMapping: { categoryKey: [{ id: "moved.day" }], valueKey: [{ id: "moved.amount", aggregation: "sum" }], legendKey: [{ id: "moved.jar" }] },
          sort: [{ field: { id: "moved.day" }, direction: "asc" }],
          format: { title: { enabled: true, text: "Money set aside, by jar" } },
        },
      },
      flow(c, [["atStake", 1, 4], ["handled", 1, 4], ["stopped", 2, 4], ["trend", 4, 8]]),
    ),

  /** Is my money where it should be? */
  jars: (c) =>
    page(
      "jars",
      c,
      {
        trend: {
          type: "column-chart-stacked",
          dataMapping: { categoryKey: [{ id: "moved.day" }], valueKey: [{ id: "moved.amount", aggregation: "sum" }], legendKey: [{ id: "moved.jar" }] },
          sort: [{ field: { id: "moved.day" }, direction: "asc" }],
          format: { title: { enabled: true, text: "Set aside each day, by jar" }, crossFilter: "filter" },
        },
      },
      flow(c, [["trend", 4, 8]]),
    ),

  /** What do I need to fight? */
  disputes: (c) =>
    page(
      "disputes",
      c,
      {
        atStake: value("At stake", "Across open disputes", "disputes", "at_stake"),
        open: value("Open", "Waiting on you, PayPal or the buyer", "disputes", "open"),
        reasons: {
          type: "bar-chart-grouped",
          dataMapping: { categoryKey: [{ id: "disputes.reason" }], valueKey: [{ id: "disputes.at_stake", aggregation: "sum" }] },
          format: { title: { enabled: true, text: "At stake, by reason" }, crossFilter: "filter" },
        },
      },
      flow(c, [["atStake", 1, 4], ["open", 1, 4], ["reasons", 2, 8]]),
    ),
};

/** The "no tracking number" card only appears once store data is uploaded, so an empty store adds no clutter. */
export function curatedBoard(id: BoardId, columns: Columns, extras: { store: boolean }): AgReportState {
  const state = curated[id](columns);
  if (id === "disputes" && extras.store) {
    const p = state.pages[0];
    p.widgets ??= {};
    p.widgetLayout ??= {};
    p.widgets.noTracking = value("Open, no tracking number", "Add tracking to answer these faster", "disputes", "no_tracking");
    const bottom = Math.max(...Object.values(p.widgetLayout).map((l) => (l ? l.yTrack + l.ySpan : 0)));
    p.widgetLayout.noTracking = { xTrack: 0, yTrack: bottom, xSpan: columns === 4 ? 1 : 2, ySpan: 4 };
  }
  return state;
}

export function rowsUsed(state: AgReportState): number {
  const page = state.pages.find((p) => p.id === state.selectedPageId) ?? state.pages[0];
  return Math.max(1, ...Object.values(page?.widgetLayout ?? {}).map((l) => (l ? l.yTrack + l.ySpan : 0)));
}

const key = (id: BoardId) => `bundo.board.${id}.v2`;

export function savedBoard(id: BoardId): AgReportState | undefined {
  try {
    const raw = localStorage.getItem(key(id));
    return raw ? (JSON.parse(raw) as AgReportState) : undefined;
  } catch {
    return undefined;
  }
}

export function saveBoard(id: BoardId, state: AgReportState | null) {
  try {
    if (state) localStorage.setItem(key(id), JSON.stringify(state));
    else localStorage.removeItem(key(id));
  } catch {}
  window.dispatchEvent(new CustomEvent("board-changed", { detail: id }));
}

/** Add a widget Ask Bundo built to a board, under everything already there. */
export function pinToBoard(id: BoardId, widget: Widget, columns: Columns = 4) {
  const state = savedBoard(id) ?? curatedBoard(id, columns, { store: false });
  const p = state.pages.find((x) => x.id === state.selectedPageId) ?? state.pages[0];
  p.widgets ??= {};
  p.widgetLayout ??= {};
  const wid = `pinned-${Date.now().toString(36)}`;
  p.widgets[wid] = widget;
  p.widgetLayout[wid] = { xTrack: 0, yTrack: rowsUsed(state), xSpan: p.layout?.columns ?? columns, ySpan: 8 };
  saveBoard(id, state);
}
