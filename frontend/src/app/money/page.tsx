"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { LAST_VIEW } from "@/lib/money";


/** Money opens where the merchant left it: Jars or Disputes. */
export default function MoneyPage() {
  const router = useRouter();
  useEffect(() => {
    // Only from /money itself: a dev reload can remount this page under a Money sub-route.
    if (window.location.pathname !== "/money") return;
    let view = "jars";
    try {
      view = localStorage.getItem(LAST_VIEW) === "disputes" ? "disputes" : "jars";
    } catch {}
    router.replace(`/money/${view}`);
  }, [router]);
  return null;
}
