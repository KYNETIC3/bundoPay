"use client";

import { useCallback, useEffect, useState } from "react";

import { api } from "./api";

/** Load a resource, refresh it every `intervalMs` and whenever the header's Sync finishes. */
export function useLive<T>(path: string | null, intervalMs = 30_000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [path]);
  useEffect(() => {
    load();
    const id = setInterval(load, intervalMs);
    const onSync = () => load();
    window.addEventListener("disputes-synced", onSync);
    return () => {
      clearInterval(id);
      window.removeEventListener("disputes-synced", onSync);
    };
  }, [load, intervalMs]);
  return { data, error, reload: load };
}
