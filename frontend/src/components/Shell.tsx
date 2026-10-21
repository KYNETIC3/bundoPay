"use client";

import type { Session } from "@supabase/supabase-js";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { supabase } from "@/lib/supabase";

const PUBLIC_PATHS = ["/login"];

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [reconnect, setReconnect] = useState(false);

  useEffect(() => {
    supabase().auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase().auth.onAuthStateChange((_e, s) => setSession(s));
    const onRevoked = () => setReconnect(true);
    window.addEventListener("reconnect-required", onRevoked);
    return () => {
      data.subscription.unsubscribe();
      window.removeEventListener("reconnect-required", onRevoked);
    };
  }, []);

  const isPublic = PUBLIC_PATHS.includes(pathname);
  useEffect(() => {
    if (session === null && !isPublic) router.replace("/login");
  }, [session, isPublic, router]);

  const nav = [
    { href: "/disputes", label: "Disputes" },
    { href: "/data", label: "Your records" },
    { href: "/settings", label: "Settings" },
  ];

  return (
    <div className="shell">
      <header className="masthead">
        <Link href="/disputes" className="wordmark">
          BundoPay <span>· sandbox</span>
        </Link>
        {session && (
          <nav className="nav">
            {nav.map((n) => (
              <Link key={n.href} href={n.href} aria-current={pathname.startsWith(n.href) ? "page" : undefined}>
                {n.label}
              </Link>
            ))}
            <button onClick={() => supabase().auth.signOut()}>Sign out</button>
          </nav>
        )}
      </header>
      {reconnect && (
        <div className="notice gap" style={{ marginBottom: 24 }}>
          PayPal no longer grants BundoPay access to your account.{" "}
          <Link href="/onboarding">Reconnect PayPal</Link> to keep working on your disputes.
        </div>
      )}
      {session || isPublic ? children : null}
    </div>
  );
}
