import { studioTheme } from "ag-studio";
import { themeQuartz } from "ag-grid-community";

/** One look for every chart, tile and table in BundoPay: Studio boards and plain grids share these values,
 * so a table on Disputes and a table inside a board read as the same thing. */

export const PALETTE = { plum: "#554971", aqua: "#8ac6d0", slate: "#5a6c84", ice: "#b8f3ff" };

const grid = {
  fontFamily: "inherit",
  foregroundColor: "var(--color-ink)",
  backgroundColor: "var(--color-card)",
  accentColor: "var(--color-primary)",
  borderColor: "rgb(54 33 62 / 0.06)",
  headerBackgroundColor: "var(--color-card)",
  headerTextColor: "var(--color-muted)",
  headerFontSize: 13,
  headerFontWeight: 500,
  headerColumnBorder: false,
  rowHoverColor: "#f8fbfc",
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  cellHorizontalPadding: 16,
} as const;

/** The plain AG Grid theme used by lists the merchant acts on (disputes, activity, accounts). */
export const gridTheme = themeQuartz.withParams({ ...grid, fontSize: 14, rowHeight: 64, headerHeight: 40 });

/** Each widget is its own white card on the page background, like every other card in the app. */
export const boardTheme = studioTheme.withParams({
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
  // AG Studio defaults to a 600px/720px minimum, which pushes phones sideways; boards fit any width.
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
  chartPaletteFills1Color: PALETTE.plum,
  chartPaletteFills2Color: PALETTE.aqua,
  chartPaletteFills3Color: PALETTE.slate,
  chartPaletteFills4Color: PALETTE.ice,
  chartPaletteStrokes1Color: PALETTE.plum,
  chartPaletteStrokes2Color: PALETTE.aqua,
  chartPaletteStrokes3Color: PALETTE.slate,
  chartPaletteStrokes4Color: PALETTE.ice,
});
