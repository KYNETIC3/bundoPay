"use client";

import type { Session } from "@supabase/supabase-js";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { api } from "@/lib/api";
import { MerchantProvider, useMerchant } from "@/lib/merchant";
import { supabase } from "@/lib/supabase";

import { Icon } from "./ui";

const BARE_PATHS = ["/login", "/onboarding", "/onboarding/return"];

const NAV = [
  { href: "/", label: "Overview", icon: "dashboard" },
  { href: "/disputes", label: "Disputes", icon: "gavel" },
  { href: "/agent", label: "Agent", icon: "smart_toy" },
  { href: "/settings", label: "Settings", icon: "tune" },
];

const TITLES: [string, string][] = [
  ["/disputes/", "Dispute"],
  ["/disputes", "Disputes"],
  ["/agent", "Agent"],
  ["/settings", "Settings"],
  ["/", "Overview"],
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

  const bare = BARE_PATHS.includes(pathname);
  useEffect(() => {
    if (session === null && pathname !== "/login") router.replace("/login");
  }, [session, pathname, router]);

  if (session === undefined) return null;
  if (bare) return <div className="min-h-screen px-4 py-10 sm:py-16">{children}</div>;
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
  const title = TITLES.find(([p]) => (p === "/" ? pathname === "/" : pathname.startsWith(p)))?.[1] ?? "BundoPay";
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
      const r = await api<{ synced: number }>("/disputes/sync", { method: "POST" });
      await refresh();
      window.dispatchEvent(new CustomEvent("disputes-synced"));
      setSyncResult(
        r.synced === 0
          ? `Synced with PayPal at ${new Date().toLocaleTimeString()}. PayPal has no disputes on merchant ${status?.paypal_merchant_id ?? ""}.`
          : `Synced with PayPal at ${new Date().toLocaleTimeString()}: ${r.synced} dispute${r.synced === 1 ? "" : "s"} checked.`,
      );
    } catch (e) {
      setSyncError((e as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="min-h-screen pt-14 md:pl-[220px] md:pt-0">
      <aside className="fixed inset-x-0 top-0 z-40 flex h-14 items-center gap-2 bg-primary px-3 md:inset-y-0 md:left-0 md:right-auto md:h-full md:w-[220px] md:flex-col md:items-stretch md:gap-0 md:px-0">
        <div className="flex items-center gap-2 md:h-[72px] md:border-b md:border-white/10 md:px-4">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-white/15 font-bold text-white">B</span>
          <span className="hidden text-lg font-semibold tracking-tight text-white sm:inline">BundoPay</span>
        </div>
        <nav className="ml-auto flex gap-1 md:ml-0 md:mt-4 md:flex-col md:px-2">
          {NAV.map((n) => {
            const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active ? "page" : undefined}
                className={`relative flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition ${
                  active ? "bg-primary-container font-semibold text-white shadow-sm" : "text-primary-fixed hover:bg-primary-container hover:text-white"
                }`}
              >
                <Icon name={n.icon} />
                <span className="hidden md:inline">{n.label}</span>
                {n.href === "/agent" && unread > 0 && (
                  <span className="ml-auto rounded-full bg-coral px-1.5 py-0.5 font-mono text-[10px] font-bold leading-none text-white" aria-label={`${unread} new`}>
                    {unread}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
        <button
          onClick={() => supabase().auth.signOut()}
          className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-primary-fixed hover:bg-primary-container hover:text-white md:mx-2 md:mb-3 md:mt-auto"
        >
          <Icon name="logout" />
          <span className="hidden md:inline">Log out</span>
        </button>
      </aside>

      <header className="sticky top-14 z-30 flex h-[64px] items-center justify-between gap-3 border-b border-line bg-card px-4 md:top-0 md:h-[72px] md:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
          {status && (
            <Link
              href="/settings"
              className="hidden items-center gap-1.5 rounded-full border border-line bg-soft px-2.5 py-1 font-mono text-[11px] text-ink-2 sm:flex"
            >
              <span className={`h-2 w-2 rounded-full ${connected ? "bg-primary" : "bg-coral"}`} />
              PayPal: <b className="text-ink">{connected ? (status.test_mode ? "Test account" : "Connected") : "Not connected"}</b>
            </Link>
          )}
        </div>
        {connected && (
          <button
            onClick={sync}
            disabled={syncing}
            className="inline-flex items-center gap-1.5 rounded-full bg-ink px-3.5 py-1.5 text-sm font-medium text-white hover:bg-black disabled:opacity-60"
          >
            <Icon name="sync" className={`text-[18px] ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Syncing" : "Sync"}
          </button>
        )}
      </header>

      <main className="mx-auto w-full max-w-[1280px] space-y-5 p-4 md:p-6">
        {reconnect && (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-coral/30 bg-danger-soft px-4 py-3 text-sm">
            <span>PayPal stopped giving BundoPay access.</span>
            <Link href="/settings" className="font-semibold text-danger">Reconnect</Link>
          </div>
        )}
        {syncError && (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm">
            <span>Sync failed: {syncError}</span>
            <button onClick={() => setSyncError(null)} className="font-semibold text-danger">Dismiss</button>
          </div>
        )}
        {syncResult && (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-card px-4 py-3 text-sm">
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
    <div className="mx-auto max-w-md rounded-2xl border border-line bg-card p-8 text-center shadow-sm">
      <Icon name="link" className="text-[36px] text-primary" />
      <h2 className="mt-3 text-xl font-semibold">Connect your PayPal account</h2>
      <p className="mt-2 text-sm text-muted">BundoPay needs access to your PayPal disputes before the agent can help.</p>
      <Link href="/onboarding" className="mt-5 inline-flex rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-container">
        Connect PayPal
      </Link>
    </div>
  );
}
