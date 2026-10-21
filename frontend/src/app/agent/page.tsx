"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";

import { Button, Icon, Pill } from "@/components/ui";
import { api, json } from "@/lib/api";
import { money } from "@/lib/format";
import { agentState } from "@/lib/status";

type ChatCard = {
  dispute_id: string;
  paypal_dispute_id: string;
  amount: string | null;
  currency: string | null;
  reason: string | null;
  status: string;
  draft_id: string | null;
  action: string | null;
  draft_status: string | null;
};
type Message = { role: "owner" | "agent"; content: string; cards?: ChatCard[] };

const SUGGESTIONS = [
  "What needs my attention today?",
  "Refund every dispute under $20",
  "Which disputes can I win?",
  "What's my refund limit?",
];

function AgentChat() {
  const params = useSearchParams();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const asked = useRef(false);

  async function send(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    const next: Message[] = [...messages, { role: "owner", content: q }];
    setMessages(next);
    setInput("");
    setBusy(true);
    try {
      const r = await api<{ reply: string; cards: ChatCard[] }>(
        "/agent/chat",
        json({ messages: next.map(({ role, content }) => ({ role, content })) }),
      );
      setMessages([...next, { role: "agent", content: r.reply, cards: r.cards }]);
    } catch (e) {
      setMessages([...next, { role: "agent", content: `Sorry, that didn't work: ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const q = params.get("q");
    if (q && !asked.current) {
      asked.current = true;
      send(q);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  useEffect(() => {
    // Braces matter: scrollIntoView can return a Promise, and an effect may only return a cleanup function.
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  return (
    <div className="mx-auto flex h-[calc(100vh-170px)] max-w-3xl flex-col rounded-2xl border border-line bg-card shadow-sm">
      <div className="flex-1 space-y-4 overflow-y-auto p-5">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <span className="grid h-12 w-12 place-items-center rounded-2xl bg-primary-fixed text-primary"><Icon name="smart_toy" /></span>
            <div>
              <p className="text-lg font-semibold">Ask about your disputes</p>
              <p className="text-sm text-muted">The agent can explain cases and prepare refunds. You approve before money moves.</p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)} className="rounded-full border border-cream-line bg-cream px-3 py-1.5 text-sm hover:bg-[#f5f0d6]">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) =>
          m.role === "owner" ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[80%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-white">{m.content}</div>
            </div>
          ) : (
            <div key={i} className="flex gap-2.5">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary-fixed text-primary"><Icon name="smart_toy" className="text-[18px]" /></span>
              <div className="min-w-0 max-w-[85%] space-y-2">
                <div className="whitespace-pre-wrap rounded-2xl rounded-tl-md bg-soft px-4 py-2.5 text-sm">{m.content}</div>
                {m.cards?.map((c) => <DisputeCard key={c.dispute_id} c={c} />)}
              </div>
            </div>
          ),
        )}
        {busy && (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Icon name="progress_activity" className="animate-spin text-[18px]" /> Agent is checking PayPal…
          </div>
        )}
        <div ref={bottom} />
      </div>
      <form
        className="flex gap-2 border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask in plain words…"
          className="min-w-0 flex-1 rounded-xl border border-line-strong px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-container"
        />
        <Button variant="primary" disabled={busy || !input.trim()} aria-label="Send">
          <Icon name="arrow_upward" className="text-[18px]" />
        </Button>
      </form>
    </div>
  );
}

function DisputeCard({ c }: { c: ChatCard }) {
  const a = agentState({ status: c.status, draft_status: c.draft_status, draft_action: c.action });
  const ready = c.draft_status === "awaiting_approval" && c.status !== "RESOLVED";
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-card px-3 py-2.5">
      <div className="min-w-0">
        <Link href={`/disputes/${c.dispute_id}`} className="block truncate text-sm font-medium hover:underline">{c.reason}</Link>
        <div className="mt-0.5 flex items-center gap-2">
          <span className="font-mono text-xs font-semibold">{money(c.amount, c.currency)}</span>
          <Pill tone={a.tone}>{a.label}</Pill>
        </div>
      </div>
      {ready ? (
        <Button variant="primary" href={`/disputes/${c.dispute_id}/approve`} className="shrink-0 px-2.5 py-1 text-xs">Review</Button>
      ) : (
        <Button href={`/disputes/${c.dispute_id}`} className="shrink-0 px-2.5 py-1 text-xs">Open</Button>
      )}
    </div>
  );
}

export default function AgentPage() {
  return (
    <Suspense>
      <AgentChat />
    </Suspense>
  );
}
