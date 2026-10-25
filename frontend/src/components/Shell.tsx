"use client";

import type { Session } from "@supabase/supabase-js";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { api } from "@/lib/api";
import { startEventStream, stopEventStream } from "@/lib/events";
import { MerchantProvider, useMerchant } from "@/lib/merchant";
import { supabase } from "@/lib/supabase";

import { Icon } from "./ui";

const BARE_PATHS = ["/login", "/onboarding", "/onboarding/return"];

const NAV = [
  { href: "/", label: "Overview", icon: "dashboard" },
  { href: "/treasury", label: "Treasury", icon: "account_balance" },
  { href: "/disputes", label: "Disputes", icon: "gavel" },
  { href: "/agent", label: "Ask Bundo", icon: "forum" },
  { href: "/settings", label: "Settings", icon: "tune" },
];

const TITLES: [string, string, string][] = [
  ["/treasury", "Treasury", "Your money, set aside automatically, within limits you choose."],
  ["/disputes/", "", ""],
  ["/disputes", "Disputes", "Everything PayPal has sent you, newest first."],
  ["/agent", "Ask Bundo", ""],
  ["/settings", "Settings", "Your PayPal connection and what Bundo may do on its own."],
  ["/", "Overview", "What needs you, and what Bundo has done."],
];

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    supabase().auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase().auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  const signedIn = !!session;
  useEffect(() => {
    if (!signedIn) return;
    startEventStream();
    return stopEventStream;
  }, [signedIn]);

  const bare = BARE_PATHS.includes(pathname);
  useEffect(() => {
    if (session === null && pathname !== "/login") router.replace("/login");
  }, [session, pathname, router]);

  if (session === undefined) return null;
  if (bare) return <div className="min-h-screen px-4 py-12 sm:py-20">{children}</div>;
  if (!session) return null;

  return (
    <MerchantProvider>
      <Frame pathname={pathname}>{children}</Frame>
    </MerchantProvider>
  );
}

