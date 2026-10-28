"use client";

import { type AgDataSourcesDefinition, type AgReportState, enableStudioDevValidations } from "ag-studio";
import { AgStudio, AgStudioProvider } from "ag-studio-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { type BoardId, type Columns, GAP, ROW_HEIGHT, curatedBoard, forPhone, rowsUsed, saveBoard, savedBoard } from "@/lib/studio/boards";
import { boardTheme } from "@/lib/studio/theme";

if (process.env.NODE_ENV !== "production") enableStudioDevValidations();

// Viewers get a clean board; the field and widget panels only appear while customising.
const PANELS = { view: { left: [] }, edit: { left: ["data" as const], right: ["edit" as const] } };

/** Customising opens with the field list folded to its chevron: it's only needed to add a widget, and two open
 * panels squeeze the widgets being arranged. Its chevron opens it whenever it's wanted. */
const dataTucked = (s: AgReportState): AgReportState => ({ ...s, panels: { ...s.panels, data: { ...s.panels?.data, collapsed: true } } });

export type BoardProps = {
  id: BoardId;
  data: AgDataSourcesDefinition;
  editing?: boolean;
  /** Bumped by the page's Reset; restores the curated layout. */
  resetSignal?: number;
  /** A one-off state (an Ask Bundo preview); never saved. */
  state?: AgReportState;
  height?: number;
};

/** The one AG Studio wrapper. Every money screen is a Board over the same data model, so a tile on Home and a
 * tile on Jars look and behave the same. The board is exactly as tall as its widgets, so it sits in the page
 * like any other card. */
export default function Board({ id, data, editing = false, resetSignal = 0, state, height }: BoardProps) {
  const studio = useRef<AgStudio>(null);
  // Phones get two columns; the four-column layout is the one merchants customise and save.
  const [columns] = useState<Columns>(() => (typeof window !== "undefined" && window.innerWidth < 640 ? 2 : 4));
  const [initialState] = useState(() => {
    if (state) return state;
    const saved = savedBoard(id);
    if (saved) return columns === 4 ? saved : forPhone(saved);
    return curatedBoard(id, columns);
  });
  const [rows, setRows] = useState(() => rowsUsed(initialState));

  const onStateUpdated = useCallback(
    (e: { state: AgReportState }) => {
      setRows(rowsUsed(e.state));
      if (editing && !state) saveBoard(id, e.state);
    },
    [editing, id, state],
  );

  // Only a real click resets: comparing values (not a first-run flag) survives React's double-run of effects in dev.
  const appliedReset = useRef(resetSignal);
  useEffect(() => {
    if (resetSignal === appliedReset.current) return;
    appliedReset.current = resetSignal;
    saveBoard(id, null);
    studio.current?.api?.setState(dataTucked(curatedBoard(id, columns)));
  }, [resetSignal, columns, id]);

  // AG Studio rebuilds its panels on entering edit mode, so the fold is applied as customising starts.
  useEffect(() => {
    const api = studio.current?.api;
    if (editing && api) api.setState(dataTucked(api.getState()));
  }, [editing]);

  // A chart pinned from Ask Bundo, or a change in another tab, shows up without a reload.
  useEffect(() => {
    if (state) return;
    const onChange = (e: Event) => {
      const next = (e as CustomEvent<BoardId>).detail === id && savedBoard(id);
      if (next && !editing) studio.current?.api?.setState(columns === 4 ? next : forPhone(next));
    };
    window.addEventListener("board-changed", onChange);
    return () => window.removeEventListener("board-changed", onChange);
  }, [id, editing, state, columns]);

  return (
    <div
      style={{ height: height ?? (editing ? 680 : rows * ROW_HEIGHT + 2 * GAP), margin: editing ? 0 : -GAP }}
      className="board rise transition-[height] duration-300 motion-reduce:transition-none">
      <AgStudioProvider licenseKey={process.env.NEXT_PUBLIC_AG_STUDIO_LICENSE}>
        <AgStudio
          ref={studio}
          theme={boardTheme}
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
