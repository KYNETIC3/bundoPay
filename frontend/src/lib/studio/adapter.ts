"use client";

import type { AgAiEvent, AgLlmAdapter, AgLlmRequest, AgLlmResponse, AgLlmResponseHandler } from "ag-studio";

import { supabase } from "@/lib/supabase";

type Output = AgLlmResponse["output"][number];

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

/** What the backend streams from `POST /agent/studio/turn` (one JSON object per SSE `data:` line). */
type Wire =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string; thought_signature?: string | null }
  | { type: "done"; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }
  | { type: "error"; message: string };

/** A `delegate_to` call runs a sub-agent on its own thread, `${callId}-sub`. Its turns belong to the dashboard
 * that delegated, so they're counted under that dashboard's chart id: sub-thread -> root chart id. */
const parentChart = new Map<string, string>();

/** AG Studio's AI never talks to a model itself: this adapter sends each chart-building turn to BundoPay's backend,
 * which runs it on the same model as Ask Bundo with the keys kept server-side. The route only ever returns widget
 * specs; it has no way to move money or answer disputes. */
export const bundoAdapter: AgLlmAdapter = {
  executeTurn(request: AgLlmRequest, options): AgLlmResponseHandler {
    // One chart (or one dashboard) is one conversation thread. It takes many model turns, and the backend counts
    // it once against the merchant's AI limit by this id, so a whole dashboard costs the same as one chart.
    const trace = options?.trace ?? { threadId: crypto.randomUUID(), runId: crypto.randomUUID() };
    const chartId = parentChart.get(trace.threadId) ?? trace.threadId;
    const queue: AgAiEvent[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    const push = (e: AgAiEvent) => {
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
      push({ type: "RUN_STARTED", threadId: trace.threadId, runId: trace.runId });
      try {
        const { data } = await supabase().auth.getSession();
        const res = await fetch(`${BASE}/agent/studio/turn`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream", "X-Bundo-Chart-Id": chartId, ...(data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {}) },
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
            if (w.name === "delegate_to") parentChart.set(`${w.id}-sub`, chartId);
            push({ type: "TOOL_CALL_START", toolCallId: w.id, toolCallName: w.name });
            push({ type: "TOOL_CALL_ARGS", toolCallId: w.id, delta: w.arguments });
            push({ type: "TOOL_CALL_END", toolCallId: w.id });
            // Gemini needs its signature echoed back on the call next turn to keep its reasoning.
            const call: Output & { thought_signature?: string } = { id: w.id, kind: "output", type: "function_call", callId: w.id, name: w.name, arguments: w.arguments, status: "completed" };
            if (w.thought_signature) call.thought_signature = w.thought_signature;
            output.push(call);
          } else if (w.type === "done") {
            usage = { inputTokens: w.usage?.inputTokens ?? 0, outputTokens: w.usage?.outputTokens ?? 0, totalTokens: w.usage?.totalTokens };
          } else if (w.type === "error") {
            throw new Error(w.message);
          }
        }
        if (started) {
          push({ type: "TEXT_MESSAGE_END", messageId: msgId });
          output.unshift({ id: msgId, kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text, annotations: [] }] });
        }
        push({ type: "RUN_FINISHED", threadId: trace.threadId, runId: trace.runId });
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
      async *[Symbol.asyncIterator](): AsyncGenerator<AgAiEvent> {
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
    return { stream, complete };
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
