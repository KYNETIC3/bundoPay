"use client";

import Link from "next/link";

import { money } from "@/lib/format";
import { agentState, disputeStatus } from "@/lib/status";
import type { DisputeSummary } from "@/lib/types";

import { Countdown } from "./Countdown";
import { Button, Pill } from "./ui";

export function DisputeTable({ items }: { items: DisputeSummary[] }) {
  return (
    <div className="-mx-7 overflow-x-auto">
      <table className="w-full min-w-[680px] border-collapse text-left text-sm">
        <thead>
          <tr className="text-[13px] font-medium text-muted">
            <th className="px-7 pb-3 font-medium">Dispute</th>
            <th className="px-4 pb-3 text-right font-medium">Amount</th>
            <th className="px-4 pb-3 font-medium">Status</th>
            <th className="px-4 pb-3 font-medium">Deadline</th>
            <th className="px-4 pb-3 font-medium">Agent</th>
            <th className="px-7 pb-3 text-right" aria-label="Action" />
          </tr>
        </thead>
        <tbody>
          {items.map((d) => {
            const s = disputeStatus(d.status);
            const a = agentState({ status: d.status, draft_status: d.draft_status ?? null, draft_action: d.draft_action ?? null });
            const ready = d.draft_status === "awaiting_approval" && d.status !== "RESOLVED";
            return (
              <tr key={d.id} className="border-t border-ink/[0.06] transition-colors hover:bg-[#f8fbfc]">
                <td className="px-7 py-4">
                  <Link href={`/disputes/${d.id}`} className="font-semibold text-ink hover:text-primary">
                    {d.reason_label ?? "Dispute"}
                  </Link>
                  <div className="mt-1 text-xs text-muted">{d.paypal_dispute_id}</div>
                </td>
                <td className="px-4 py-4 text-right font-semibold tabular-nums">{money(d.amount, d.currency)}</td>
                <td className="px-4 py-4"><Pill tone={s.tone}>{s.label}</Pill></td>
                <td className="px-4 py-4">{d.status === "RESOLVED" ? <span className="text-muted">—</span> : <Countdown due={d.due_date} />}</td>
                <td className="px-4 py-4"><Pill tone={a.tone}>{a.label}</Pill></td>
                <td className="px-7 py-4 text-right">
                  {ready ? (
                    <Button variant="primary" href={`/disputes/${d.id}/approve`} className="min-h-8 px-3.5 text-[13px]">Review</Button>
                  ) : (
                    <Button href={`/disputes/${d.id}`} className="min-h-8 px-3.5 text-[13px]">Open</Button>
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
