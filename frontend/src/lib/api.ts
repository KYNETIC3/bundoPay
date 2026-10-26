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

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, "network", "Can't reach the BundoPay server. Check that the API is running, then try again.");
  }
  if (!res.ok) {
    let code = "error";
    let message = res.statusText;
    try {
      const body = await res.json();
      const detail = body.detail;
      if (typeof detail === "string") message = detail;
      else if (Array.isArray(detail)) {
        // FastAPI validation errors: [{ loc, msg }]. Say which field and what's wrong.
        message = detail.map((d: { loc?: unknown[]; msg?: string }) => {
          const field = String(d.loc?.[d.loc.length - 1] ?? "").replace(/_/g, " ");
          const msg = (d.msg ?? "").replace(/^Value error, /, "");
          return field && !msg.toLowerCase().includes(field) ? `${field}: ${msg}` : msg;
        }).join(". ");
        code = "validation";
      } else if (detail) ({ code = code, message = message } = detail);
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
