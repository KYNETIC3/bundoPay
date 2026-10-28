"use client";

import { useCallback, useEffect, useState } from "react";

import { api } from "./api";
import { isStreamConnected, onStreamConnected } from "./events";

/** Load a resource, refresh it every `intervalMs` and whenever the header's Refresh finishes or the server
 * pushes a dispute change. While the push stream is up, polling slows to a safety net. */
export function useLive<T>(path: string | null, intervalMs = 30_000) {
  const [data, setData] = useState<T | null>(null);
  const [streaming, setStreaming] = useState(isStreamConnected);
  useEffect(() => onStreamConnected(setStreaming), []);
  const pollMs = streaming ? Math.max(intervalMs, 120_000) : intervalMs;
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
    const id = setInterval(load, pollMs);
    const onSync = () => load();
    window.addEventListener("disputes-synced", onSync);
    return () => {
      clearInterval(id);
      window.removeEventListener("disputes-synced", onSync);
    };
  }, [load, pollMs]);
  return { data, error, reload: load };
}

/** Phone width (below 640px), where wide grids become card lists. */
export function useNarrow() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const q = window.matchMedia("(max-width: 639px)");
    const on = () => setNarrow(q.matches);
    on();
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return narrow;
}
