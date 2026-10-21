"use client";

import { useEffect, useState } from "react";

import { remaining } from "@/lib/format";

/** Quiet by default; more prominent inside 48 hours. Never an alarm. */
export function Countdown({ due }: { due: string | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  const r = remaining(due);
  if (!r) return <span className="countdown">No deadline</span>;
  const cls = r.hours <= 0 ? "passed" : r.hours < 48 ? "near" : "";
  return (
    <span className={`countdown ${cls}`} title={due ? new Date(due).toLocaleString() : undefined}>
      {r.text}
    </span>
  );
}
