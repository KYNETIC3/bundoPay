"use client";

import Link from "next/link";

import { money } from "@/lib/format";
import { agentState, disputeStatus } from "@/lib/status";
import type { DisputeSummary } from "@/lib/types";

import { Countdown } from "./Countdown";
import { Button, Pill } from "./ui";

export function DisputeTable({ items }: { items: DisputeSummary[] }) {
  return (
    <div className="-mx-5 overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-y border-line bg-soft text-[11px] font-bold uppercase tracking-wider text-ink-2">
            <th className="px-5 py-2.5">Dispute</th>
            <th className="px-3 py-2.5 text-right">Amount</th>
            <th className="px-3 py-2.5">Status</th>
            <th className="px-3 py-2.5">Deadline</th>
            <th className="px-3 py-2.5">Agent</th>
            <th className="px-5 py-2.5 text-right" aria-label="Action" />
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {items.map((d) => {
            const s = disputeStatus(d.status);
            const a = agentState({ status: d.status, draft_status: d.draft_status ?? null, draft_action: d.draft_action ?? null });
            const ready = d.draft_status === "awaiting_approval" && d.status !== "RESOLVED";
            return (
              <tr key={d.id} className="transition-colors hover:bg-cream">
                <td className="px-5 py-3">
                  <Link href={`/disputes/${d.id}`} className="font-medium hover:underline">
                    {d.reason_label ?? "Dispute"}
                  </Link>
                  <div className="font-mono text-[11px] text-muted">{d.paypal_dispute_id}</div>
                </td>
                <td className="px-3 py-3 text-right font-mono font-semibold tabular-nums">{money(d.amount, d.currency)}</td>
                <td className="px-3 py-3"><Pill tone={s.tone}>{s.label}</Pill></td>
                <td className="px-3 py-3">{d.status === "RESOLVED" ? <span className="text-muted">—</span> : <Countdown due={d.due_date} />}</td>
                <td className="px-3 py-3"><Pill tone={a.tone}>{a.label}</Pill></td>
                <td className="px-5 py-3 text-right">
                  {ready ? (
                    <Button variant="primary" href={`/disputes/${d.id}/approve`} className="px-2.5 py-1 text-xs">Review</Button>
                  ) : (
                    <Button href={`/disputes/${d.id}`} className="px-2.5 py-1 text-xs">Open</Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
