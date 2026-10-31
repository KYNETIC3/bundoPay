"use client";

import { type AgAiPromptStarter, type AgDataSourcesDefinition, type AgReportState, AgStudioAiModule, createAiHarness } from "ag-studio";
import { AgStudio, AgStudioProvider } from "ag-studio-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { feedback } from "@/lib/feedback";
import { bundoAdapter } from "@/lib/studio/adapter";
import { AI_GRID_COLUMNS, type BoardId, GAP, ROW_HEIGHT, type Widget, pinToBoard, saveBoard } from "@/lib/studio/boards";
import { describeChart } from "@/lib/studio/describe";
import { boardTheme } from "@/lib/studio/theme";
import { useMoneyModel } from "@/lib/studio/useModel";

import { SuccessTick } from "./motion";
import { Button, Icon, Segmented, SendButton } from "./ui";

const EMPTY: AgReportState = {
  selectedPageId: "preview",
  pages: [{ id: "preview", layout: { columns: 1, rowHeight: 40, pagePadding: 0, backgroundColor: "transparent", widgetBackgroundColor: "#ffffff", widgetBorderEnabled: false, widgetBorderRadius: 20, widgetPadding: 16 }, widgets: {}, widgetLayout: {} }],
};

const STARTERS = ["Disputes by reason this month", "Money set aside each week, by jar", "Transfers stopped by safety checks"];

const BOARD_NAMES: Record<BoardId, string> = { home: "Home", jars: "Jars", disputes: "Disputes" };

type Mode = "quick" | "dashboard";
const MODES: { href: Mode; label: string }[] = [{ href: "quick", label: "Quick chart" }, { href: "dashboard", label: "Build a dashboard" }];

/** Each starter answers one of the questions a seller with disputes actually asks. */
const DASHBOARD_STARTERS: AgAiPromptStarter[] = [
  { label: "Where am I losing disputes?", prompt: "Build a dashboard showing where I'm losing disputes: win rate, lost disputes by reason, and evidence coverage by reason." },
  { label: "How much money is at risk this week?", prompt: "Build a dashboard of money at risk this week: net exposure, disputes due in 48 hours, and at stake by reason." },
  { label: "Is my dispute buffer enough?", prompt: "Build a dashboard comparing what's at stake in open disputes with what my Dispute cover jar already covers, by reason." },
];

/** A blank page styled like the curated boards, so whatever the assistant builds can become one. It has the
 * assistant's 24 columns: on the boards' four, its layouts came out six times wider than the canvas and all but one
 * chart was clipped. */
const BLANK_DASHBOARD: AgReportState = {
  selectedPageId: "dashboard",
  pages: [
    {
      id: "dashboard",
      layout: { columns: AI_GRID_COLUMNS, rowHeight: ROW_HEIGHT, minWidth: 280, pagePadding: 0, backgroundColor: "transparent", widgetBackgroundColor: "#ffffff", widgetBorderEnabled: false, widgetBorderRadius: 20, widgetPadding: GAP },
      widgets: {},
      widgetLayout: {},
    },
  ],
};

const AI_MODULES = [AgStudioAiModule];

/** AG Studio's assistant is 350px wide by default, wider than a phone's card, which clipped its messages. It
 * takes its width from the theme when it's created, so the canvas is measured first and the width capped to it. */
const AI_PANEL_WIDTH = 350;

