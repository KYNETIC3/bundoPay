"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/money/jars", label: "Overview" },
  { href: "/money/jars/rules", label: "Rules" },
  { href: "/money/jars/activity", label: "Activity" },
  { href: "/money/jars/accounts", label: "Accounts" },
];

/** A quieter second row under the Jars | Disputes switch: plain text tabs with an underline. */
export default function JarsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/money/jars/rule") return <>{children}</>;
  const active = pathname === "/money/jars/history" ? "/money/jars/activity" : TABS.find((t) => t.href === pathname)?.href ?? "/money/jars";
  return (
    <div className="space-y-8">
      <nav aria-label="Jars sections" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div className="flex gap-6 border-b border-ink/[0.08]">
          {TABS.map((t) => {
            const on = t.href === active;
            return (
              <Link
                key={t.href}
                href={t.href}
                aria-current={on ? "page" : undefined}
                className={`relative -mb-px whitespace-nowrap border-b-2 pb-2.5 pt-1 text-[15px] transition-colors ${on ? "border-primary font-semibold text-ink" : "border-transparent font-medium text-muted hover:text-ink"}`}
              >
                {t.label}
              </Link>
            );
          })}
        </div>
      </nav>
      {children}
    </div>
  );
}
