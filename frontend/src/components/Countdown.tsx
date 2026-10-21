"use client";

import { useEffect, useState } from "react";

import { remaining } from "@/lib/format";

/** Quiet by default; stronger inside 48 hours. Never an alarm. */
export function Countdown({ due }: { due: string | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  const r = remaining(due);
  if (!r) return <span className="text-muted">—</span>;
  const cls = r.hours <= 0 ? "text-danger font-semibold" : r.hours < 48 ? "text-coral font-semibold" : "text-ink-2";
  return (
    <span className={`font-mono text-xs tabular-nums ${cls}`} title={due ? new Date(due).toLocaleString() : undefined}>
      {r.text}
    </span>
  );
}
