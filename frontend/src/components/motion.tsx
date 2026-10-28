"use client";

import { useEffect, useRef, useState } from "react";

import { money } from "@/lib/format";

const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** An amount that eases from its last value to the new one, so a change in balance is seen, not just noticed.
 * With reduced motion it simply shows the new value. Screen readers get the final amount once. */
export function CountUp({ value, currency, className = "" }: { value: number | null; currency: string; className?: string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value ?? 0);
  useEffect(() => {
    if (value === null) return setShown(null);
    const start = from.current;
    from.current = value;
    if (reduced() || start === value) return setShown(value);
    const t0 = performance.now();
    const ms = 700;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      const eased = 1 - Math.pow(1 - k, 3);
      setShown(start + (value - start) * eased);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return (
    <span className={`tabular-nums ${className}`}>
      <span aria-hidden>{money(shown === null ? null : String(Math.round(shown * 100) / 100), currency)}</span>
      <span className="sr-only">{money(value === null ? null : String(value), currency)}</span>
    </span>
  );
}

/** Children rise into place one after another. Pure CSS, so it costs nothing after the first paint. */
export function Reveal({ children, index = 0, className = "" }: { children: React.ReactNode; index?: number; className?: string }) {
  return (
    <div className={`rise ${className}`} style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}>
      {children}
    </div>
  );
}

/** A check that draws itself: used where something the merchant did has just succeeded. */
export function SuccessTick({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`h-5 w-5 shrink-0 text-primary ${className}`} aria-hidden>
      <circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.12" />
      <path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="tick-draw" />
    </svg>
  );
}

/** A grey placeholder in the shape of what's loading, so the page doesn't jump when it arrives. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`shimmer rounded-[20px] ${className}`} aria-hidden />;
}

/** Run a navigation or state change inside a view transition where the browser supports one. */
export function withTransition(fn: () => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (doc.startViewTransition && !reduced()) doc.startViewTransition(fn);
  else fn();
}