function Frame({ pathname, children }: { pathname: string; children: React.ReactNode }) {
  const { status, refresh } = useMerchant();
  const [syncing, setSyncing] = useState(false);
  const [reconnect, setReconnect] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    const check = () => api<{ count: number }>("/agent/unread").then((r) => setUnread(r.count)).catch(() => {});
    check();
    const t = setInterval(check, 20_000);
    const onRead = () => setUnread(0);
    window.addEventListener("agent-read", onRead);
    return () => {
      clearInterval(t);
      window.removeEventListener("agent-read", onRead);
    };
  }, []);
  const [, title, subtitle] = TITLES.find(([p]) => (p === "/" ? pathname === "/" : pathname.startsWith(p))) ?? ["", "BundoPay", ""];
  // Dispute pages carry their own heading; the header only offers a way back.
  const back = pathname === "/treasury/policy"
    ? { href: "/treasury/policies", label: "Policies" }
    : pathname.endsWith("/approve")
    ? { href: pathname.slice(0, -"/approve".length), label: "Dispute" }
    : pathname.startsWith("/disputes/")
      ? { href: "/disputes", label: "Disputes" }
      : null;
  const connected = status?.grant_status === "granted";

  useEffect(() => {
    const onRevoked = () => setReconnect(true);
    window.addEventListener("reconnect-required", onRevoked);
    return () => window.removeEventListener("reconnect-required", onRevoked);
  }, []);

  async function sync() {
    setSyncing(true);
    setSyncError(null);
    setSyncResult(null);
    try {
      const r = await api<{ updated: number; total: number }>("/disputes/sync", { method: "POST" });
      await refresh();
      window.dispatchEvent(new CustomEvent("disputes-synced"));
      const at = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      setSyncResult(
        r.updated > 0
          ? `Refreshed at ${at}: ${r.updated} dispute${r.updated === 1 ? "" : "s"} updated from PayPal.`
          : r.total > 0
            ? `Refreshed at ${at}: everything is up to date.`
            : `Refreshed at ${at}: PayPal has no disputes on this account.`,
      );
    } catch (e) {
      setSyncError((e as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="min-h-screen pt-14 md:pl-[240px] md:pt-0">
      <aside className="fixed inset-x-0 top-0 z-40 flex h-14 items-center gap-2 border-b border-ink/[0.06] bg-white/60 px-3 backdrop-blur-xl md:inset-y-0 md:left-0 md:right-auto md:h-full md:w-[240px] md:flex-col md:items-stretch md:gap-8 md:border-b-0 md:border-r md:px-4 md:py-7">
        <div className="flex items-center gap-3 md:px-3">
          <span className="grid h-8 w-8 place-items-center rounded-[9px] bg-ink text-[15px] font-bold text-white">B</span>
          <span className="hidden text-[17px] font-semibold tracking-[-0.01em] sm:inline">BundoPay</span>
        </div>
        <nav aria-label="Main" className="ml-auto flex gap-1 md:ml-0 md:flex-col">
          {NAV.map((n) => {
            const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active ? "page" : undefined}
                aria-label={n.label}
                className={`flex min-h-11 items-center gap-3 rounded-xl px-3 text-[15px] transition ${
                  active ? "bg-card font-semibold text-ink shadow-[0_1px_2px_rgb(54_33_62/0.06),0_0_0_1px_rgb(54_33_62/0.04)]" : "font-medium text-muted hover:bg-primary/[0.06] hover:text-ink"
                }`}
              >
                <Icon name={n.icon} />
                <span className="hidden md:inline">{n.label}</span>
                {n.href === "/agent" && unread > 0 && (
                  <span className="ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-ink px-1.5 text-[11px] font-semibold tabular-nums text-white" aria-label={`${unread} new`}>
                    {unread}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
        <button
          onClick={() => supabase().auth.signOut()}
          aria-label="Log out"
          className="flex min-h-11 items-center gap-3 rounded-xl px-3 text-[15px] font-medium text-muted hover:bg-primary/[0.06] hover:text-ink md:mt-auto"
        >
          <Icon name="logout" />
          <span className="hidden md:inline">Log out</span>
        </button>
      </aside>

      <main className="mx-auto w-full max-w-[1256px] space-y-8 px-4 pb-16 pt-6 md:px-12 md:pt-10">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            {back ? (
              <Link href={back.href} className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:text-ink">
                <Icon name="chevron_left" className="text-[18px]" /> {back.label}
              </Link>
            ) : (
              <>
                <h1 className="text-[32px] font-semibold leading-tight tracking-[-0.025em]">{title}</h1>
                {subtitle && <p className="mt-1.5 text-[15px] text-muted">{subtitle}</p>}
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {connected && (
              <button
                onClick={sync}
                disabled={syncing}
                className="inline-flex min-h-10 items-center gap-2 rounded-full bg-card px-[18px] text-sm font-semibold text-ink ring-1 ring-ink/[0.12] hover:bg-[#f7fafb] disabled:opacity-60"
              >
                <Icon name="refresh" className={`text-[18px] ${syncing ? "animate-spin" : ""}`} />
                {syncing ? "Refreshing" : "Refresh"}
              </button>
            )}
          </div>
        </header>

        {reconnect && (
          <div className="flex items-center justify-between gap-4 rounded-2xl bg-danger-soft px-5 py-4 text-sm">
            <span>PayPal stopped giving BundoPay access.</span>
            <Link href="/settings" className="font-semibold text-danger">Reconnect</Link>
          </div>
        )}
        {syncError && (
          <div className="flex items-center justify-between gap-4 rounded-2xl bg-danger-soft px-5 py-4 text-sm">
            <span>Couldn&rsquo;t refresh from PayPal: {syncError}</span>
            <button onClick={() => setSyncError(null)} className="font-semibold text-danger">Dismiss</button>
          </div>
        )}
        {syncResult && (
          <div className="flex items-center justify-between gap-4 rounded-2xl bg-card px-5 py-4 text-sm shadow-card">
            <span className="flex items-center gap-2"><Icon name="check_circle" className="text-primary" />{syncResult}</span>
            <button onClick={() => setSyncResult(null)} className="font-semibold text-muted">Dismiss</button>
          </div>
        )}
        {status && !connected && pathname !== "/settings" ? <ConnectPrompt /> : children}
      </main>
    </div>
  );
}

function ConnectPrompt() {
  return (
    <div className="mx-auto max-w-md rounded-[20px] bg-card p-10 text-center shadow-card">
      <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-primary-fixed text-primary"><Icon name="link" className="text-[24px]" /></span>
      <h2 className="mt-4 text-xl font-semibold tracking-[-0.015em]">Connect your PayPal account</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted">BundoPay needs access to your PayPal disputes before Bundo can help.</p>
      <Link href="/onboarding" className="mt-6 inline-flex min-h-10 items-center rounded-full bg-primary px-5 text-sm font-semibold text-white hover:bg-primary-container">
        Connect PayPal
      </Link>
    </div>
  );
}
