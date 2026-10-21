"use client";

import { supabase } from "./supabase";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const { data } = await supabase().auth.getSession();
  const headers = new Headers(init.headers);
  if (data.session) headers.set("Authorization", `Bearer ${data.session.access_token}`);
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");

  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    let code = "error";
    let message = res.statusText;
    try {
      const body = await res.json();
      const detail = body.detail;
      if (typeof detail === "string") message = detail;
      else if (detail) ({ code = code, message = message } = detail);
    } catch {
      /* non-JSON error body */
    }
    if (code === "reconnect_required" && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("reconnect-required"));
    }
    throw new ApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}

export const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
