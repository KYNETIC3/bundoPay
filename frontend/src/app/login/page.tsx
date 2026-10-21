"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { supabase } from "@/lib/supabase";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const auth = supabase().auth;
    const { error } =
      mode === "signin" ? await auth.signInWithPassword({ email, password }) : await auth.signUp({ email, password });
    setBusy(false);
    if (error) return setError(error.message);
    router.replace(mode === "signup" ? "/onboarding" : "/disputes");
  }

  return (
    <div className="narrow stack">
      <p className="eyebrow">{mode === "signin" ? "Sign in" : "Create an account"}</p>
      <h1>Your disputes, prepared carefully. Sent only when you say so.</h1>
      <p className="lede">
        Dispute Agent reads your PayPal disputes, gathers the records that answer them, and drafts a response for you to
        review. It never holds your PayPal password and never submits on its own.
      </p>
      <form onSubmit={submit} className="card stack" style={{ marginTop: 28 }}>
        <div>
          <label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label htmlFor="password">Password for Dispute Agent (not your PayPal password)</label>
          <input
            id="password"
            type="password"
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            minLength={8}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && <p className="error">{error}</p>}
        <div className="row-actions">
          <button className="btn primary" disabled={busy}>
            {mode === "signin" ? "Sign in" : "Create account"}
          </button>
          <button type="button" className="btn quiet" onClick={() => setMode(mode === "signin" ? "signup" : "signin")}>
            {mode === "signin" ? "New here? Create an account" : "Have an account? Sign in"}
          </button>
        </div>
      </form>
    </div>
  );
}
