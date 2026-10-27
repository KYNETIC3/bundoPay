"use client";

import type { AgLlmAdapter, AgLlmRequest, AgLlmResponse } from "ag-studio";

import { supabase } from "@/lib/supabase";

type Output = AgLlmResponse["output"][number];
type StudioEvent = Record<string, unknown> & { type: string };

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

/** What the backend streams from `POST /agent/studio/turn` (one JSON object per SSE `data:` line). */
type Wire =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "done"; usage?: { input_tokens?: number; output_tokens?: number } }
  | { type: "error"; message: string };

/** AG Studio's AI never talks to a model itself: this adapter sends each chart-building turn to BundoPay's backend,
 * which runs it on the same model as Ask Bundo with the keys kept server-side. The route only ever returns widget
 * specs; it has no way to move money or answer disputes. */
export const bundoAdapter: AgLlmAdapter = {
  executeTurn(request: AgLlmRequest, options) {
    const queue: StudioEvent[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    const push = (e: StudioEvent) => {
      queue.push(e);
      wake?.();
    };
    const end = () => {
      finished = true;
      wake?.();
    };

    const complete = (async (): Promise<AgLlmResponse> => {
      const id = crypto.randomUUID();
      const msgId = `msg-${id}`;
      const output: Output[] = [];
      let text = "";
      let started = false;
      let usage: AgLlmResponse["usage"];
      try {
        const { data } = await supabase().auth.getSession();
        const res = await fetch(`${BASE}/agent/studio/turn`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...(data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {}) },
          body: JSON.stringify({ instructions: request.instructions, conversation: request.input, tools: request.tools ?? [], output_format: request.responseFormat, tool_choice: request.toolChoice }),
          signal: options?.signal,
        });
        if (!res.ok || !res.body) throw new Error(res.status === 404 ? "Chart building isn't switched on for this server yet." : `Bundo couldn't build that (${res.status}).`);
        for await (const w of sse(res.body)) {
          if (w.type === "text_delta") {
            if (!started) push({ type: "TEXT_MESSAGE_START", messageId: msgId, role: "assistant" });
            started = true;
            text += w.text;
            push({ type: "TEXT_MESSAGE_CONTENT", messageId: msgId, delta: w.text });
          } else if (w.type === "tool_call") {
            push({ type: "TOOL_CALL_START", toolCallId: w.id, toolCallName: w.name });
            push({ type: "TOOL_CALL_ARGS", toolCallId: w.id, delta: w.arguments });
            push({ type: "TOOL_CALL_END", toolCallId: w.id });
            output.push({ id: w.id, kind: "output", type: "function_call", callId: w.id, name: w.name, arguments: w.arguments, status: "completed" });
          } else if (w.type === "done") {
            usage = { inputTokens: w.usage?.input_tokens ?? 0, outputTokens: w.usage?.output_tokens ?? 0 };
          } else if (w.type === "error") {
            throw new Error(w.message);
          }
        }
        if (started) {
          push({ type: "TEXT_MESSAGE_END", messageId: msgId });
          output.unshift({ id: msgId, kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text, annotations: [] }] });
        }
        return { id, createdAt: Date.now(), output, status: "completed", usage };
      } catch (e) {
        const cancelled = options?.signal?.aborted;
        push({ type: "RUN_ERROR", message: (e as Error).message });
        return { id, createdAt: Date.now(), output, status: cancelled ? "cancelled" : "failed", error: { code: cancelled ? "cancelled" : "error", message: (e as Error).message } };
      } finally {
        end();
      }
    })();

    const stream = {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (queue.length) {
            yield queue.shift()!;
            continue;
          }
          if (finished) return;
          await new Promise<void>((r) => (wake = r));
          wake = null;
        }
      },
    };
    return { stream, complete } as unknown as ReturnType<AgLlmAdapter["executeTurn"]>;
  },
};

async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<Wire> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      let at: number;
      while ((at = buffer.indexOf("\n\n")) >= 0) {
        const data = buffer.slice(0, at).split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        buffer = buffer.slice(at + 2);
        if (data) yield JSON.parse(data) as Wire;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
