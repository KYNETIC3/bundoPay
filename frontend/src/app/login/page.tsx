"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Icon } from "@/components/ui";
import { supabase } from "@/lib/supabase";

const field = "w-full rounded-lg border border-line-strong bg-card px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-container";

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
    const { error } = mode === "signin" ? await auth.signInWithPassword({ email, password }) : await auth.signUp({ email, password });
    setBusy(false);
    if (error) return setError(error.message);
    router.replace("/");
  }

  return (
    <div className="mx-auto max-w-sm">
      <div className="mb-8 flex items-center gap-2">
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary font-bold text-white">B</span>
        <span className="text-xl font-semibold tracking-tight">BundoPay</span>
      </div>
      <h1 className="text-3xl font-bold tracking-tight">{mode === "signin" ? "Welcome back" : "Create your account"}</h1>
      <p className="mt-2 text-sm text-muted">An agent that handles your PayPal disputes, within limits you set.</p>

      <form onSubmit={submit} className="mt-8 space-y-4 rounded-2xl border border-line bg-card p-6 shadow-sm">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Email</span>
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={field} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Password</span>
          <input
            type="password"
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            minLength={8}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={field}
          />
          <span className="mt-1 block text-xs text-muted">Not your PayPal password.</span>
        </label>
        {error && <p className="text-sm text-danger">{error}</p>}
        <button disabled={busy} className="w-full rounded-lg bg-primary py-2.5 text-sm font-semibold text-white hover:bg-primary-container disabled:opacity-60">
          {mode === "signin" ? "Sign in" : "Create account"}
        </button>
      </form>
      <button onClick={() => setMode(mode === "signin" ? "signup" : "signin")} className="mt-4 flex items-center gap-1 text-sm text-primary">
        {mode === "signin" ? "New here? Create an account" : "Have an account? Sign in"}
        <Icon name="arrow_forward" className="text-[16px]" />
      </button>
    </div>
  );
}
