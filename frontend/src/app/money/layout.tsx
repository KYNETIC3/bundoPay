"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";

import { Icon } from "@/components/ui";
import { unresolvedCount } from "@/components/DisputeTable";
import { useLive } from "@/lib/hooks";
import type { DisputeSummary } from "@/lib/types";

import { LAST_VIEW } from "@/lib/money";

const VIEWS = [
  { href: "/money/jars", label: "Jars", icon: "savings" },
  { href: "/money/disputes", label: "Disputes", icon: "gavel" },
] as const;

/** Jars and Disputes are one place with two views: the money set aside for disputes and the disputes themselves
 * sit side by side, a tap apart. Detail pages drop the switch and show a back link instead. */
export default function MoneyLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { data } = useLive<DisputeSummary[]>("/disputes");
  const open = unresolvedCount(data);
  const view = pathname.startsWith("/money/disputes") ? "disputes" : "jars";
  useEffect(() => {
    try {
      localStorage.setItem(LAST_VIEW, view);
    } catch {}
  }, [view]);

  const detail = /^\/money\/disputes\/[^/]+/.test(pathname) || pathname === "/money/jars/rule";
  if (detail) return <>{children}</>;
  const active = VIEWS.findIndex((v) => pathname.startsWith(v.href));

  return (
    <div className="space-y-8">
      <nav aria-label="Money views" className="sticky top-16 z-30 md:top-4">
        <div className="relative grid w-full grid-cols-2 rounded-full bg-[#e9eef1]/90 p-1 shadow-[0_6px_20px_-12px_rgb(54_33_62/0.35)] backdrop-blur-xl sm:inline-grid sm:w-auto">
          {/* One pill slides between the two views, so the switch feels like one control, not two links. */}
          <span
            aria-hidden
            className="absolute inset-y-1 left-1 w-[calc(50%-4px)] rounded-full bg-card shadow-[0_1px_3px_rgb(54_33_62/0.12)] transition-transform duration-300 [transition-timing-function:var(--ease-out)] motion-reduce:transition-none"
            style={{ transform: `translateX(${Math.max(0, active) * 100}%)` }}
          />
          {VIEWS.map((v, i) => (
            <Link
              key={v.href}
              href={v.href}
              aria-current={i === active ? "page" : undefined}
              className={`press relative z-10 inline-flex min-h-10 items-center justify-center gap-2 rounded-full px-6 text-[15px] transition-colors ${i === active ? "font-semibold text-ink" : "font-medium text-muted hover:text-ink"}`}
            >
              <Icon name={v.icon} className="text-[18px]" />
              {v.label}
              {v.href === "/money/disputes" && open > 0 && (
                <span className="grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1.5 text-[11px] font-semibold tabular-nums text-white" aria-label={`${open} open`}>
                  {open}
                </span>
              )}
            </Link>
          ))}
        </div>
      </nav>
      <div key={view} className="rise">{children}</div>
    </div>
  );
}
