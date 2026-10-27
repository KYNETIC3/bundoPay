"use client";

import { type AgAiChatSession, type AgAiHarness, type AgReportState, createAiHarness } from "ag-studio";
import { AgStudio, AgStudioProvider } from "ag-studio-react";
import { useEffect, useRef, useState } from "react";

import { feedback } from "@/lib/feedback";
import { bundoAdapter } from "@/lib/studio/adapter";
import { type BoardId, type Widget, pinToBoard } from "@/lib/studio/boards";
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

/** Ask Bundo for a chart: AG Studio's own AI builds it over BundoPay's data model, as a live preview. Nothing lands
 * on a board until the merchant pins it, so boards stay as clean as they chose. */
export function ChartBuilder() {
  const { model, ready } = useMoneyModel(90);
  const studio = useRef<AgStudio>(null);
  const harness = useRef<AgAiHarness | null>(null);
  const session = useRef<AgAiChatSession | null>(null);
  const [q, setQ] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "running" | "error">("idle");
  const [widget, setWidget] = useState<Widget | null>(null);
  const [pinned, setPinned] = useState<BoardId | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => () => harness.current?.dispose?.(), []);

  async function ask(text: string) {
    const api = studio.current?.api;
    if (!text.trim() || !api) return;
    // Studio builds its harness lazily, when its own AI panel opens; this page has no panel, so build it here.
    harness.current ??= createAiHarness(api, { adapter: bundoAdapter, primary: "lead" });
    setAsked(text);
    setWidget(null);
    setPinned(null);
    setProblem(null);
    setStatus("running");
    studio.current?.api?.setState(EMPTY);
    try {
      session.current ??= await harness.current.createThread({ agentId: harness.current.agents[0]?.id ?? "lead", title: "Charts" });
      const s = session.current;
      let ran = false;
      // The session reports every change; the run is over once it has been running and stops.
      const onChange = () => {
        if (s.status === "running") ran = true;
        if (!ran || s.status === "running") return;
        s.removeEventListener("changed", onChange);
        const state = studio.current?.api?.getState();
        const page = state?.pages.find((p) => p.id === state.selectedPageId) ?? state?.pages[0];
        const made = Object.values(page?.widgets ?? {}).find(Boolean) ?? null;
        const last = s.messages.at(-1)?.parts.find((p) => p.type === "error") as { message?: string } | undefined;
        setProblem(last?.message ?? null);
        setWidget(made);
        setStatus(s.status === "error" || !made ? "error" : "idle");
        feedback(made ? "approved" : "error");
      };
      s.addEventListener("changed", onChange);
      s.sendMessage(`${text}\n\nBuild exactly one widget on the current page that answers this. Keep it simple and readable for a small business owner.`);
    } catch (e) {
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
