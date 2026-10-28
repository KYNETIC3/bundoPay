"use client";

import type { AgDataSourcesDefinition } from "ag-studio";

import { bundoAdapter } from "./adapter";
import type { Widget } from "./boards";

/** Ask Bundo for a chart in one model call. The model only picks from BundoPay's own fields and a short list of
 * chart types; this file turns its answer into an AG Studio widget, so a bad answer can't produce a broken board. */

const TYPES = ["bar-chart-grouped", "column-chart-grouped", "line-chart", "pie-chart", "donut-chart", "value"] as const;
const AGGS = ["sum", "avg", "count", "min", "max"] as const;

type Spec = { type: (typeof TYPES)[number]; title: string; category?: string; value: string; aggregation: (typeof AGGS)[number]; legend?: string };

const SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", enum: [...TYPES] },
    title: { type: "string", description: "Short plain-English title, under 40 characters" },
    category: { type: "string", description: "table.field to group by. Required unless type is value" },
    value: { type: "string", description: "table.field to measure" },
    aggregation: { type: "string", enum: [...AGGS] },
    legend: { type: "string", description: "Optional table.field to split each bar or line by" },
  },
  required: ["type", "title", "value", "aggregation"],
};

function fieldList(model: AgDataSourcesDefinition) {
  const out: { id: string; label: string; numeric: boolean }[] = [];
  for (const src of model.sources as { id: string; name?: string; fields?: { id: string; name?: string; format?: string }[] }[]) {
    for (const f of src.fields ?? []) {
      const numeric = /currency|integer|percentage|number/i.test(f.format ?? "");
      out.push({ id: `${src.id}.${f.id}`, label: `${src.name ?? src.id} → ${f.name ?? f.id}${numeric ? " (number)" : f.format?.startsWith("date") ? " (date)" : ""}`, numeric });
    }
  }
  return out;
}

export async function describeChart(question: string, model: AgDataSourcesDefinition, signal?: AbortSignal): Promise<Widget> {
  const fields = fieldList(model);
  const turn = bundoAdapter.executeTurn(
    {
      instructions:
        "You pick one chart that answers a small business owner's question about their money and PayPal disputes. " +
        "Use only these fields (write them exactly as table.field):\n" +
        fields.map((f) => `- ${f.id}: ${f.label}`).join("\n") +
        "\nPrefer a bar chart for comparing groups, a line chart for change over days, and a value tile for a single number. " +
        "The value field must be a number unless the aggregation is count. Answer with JSON only.",
      input: [{ id: "q", kind: "input", type: "message", role: "user", status: "completed", content: [{ type: "text", text: question }] }],
      responseFormat: { type: "json", name: "chart", schema: SCHEMA },
    } as Parameters<typeof bundoAdapter.executeTurn>[0],
    // A quick chart is a single turn on its own thread, so it counts once.
    { signal, trace: { threadId: crypto.randomUUID(), runId: crypto.randomUUID(), agentId: "quick-chart" } },
  );
  const res = await turn.complete;
  if (res.error) throw new Error(res.error.message);
  const text = res.output
    .flatMap((o) => (o.type === "message" ? o.content : []))
    .map((c) => ("text" in c ? c.text : ""))
    .join("")
    .replace(/^```(json)?|```$/g, "")
    .trim();
  let spec: Spec;
  try {
    spec = JSON.parse(text) as Spec;
  } catch {
    throw new Error("Bundo couldn’t work out a chart for that. Try naming what to compare, like “disputes by reason”.");
  }
  return toWidget(spec, new Set(fields.map((f) => f.id)));
}

function toWidget(spec: Spec, known: Set<string>): Widget {
  const ok = (id?: string) => !!id && known.has(id);
  const type = TYPES.includes(spec.type) ? spec.type : "bar-chart-grouped";
  const aggregation = AGGS.includes(spec.aggregation) ? spec.aggregation : "sum";
  if (!ok(spec.value)) throw new Error("Bundo picked data BundoPay doesn’t have. Try asking another way.");
  const format = { title: { enabled: true, text: spec.title?.slice(0, 60) || "Your chart" }, crossFilter: "filter" as const };
  if (type === "value") return { type, dataMapping: { value: [{ id: spec.value, aggregation }] }, format } as Widget;
  if (!ok(spec.category)) throw new Error("Bundo couldn’t tell what to group by. Try saying “by reason” or “by day”.");
  const legend = ok(spec.legend) && spec.legend !== spec.category ? { legendKey: [{ id: spec.legend! }] } : {};
  const lineish = type === "line-chart" || type === "column-chart-grouped";
  return {
    type,
    dataMapping: { categoryKey: [{ id: spec.category! }], valueKey: [{ id: spec.value, aggregation }], ...legend },
    ...(lineish ? { sort: [{ field: { id: spec.category! }, direction: "asc" }] } : {}),
    format,
  } as Widget;
}
