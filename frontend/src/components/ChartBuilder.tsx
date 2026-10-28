"use client";

import type { AgReportState } from "ag-studio";
import { AgStudio, AgStudioProvider } from "ag-studio-react";
import { useEffect, useRef, useState } from "react";

import { feedback } from "@/lib/feedback";
import { type BoardId, type Widget, pinToBoard } from "@/lib/studio/boards";
import { describeChart } from "@/lib/studio/describe";
import { boardTheme } from "@/lib/studio/theme";
import { useMoneyModel } from "@/lib/studio/useModel";

import { SuccessTick } from "./motion";
import { Button, Icon, SendButton } from "./ui";

const EMPTY: AgReportState = {
  selectedPageId: "preview",
  pages: [{ id: "preview", layout: { columns: 1, rowHeight: 40, pagePadding: 0, backgroundColor: "transparent", widgetBackgroundColor: "#ffffff", widgetBorderEnabled: false, widgetBorderRadius: 20, widgetPadding: 16 }, widgets: {}, widgetLayout: {} }],
};

const STARTERS = ["Disputes by reason this month", "Money set aside each week, by jar", "Transfers stopped by safety checks"];

const BOARD_NAMES: Record<BoardId, string> = { home: "Home", jars: "Jars", disputes: "Disputes" };

/** Which board a chart belongs on, from the data it uses: dispute charts go to Disputes, jar and transfer charts to Jars. */
function homeFor(w: Widget): BoardId {
  const ids = JSON.stringify(w.dataMapping ?? {});
  if (ids.includes('"disputes.')) return "disputes";
  if (/"(moved|jars|transfers)\./.test(ids)) return "jars";
  return "home";
}

/** Ask Bundo for a chart: one model call picks the chart from BundoPay's own fields, and AG Studio draws it over the
 * same data model as the boards, as a live preview. Nothing lands on a board until the merchant pins it. */
export function ChartBuilder() {
  const { model, ready } = useMoneyModel(90);
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
    <section aria-label="Make a chart" className="rounded-[20px] bg-card p-5 shadow-card sm:p-6">
      <div className="flex items-center gap-2">
        <Icon name="monitoring" className="text-primary" />
        <h2 className="font-semibold">Ask for a chart</h2>
      </div>
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
    </section>
  );
}
