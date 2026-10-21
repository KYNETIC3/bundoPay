"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";

import { Button, Icon, Pill } from "@/components/ui";
import { api, json } from "@/lib/api";
import { money } from "@/lib/format";
import { agentState } from "@/lib/status";

type Card = {
  dispute_id: string;
  paypal_dispute_id: string;
  reason: string | null;
  amount: string | null;
  currency: string | null;
  status: string;
  archived: boolean;
  draft_id: string | null;
  action: string | null;
  draft_status: string | null;
  payload_hash: string | null;
  offer_amount: string | null;
};
type Message = { id: number | string; role: "agent" | "owner"; kind: string; content: string; created_at: string; unread?: boolean; cards: Card[] };

// How each kind of agent update looks: what happened at a glance.
const KIND: Record<string, { icon: string; tone: string; label: string }> = {
  auto_refund: { icon: "currency_exchange", tone: "bg-coral text-white", label: "Refunded" },
  decision: { icon: "approval", tone: "bg-plum text-white", label: "Needs your OK" },
  submitted: { icon: "send", tone: "bg-cerulean text-white", label: "Sent" },
  outcome: { icon: "flag", tone: "bg-steel text-white", label: "Closed" },
  failed: { icon: "error", tone: "bg-danger-soft text-danger", label: "Didn't go through" },
  past_due: { icon: "schedule", tone: "bg-danger-soft text-danger", label: "Deadline passed" },
  declined: { icon: "block", tone: "bg-soft text-ink-2", label: "Declined" },
  info: { icon: "info", tone: "bg-soft text-ink-2", label: "Reviewed" },
};

const SUGGESTIONS = ["What needs my attention?", "Which disputes can I win?", "What did you refund today?", "What's my refund limit?"];

