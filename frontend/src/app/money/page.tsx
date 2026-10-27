"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { LAST_VIEW } from "@/lib/money";


/** Money opens where the merchant left it: Jars or Disputes. */
export default function MoneyPage() {
  const router = useRouter();
  useEffect(() => {
    let view = "jars";
    try {
      view = localStorage.getItem(LAST_VIEW) === "disputes" ? "disputes" : "jars";
    } catch {}
    router.replace(`/money/${view}`);
  }, [router]);
  return null;
}
