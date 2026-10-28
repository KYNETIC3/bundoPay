"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { useLive } from "@/lib/hooks";

import { Button, Card, Icon, IconButton, Pill } from "./ui";

type StepId = "sale" | "reserve" | "dispute" | "approved" | "verified";

const STEPS: { id: StepId; title: string; help: string; cta: string; href: string; external?: boolean }[] = [
  { id: "sale", title: "Make a sale in the test store", help: "Pay with the sandbox buyer from the testing instructions. No real money moves.", cta: "Open test store", href: "/store" },
  { id: "reserve", title: "See tax set aside", help: "Your 8.25% tax rule moves part of that sale into the Tax jar.", cta: "Open Jars", href: "/money/jars" },
  {
    id: "dispute", title: "Open a dispute as the buyer",
    help: "In the PayPal sandbox, sign in as the buyer, open the payment and choose Report a problem.",
    cta: "Open PayPal sandbox", href: "https://www.sandbox.paypal.com/resolutioncenter", external: true,
  },
  { id: "approved", title: "Review Bundo’s draft and approve", help: "Gemini drafts the reply; code checks it; nothing goes to PayPal until you approve.", cta: "Open Disputes", href: "/money/disputes" },
  { id: "verified", title: "Check your records", help: "Every step above is in a tamper-evident history.", cta: "Open Activity", href: "/money/jars/activity" },
];

const DISMISSED = "bundo.guide.dismissed";
const MANUAL = "bundo.guide.manual";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private window: the guide just forgets */
  }
  window.dispatchEvent(new CustomEvent("guide-changed"));
}

export const showGuide = () => write(DISMISSED, null);

/** Whether the demo account's guide is showing. Null until read, so Home can keep its first screen calm. */
export function useGuideOpen(isDemo: boolean): boolean | null {
  const [open, setOpen] = useState<boolean | null>(null);
  useEffect(() => {
    const sync = () => setOpen(isDemo && read(DISMISSED) !== "1");
    sync();
    window.addEventListener("guide-changed", sync);
    return () => window.removeEventListener("guide-changed", sync);
  }, [isDemo]);
  return open;
}

/** Demo account only: the five-step story, ticked from real data where it exists, one "Next" at a time. */
export function StartHere() {
  const { data } = useLive<{ steps: Record<StepId, boolean> }>("/demo/progress", 15_000);
  const [manual, setManual] = useState<StepId[]>([]);
  const [said, setSaid] = useState("");
  const list = useRef<HTMLOListElement>(null);
  const moved = useRef(false);
  useEffect(() => {
    try {
      setManual(JSON.parse(read(MANUAL) ?? "[]"));
    } catch {
      setManual([]);
    }
  }, []);

  const done = (id: StepId) => !!data?.steps[id] || manual.includes(id);
  const current = STEPS.find((s) => !done(s.id));

  // The close button goes with the card, so focus lands on the page title rather than nowhere.
  function hide() {
    const title = document.querySelector<HTMLElement>("main h1");
    write(DISMISSED, "1");
    if (title) {
      title.tabIndex = -1;
      title.focus();
    }
  }

  // "I did this" unmounts the button that had focus, so focus moves on to the next step's link.
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    list.current?.querySelector<HTMLElement>('[aria-current="step"] a')?.focus();
  }, [manual]);

  function tick(id: StepId) {
    const next = [...manual, id];
    const after = STEPS.find((s) => !next.includes(s.id) && !data?.steps[s.id]);
    moved.current = true;
    setManual(next);
    setSaid(after ? `Marked done. Next: ${after.title}.` : "Marked done. That was the last step.");
    write(MANUAL, JSON.stringify(next));
  }

  return (
    <Card>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 id="start-here" className="text-[19px] font-semibold tracking-[-0.015em]">Start here</h2>
          <p className="mt-1 text-sm text-muted">One sale, one dispute, about three minutes.</p>
        </div>
        <IconButton icon="close" label="Hide guide" onClick={hide} />
      </div>
      <ol ref={list} aria-labelledby="start-here" className="space-y-2">
        {STEPS.map((s, i) => {
          const isDone = done(s.id);
          const isCurrent = s === current;
          return (
            <li
              key={s.id}
              aria-current={isCurrent ? "step" : undefined}
              className={`flex gap-3 rounded-[14px] px-3 py-3 ${isCurrent ? "bg-soft ring-1 ring-primary/30" : ""}`}
            >
              <span
                aria-hidden
                className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[13px] font-semibold ${isDone ? "bg-primary text-white" : "bg-ink/[0.07] text-ink"}`}
              >
                {isDone ? <Icon name="check" className="text-[16px]" /> : i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-[15px] font-medium">
                  <span className="sr-only">Step {i + 1}: </span>
                  {s.title}
                  {isDone && <Pill tone="cerulean"><Icon name="check" className="text-[14px]" />Done</Pill>}
                  {isCurrent && <Pill tone="plum"><Icon name="arrow_forward" className="text-[14px]" />Next</Pill>}
                </p>
                {isCurrent && (
                  <>
                    <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{s.help}</p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {s.external ? (
                        <a
                          href={s.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="press inline-flex min-h-10 items-center gap-2 rounded-full bg-primary px-[18px] text-sm font-semibold text-white hover:bg-primary-container"
                        >
                          {s.cta} <Icon name="open_in_new" className="text-[16px]" />
                          <span className="sr-only">(opens in a new tab)</span>
                        </a>
                      ) : (
                        <Button variant="primary" href={s.href}>{s.cta}</Button>
                      )}
                      <Button variant="ghost" onClick={() => tick(s.id)}>I did this</Button>
                    </div>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <p aria-live="polite" className="sr-only">{said}</p>
      {!current && (
        <p className="mt-4 text-sm text-ink-2" role="status">
          That&rsquo;s the whole story. <Link href="/money" className="font-semibold text-primary">Look around Money</Link> or hide this guide.
        </p>
      )}
    </Card>
  );
}