/** Which board a chart belongs on, from the data it uses: dispute charts go to Disputes, jar and transfer charts to Jars. */
function homeFor(w: Widget): BoardId {
  const ids = JSON.stringify(w.dataMapping ?? {});
  if (ids.includes('"disputes.')) return "disputes";
  if (/"(moved|jars|transfers)\./.test(ids)) return "jars";
  return "home";
}

/** Ask Bundo for a chart. "Quick chart" is one question, one chart; "Build a dashboard" opens AG Studio's own AI
 * assistant, which can lay out several widgets in one go. Both draw over the same data model as the boards. */
export function ChartBuilder() {
  const { model, ready } = useMoneyModel(90);
  const [mode, setMode] = useState<Mode>("quick");
  return (
    <section aria-label="Make a chart" className="rounded-[20px] bg-card p-5 shadow-card sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon name="monitoring" className="text-primary" />
          <h2 className="font-semibold">Ask for a chart</h2>
        </div>
        <Segmented items={MODES} active={mode} label="What to make" onSelect={(m) => setMode(m as Mode)} />
      </div>
      {mode === "quick" ? <QuickChart model={model} ready={ready} /> : <DashboardBuilder model={model} ready={ready} />}
    </section>
  );
}

/** One model call picks the chart from BundoPay's own fields, shown as a live preview. Nothing lands on a board
 * until the merchant pins it. */
function QuickChart({ model, ready }: { model: AgDataSourcesDefinition; ready: boolean }) {
  const studio = useRef<AgStudio>(null);
  const abort = useRef<AbortController | null>(null);
  const [q, setQ] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "running" | "error">("idle");
  const [widget, setWidget] = useState<Widget | null>(null);
  const [pinned, setPinned] = useState<BoardId | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  async function ask(text: string) {
    if (!text.trim() || !ready) return;
    abort.current?.abort();
    const ctl = (abort.current = new AbortController());
    setAsked(text);
    setWidget(null);
    setPinned(null);
    setProblem(null);
    setStatus("running");
    try {
      const made = await describeChart(text, model, ctl.signal);
      if (ctl.signal.aborted) return;
      // Show it on a real Studio canvas, so it looks exactly as it will once pinned.
      studio.current?.api?.setState({ ...EMPTY, pages: [{ ...EMPTY.pages[0], widgets: { chart: made }, widgetLayout: { chart: { xTrack: 0, yTrack: 0, xSpan: 1, ySpan: 8 } } }] });
      setWidget(made);
      setStatus("idle");
      feedback("approved");
    } catch (e) {
      if (ctl.signal.aborted) return;
      setProblem((e as Error).message);
      setStatus("error");
      feedback("error");
    }
  }

  function pin(board: BoardId) {
    if (!widget) return;
    pinToBoard(board, widget);
    setPinned(board);
    feedback("moved");
  }

  const target = widget ? homeFor(widget) : "home";

  return (
    <>
      <form className="mt-4 flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="e.g. disputes by reason this month"
          aria-label="Describe the chart you want"
          className="min-h-11 min-w-0 flex-1 rounded-full bg-card px-4 text-sm ring-1 ring-inset ring-ink/30 placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-primary"
        />
        <SendButton disabled={!q.trim() || status === "running" || !ready} />
      </form>
      {!asked && (
        <div className="mt-3 flex flex-wrap gap-2">
          {STARTERS.map((s) => (
            <button key={s} type="button" disabled={!ready} onClick={() => { setQ(s); ask(s); }} className="press rounded-full bg-soft px-3 py-1.5 text-[13px] font-medium text-ink-2 hover:text-ink disabled:opacity-50">{s}</button>
          ))}
        </div>
      )}

      {/* The preview is a real Studio canvas, so the chart looks exactly as it will on the board. */}
      <div className={`mt-5 overflow-hidden transition-[height] duration-300 motion-reduce:transition-none ${asked && status !== "error" ? "h-[360px]" : "h-0"}`} aria-busy={status === "running"}>
        {ready && (
          <AgStudioProvider licenseKey={process.env.NEXT_PUBLIC_AG_STUDIO_LICENSE}>
            <AgStudio
              ref={studio}
              theme={boardTheme}
              data={model}
              initialState={EMPTY}
              mode="view"
              panels={{ view: { left: [] }, edit: { left: [] } }}
              style={{ height: "100%", width: "100%" }}
            />
          </AgStudioProvider>
        )}
      </div>

      {asked && (
        <div className="mt-4 flex flex-wrap items-center gap-2" aria-live="polite">
          {status === "running" && <p className="flex items-center gap-2 text-sm text-muted"><Icon name="progress_activity" className="animate-spin text-[18px] motion-reduce:animate-none" /> Building &ldquo;{asked}&rdquo;…</p>}
          {status === "error" && <p className="text-sm text-danger">{problem ?? "Bundo couldn\u2019t build that one. Try saying it another way."}</p>}
          {status === "idle" && widget && !pinned && (
            <>
              <Button variant="primary" onClick={() => pin(target)}><Icon name="push_pin" className="text-[18px]" /> Pin to {BOARD_NAMES[target]}</Button>
              {target !== "home" && <Button onClick={() => pin("home")}>Pin to Home</Button>}
              <Button variant="ghost" onClick={() => { setAsked(null); setWidget(null); setQ(""); }}>Dismiss</Button>
            </>
          )}
          {pinned && <p className="flex items-center gap-2 text-sm font-medium text-ink-2"><SuccessTick /> Pinned to {BOARD_NAMES[pinned]}. It&rsquo;s there next time you open it.</p>}
        </div>
      )}
    </>
  );
}

const widgetCount = (s: AgReportState) => Object.values(s.pages.find((p) => p.id === s.selectedPageId)?.widgets ?? {}).filter(Boolean).length;

/** AG Studio's AI assistant, on Bundo's model: the merchant asks a question and it plans and lays out several
 * widgets. It only edits this canvas; nothing reaches a board until the merchant chooses to keep it. */
function DashboardBuilder({ model, ready }: { model: AgDataSourcesDefinition; ready: boolean }) {
  const studio = useRef<AgStudio>(null);
  const [count, setCount] = useState(0);
  const [kept, setKept] = useState(false);
  const [width, setWidth] = useState<number | null>(null);
  const measure = useCallback((el: HTMLDivElement | null) => {
    if (el) setWidth(el.clientWidth);
  }, []);
  const theme = useMemo(
    () => (width !== null && width < AI_PANEL_WIDTH ? boardTheme.withParams({ studioAiPanelWidth: width }) : boardTheme),
    [width],
  );

  const onStateUpdated = useCallback((e: { state: AgReportState }) => {
    setCount(widgetCount(e.state));
    setKept(false);
  }, []);

  function keep() {
    const state = studio.current?.api?.getState();
    if (!state) return;
    const { panels: _panels, ...board } = state;
    saveBoard("disputes", board);
    setKept(true);
    feedback("moved");
  }

  return (
    <>
      <p className="mt-3 text-sm text-ink-2">Ask a question and Bundo lays out a few charts that answer it. Try one of the suggestions in the assistant.</p>
      <div ref={measure} className="mt-4 h-[640px] overflow-hidden rounded-2xl ring-1 ring-ink/[0.08]">
        {ready && width !== null && (
          <AgStudioProvider licenseKey={process.env.NEXT_PUBLIC_AG_STUDIO_LICENSE} modules={AI_MODULES}>
            <AgStudio
              ref={studio}
              theme={theme}
              data={model}
              initialState={BLANK_DASHBOARD}
              mode="edit"
              panels={{ edit: { left: ["ai"], right: [] } }}
              ai={({ api }) => createAiHarness(api, { adapter: bundoAdapter, promptStarters: DASHBOARD_STARTERS })}
              onStateUpdated={onStateUpdated}
              style={{ height: "100%", width: "100%" }}
            />
          </AgStudioProvider>
        )}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2" aria-live="polite">
        {count > 0 && !kept && (
          <>
            <p className="text-sm text-ink-2">{count === 1 ? "1 chart" : `${count} charts`} on this dashboard.</p>
            <Button variant="primary" onClick={keep}><Icon name="push_pin" className="text-[18px]" /> Use as my Disputes board</Button>
          </>
        )}
        {kept && <p className="flex items-center gap-2 text-sm font-medium text-ink-2"><SuccessTick /> Saved as your Disputes board. Reset on that board brings the original back.</p>}
      </div>
    </>
  );
}
