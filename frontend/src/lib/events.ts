"use client";

import { supabase } from "./supabase";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const MIN_BACKOFF = 1_000;
const MAX_BACKOFF = 60_000;

export type DisputeChanged = { merchant_id: string; dispute_id: string };

/**
 * One server-sent-events stream per tab. Uses fetch rather than EventSource so the session token travels
 * in the Authorization header, never the URL. Each change is re-broadcast as the window `disputes-synced`
 * event that `useLive` already listens for.
 */
let controller: AbortController | null = null;
let connected = false;
const listeners = new Set<(connected: boolean) => void>();

function setConnected(value: boolean) {
  if (connected === value) return;
  connected = value;
  listeners.forEach((fn) => fn(value));
}

export const isStreamConnected = () => connected;

export function onStreamConnected(fn: (connected: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function startEventStream() {
  if (controller) return;
  controller = new AbortController();
  void run(controller.signal);
}

export function stopEventStream() {
  controller?.abort();
  controller = null;
  setConnected(false);
}

async function run(signal: AbortSignal) {
  let backoff = MIN_BACKOFF;
  while (!signal.aborted) {
    try {
      // A fresh token each attempt, so a reconnect after expiry uses the refreshed session.
      const { data } = await supabase().auth.getSession();
      if (!data.session) throw new Error("signed out");
      const res = await fetch(`${BASE}/events`, {
        headers: { Authorization: `Bearer ${data.session.access_token}`, Accept: "text/event-stream" },
        cache: "no-store",
        signal,
      });
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      setConnected(true);
      backoff = MIN_BACKOFF;
      await read(res.body, signal);
    } catch {
      /* dropped, refused or aborted; retry below unless stopped */
    }
    setConnected(false);
    if (signal.aborted) return;
    await sleep(backoff + Math.random() * 500, signal);
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
  }
}

async function read(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        dispatch(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function dispatch(frame: string) {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue; // comments are keep-alive pings
    const sep = line.indexOf(":");
    const field = sep < 0 ? line : line.slice(0, sep);
    const value = sep < 0 ? "" : line.slice(sep + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (event !== "dispute_changed" || !data.length) return;
  let detail: DisputeChanged;
  try {
    detail = JSON.parse(data.join("\n"));
  } catch {
    return;
  }
  window.dispatchEvent(new CustomEvent<DisputeChanged>("disputes-synced", { detail }));
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const id = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(id), resolve()), { once: true });
  });
}
