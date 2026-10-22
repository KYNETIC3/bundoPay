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
    <div className="mx-auto flex h-[calc(100vh-220px)] min-h-[480px] max-w-[820px] flex-col rounded-3xl bg-card shadow-card">
      <div className="flex-1 space-y-6 overflow-y-auto p-6 sm:p-8">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-5 text-center">
            <span className="grid h-12 w-12 place-items-center rounded-full bg-ink text-ice"><Icon name="auto_awesome" /></span>
            <div>
              <p className="text-lg font-semibold">Ask about your disputes</p>
              <p className="mt-1 text-sm text-muted">Try one of these, or ask in your own words.</p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)} className="min-h-9 rounded-full bg-soft px-3.5 text-[13px] font-medium text-ink-2 hover:bg-primary-fixed hover:text-ink">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) =>
          m.role === "owner" ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[72%] rounded-[20px] rounded-br-md bg-primary px-[18px] py-3.5 text-[15px] leading-normal text-white">{m.content}</div>
            </div>
          ) : (
            <div key={i} className="flex gap-3">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ink text-ice"><Icon name="auto_awesome" className="text-[16px]" /></span>
              <div className="min-w-0 max-w-[88%] space-y-2.5">
                <div className="whitespace-pre-wrap rounded-[20px] rounded-bl-md bg-page px-[18px] py-4 text-[15px] leading-relaxed">{m.content}</div>
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
        className="flex items-center gap-2 border-t border-ink/[0.06] p-4 sm:px-8 sm:py-6"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask in plain words…"
          aria-label="Message the agent"
          className="min-h-12 min-w-0 flex-1 rounded-full bg-page px-5 text-[15px] ring-1 ring-inset ring-ink/[0.06] placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-aqua"
        />
        <Button variant="primary" disabled={busy || !input.trim()} aria-label="Send" className="h-11 w-11 shrink-0 px-0">
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
    <div className="flex items-center justify-between gap-4 rounded-[14px] bg-card px-4 py-3 ring-1 ring-ink/[0.06]">
      <div className="min-w-0">
        <Link href={`/disputes/${c.dispute_id}`} className="block truncate text-sm font-semibold text-ink hover:text-primary">{c.reason}</Link>
        <div className="mt-1.5 flex items-center gap-2">
          <span className="text-[13px] font-semibold tabular-nums">{money(c.amount, c.currency)}</span>
          <Pill tone={a.tone}>{a.label}</Pill>
        </div>
      </div>
      {ready ? (
        <Button variant="primary" href={`/disputes/${c.dispute_id}/approve`} className="min-h-8 shrink-0 px-3.5 text-[13px]">Review</Button>
      ) : (
        <Button href={`/disputes/${c.dispute_id}`} className="min-h-8 shrink-0 px-3.5 text-[13px]">Open</Button>
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