function AgentConversation() {
  const params = useSearchParams();
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [pending, setPending] = useState<Message | null>(null);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const asked = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await api<{ messages: Message[]; unread: number }>("/agent/messages");
      setMessages(r.messages);
      if (r.unread) {
        await api("/agent/messages/read", { method: "POST" });
        window.dispatchEvent(new CustomEvent("agent-read"));
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  async function send(text: string) {
    const q = text.trim();
    if (!q || thinking) return;
    setInput("");
    setThinking(true);
    setPending({ id: "pending", role: "owner", kind: "chat", content: q, created_at: new Date().toISOString(), cards: [] });
    try {
      await api("/agent/chat", json({ content: q }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      await load();
      setPending(null);
      setThinking(false);
    }
  }

  async function clearHistory() {
    try {
      await api("/agent/messages/clear", { method: "POST" });
      window.dispatchEvent(new CustomEvent("agent-read"));
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    const q = params.get("q");
    if (q && !asked.current && messages) {
      asked.current = true;
      send(q);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, messages]);

  const count = (messages?.length ?? 0) + (pending ? 1 : 0);
  useEffect(() => {
    // Braces matter: scrollIntoView can return a Promise, and an effect may only return a cleanup function.
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [count, thinking]);

  const all = [...(messages ?? []), ...(pending ? [pending] : [])];

  return (
    <div className="mx-auto flex h-[calc(100vh-170px)] max-w-3xl flex-col rounded-2xl border border-line bg-card shadow-sm">
      {all.length > 0 && (
        <div className="flex justify-end border-b border-line px-4 py-2">
          <button onClick={clearHistory} disabled={thinking} className="text-xs text-muted hover:text-ink disabled:opacity-50">
            Clear history
          </button>
        </div>
      )}
      <div className="flex-1 space-y-5 overflow-y-auto p-5">
        {messages && all.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <span className="grid h-12 w-12 place-items-center rounded-2xl bg-primary-fixed text-primary"><Icon name="smart_toy" /></span>
            <div>
              <p className="text-lg font-semibold">Your dispute agent</p>
              <p className="mx-auto max-w-sm text-sm text-muted">
                When a dispute arrives, I review it right away. I refund it if it&rsquo;s within your limit, or ask you here if it isn&rsquo;t.
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)} className="rounded-full border border-cream-line bg-cream px-3 py-1.5 text-sm hover:bg-[#f5f0d6]">{s}</button>
              ))}
            </div>
          </div>
        )}

        {all.map((m) =>
          m.role === "owner" ? (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[80%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-white">{m.content}</div>
            </div>
          ) : (
            <AgentMessage key={m.id} m={m} onChanged={load} />
          ),
        )}

        {thinking && (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Icon name="progress_activity" className="animate-spin text-[18px]" /> Checking PayPal…
          </div>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
        <div ref={bottom} />
      </div>

      <form className="flex gap-2 border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); send(input); }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask or instruct the agent…"
          className="min-w-0 flex-1 rounded-xl border border-line-strong px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-container"
        />
        <Button variant="primary" disabled={thinking || !input.trim()} aria-label="Send">
          <Icon name="arrow_upward" className="text-[18px]" />
        </Button>
      </form>
    </div>
  );
}

function AgentMessage({ m, onChanged }: { m: Message; onChanged: () => void }) {
  const k = m.kind === "chat" ? null : KIND[m.kind] ?? KIND.info;
  return (
    <div className="flex gap-2.5">
      <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${k ? k.tone : "bg-primary-fixed text-primary"}`}>
        <Icon name={k ? k.icon : "smart_toy"} className="text-[18px]" />
      </span>
      <div className="min-w-0 max-w-[85%] space-y-2">
        <div className="flex items-center gap-2 text-[11px] text-muted">
          {k && <span className="font-bold uppercase tracking-wider text-ink-2">{k.label}</span>}
          <span className="font-mono">{new Date(m.created_at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}</span>
          {m.unread && <span className="h-1.5 w-1.5 rounded-full bg-coral" aria-label="new" />}
        </div>
        <div className="whitespace-pre-wrap rounded-2xl rounded-tl-md bg-soft px-4 py-2.5 text-sm">{m.content}</div>
        {m.cards.map((c) => <DisputeCard key={c.dispute_id} c={c} decision={m.kind === "decision"} onChanged={onChanged} />)}
      </div>
    </div>
  );
}

function DisputeCard({ c, decision, onChanged }: { c: Card; decision: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const a = agentState({ status: c.status, draft_status: c.draft_status, draft_action: c.action });
  const awaiting = c.draft_status === "awaiting_approval" || c.draft_status === "failed";
  const finished = c.status === "RESOLVED" || c.draft_status === "submitted";
  const approveLabel =
    c.action === "accept_claim" ? `Approve refund of ${money(c.amount, c.currency)}`
    : c.action === "make_offer" ? `Approve offer of ${money(c.offer_amount, c.currency)}`
    : "Approve and send proof";

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
      window.dispatchEvent(new CustomEvent("disputes-synced"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-line bg-card p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/disputes/${c.dispute_id}`} className="block truncate text-sm font-medium hover:underline">{c.reason}</Link>
          <div className="mt-0.5 flex items-center gap-2">
            <span className="font-mono text-xs font-semibold">{money(c.amount, c.currency)}</span>
            <Pill tone={c.archived ? "soft" : a.tone}>{c.archived ? "Cleared" : a.label}</Pill>
          </div>
        </div>
        {!awaiting && finished && !c.archived && (
          <Button onClick={() => run(() => api(`/disputes/${c.dispute_id}/clear`, { method: "POST" }))} disabled={busy} className="shrink-0 px-2.5 py-1 text-xs">
            <Icon name="inventory_2" className="text-[16px]" /> Clear
          </Button>
        )}
        {!awaiting && !finished && (
          <Button href={`/disputes/${c.dispute_id}`} className="shrink-0 px-2.5 py-1 text-xs">Open</Button>
        )}
      </div>
      {awaiting && c.draft_id && c.payload_hash && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
          {decision && c.status === "WAITING_FOR_SELLER_RESPONSE" ? (
            <>
              <Button variant="primary" disabled={busy} className="px-3 py-1.5 text-xs"
                onClick={() => run(() => api(`/drafts/${c.draft_id}/approve`, json({ payload_hash: c.payload_hash, acknowledge_past_due: false })))}>
                <Icon name="check" className="text-[16px]" /> {busy ? "Sending" : approveLabel}
              </Button>
              <Button variant="ghost" disabled={busy} className="px-2 py-1.5 text-xs text-danger"
                onClick={() => run(() => api(`/drafts/${c.draft_id}/reject`, { method: "POST" }))}>
                Decline
              </Button>
            </>
          ) : null}
          <Button variant="ghost" href={`/disputes/${c.dispute_id}/approve`} className="px-2 py-1.5 text-xs">
            Details &amp; edit
          </Button>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  );
}

export default function AgentPage() {
  return (
    <Suspense>
      <AgentConversation />
    </Suspense>
  );
}
