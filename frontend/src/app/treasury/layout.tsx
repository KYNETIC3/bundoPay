"use client";

import { usePathname } from "next/navigation";

import { Segmented } from "@/components/ui";

const TABS = [
  { href: "/treasury", label: "Overview" },
  { href: "/treasury/policies", label: "Policies" },
  { href: "/treasury/activity", label: "Activity" },
  { href: "/treasury/setup", label: "Accounts" },
];

export default function TreasuryLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // The policy editor is a detail page: it gets a back link instead of the tabs.
  if (pathname.startsWith("/treasury/policy") && !pathname.startsWith("/treasury/policies")) return <>{children}</>;
  const active = pathname === "/treasury/history" ? "/treasury/activity" : TABS.find((t) => t.href === pathname)?.href ?? "/treasury";
  return (
    <div className="space-y-8">
      <Segmented items={TABS} active={active} label="Treasury sections" />
      {children}
    </div>
  );
}
