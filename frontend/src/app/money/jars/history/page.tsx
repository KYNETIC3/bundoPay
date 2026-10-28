"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";

/** History is now Activity; old links (including ?flow=) still land in the right place. */
function Redirect() {
  const params = useSearchParams();
  const router = useRouter();
  useEffect(() => {
    const q = params.toString();
    router.replace(`/money/jars/activity${q ? `?${q}` : ""}`);
  }, [params, router]);
  return null;
}

export default function HistoryPage() {
  return (
    <Suspense>
      <Redirect />
    </Suspense>
  );
}
