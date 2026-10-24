"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";

import { PlanApproval } from "@/components/treasury";
import { Button, Icon, Pill, SendButton } from "@/components/ui";
import { api, json } from "@/lib/api";
import { money } from "@/lib/format";
import { agentState } from "@/lib/status";
import type { PlanItem } from "@/lib/treasury";

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
type PlanMeta = { plan_id: string; plan_hash: string; total: string; items: PlanItem[]; status: string };
type Message = {
  id: number | string;
  role: "agent" | "owner";
  kind: string;
  content: string;
  created_at: string;
  unread?: boolean;
  cards: Card[];
  plan?: PlanMeta | null;
};

// How each kind of Bundo update looks: what happened at a glance.
const KIND: Record<string, { icon: string; tone: string; label: string }> = {
  auto_refund: { icon: "currency_exchange", tone: "bg-ink text-white", label: "Refunded" },
  decision: { icon: "approval", tone: "bg-primary text-white", label: "Needs your OK" },
  treasury_approval: { icon: "account_balance", tone: "bg-primary text-white", label: "Treasury: needs your OK" },
  submitted: { icon: "send", tone: "bg-primary-fixed text-primary", label: "Sent" },
  outcome: { icon: "flag", tone: "bg-soft text-ink-2", label: "Closed" },
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
    <div className="mx-auto flex h-[calc(100vh-220px)] min-h-[480px] max-w-[820px] flex-col rounded-3xl bg-card shadow-card ring-1 ring-ink/40">
      {all.length > 0 && (
        <div className="flex justify-end border-b border-ink/[0.06] px-6 py-2.5 sm:px-8">
          <button onClick={clearHistory} disabled={thinking} className="text-[13px] font-medium text-muted hover:text-ink disabled:opacity-50">
            Clear history
          </button>
        </div>
      )}
      <div className="flex-1 space-y-6 overflow-y-auto p-6 sm:p-8">
        {messages && all.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-5 text-center">
            <span className="grid h-12 w-12 place-items-center rounded-full bg-ink text-ice"><Icon name="auto_awesome" /></span>
            <p className="text-lg font-semibold">Ask Bundo about your disputes</p>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)} className="min-h-9 rounded-full bg-soft px-3.5 text-[13px] font-medium text-ink-2 hover:bg-primary-fixed hover:text-ink">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {all.map((m) =>
          m.role === "owner" ? (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[72%] rounded-[20px] rounded-br-md bg-primary px-[18px] py-3.5 text-[15px] leading-normal text-white">{m.content}</div>
            </div>
          ) : (
            <AgentMessage key={m.id} m={m} onChanged={load} />
          ),
        )}

        {thinking && (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Icon name="progress_activity" className="animate-spin text-[18px]" /> Bundo is checking PayPal…
          </div>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
        <div ref={bottom} />
      </div>

      <form
        className="flex items-center gap-2 border-t border-ink/[0.06] p-4 sm:px-8 sm:py-6"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message Bundo"
          aria-label="Message Bundo"
          className="min-h-12 min-w-0 flex-1 rounded-full bg-card px-5 text-[15px] ring-1 ring-inset ring-ink/40 placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-primary"
        />
        <SendButton disabled={thinking || !input.trim()} />
      </form>
    </div>
  );
}

function AgentMessage({ m, onChanged }: { m: Message; onChanged: () => void }) {
  const k = m.kind === "chat" ? null : KIND[m.kind] ?? KIND.info;
  return (
    <div className="flex gap-3">
      <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${k ? k.tone : "bg-ink text-ice"}`}>
        <Icon name={k ? k.icon : "auto_awesome"} className="text-[16px]" />
      </span>
      <div className="min-w-0 max-w-[88%] space-y-2.5">
        <div className="flex items-center gap-2 text-xs text-muted">
          {k && <span className="font-semibold text-ink-2">{k.label}</span>}
          <span className="tabular-nums">{new Date(m.created_at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}</span>
          {m.unread && <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-label="new" />}
        </div>
        <div className="whitespace-pre-wrap rounded-[20px] rounded-tl-md bg-page px-[18px] py-4 text-[15px] leading-relaxed">{m.content}</div>
        {m.cards.map((c) => <DisputeCard key={c.dispute_id} c={c} decision={m.kind === "decision"} onChanged={onChanged} />)}
        {m.plan && <PlanApproval plan={m.plan} onDone={onChanged} />}
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
    <div className="rounded-[14px] bg-card px-4 py-3 ring-1 ring-ink/[0.12]">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Link href={`/disputes/${c.dispute_id}`} className="block truncate text-sm font-semibold text-ink hover:text-primary">{c.reason}</Link>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="text-[13px] font-semibold tabular-nums">{money(c.amount, c.currency)}</span>
            <Pill tone={c.archived ? "soft" : a.tone}>{c.archived ? "Cleared" : a.label}</Pill>
          </div>
        </div>
        {!awaiting && finished && !c.archived && (
          <Button onClick={() => run(() => api(`/disputes/${c.dispute_id}/clear`, { method: "POST" }))} disabled={busy} className="min-h-8 shrink-0 px-3.5 text-[13px]">
            <Icon name="inventory_2" className="text-[16px]" /> Clear
          </Button>
        )}
        {!awaiting && !finished && (
          <Button href={`/disputes/${c.dispute_id}`} className="min-h-8 shrink-0 px-3.5 text-[13px]">Open</Button>
        )}
      </div>
      {awaiting && c.draft_id && c.payload_hash && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-ink/[0.06] pt-3">
          {decision && c.status === "WAITING_FOR_SELLER_RESPONSE" ? (
            <>
              <Button variant="primary" disabled={busy} className="min-h-8 px-3.5 text-[13px]"
                onClick={() => run(() => api(`/drafts/${c.draft_id}/approve`, json({ payload_hash: c.payload_hash, acknowledge_past_due: false })))}>
                <Icon name="check" className="text-[16px]" /> {busy ? "Sending" : approveLabel}
              </Button>
              <Button variant="ghost" disabled={busy} className="min-h-8 text-[13px] text-danger"
                onClick={() => run(() => api(`/drafts/${c.draft_id}/reject`, { method: "POST" }))}>
                Decline
              </Button>
            </>
          ) : null}
          <Button variant="ghost" href={`/disputes/${c.dispute_id}/approve`} className="min-h-8 text-[13px]">
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
