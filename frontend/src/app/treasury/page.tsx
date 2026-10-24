"use client";

import Link from "next/link";
import { useState } from "react";

import { LiveLog, PlanApproval, PositionCards } from "@/components/treasury";
import { Button, Card, CardTitle, Empty, Icon, Pill, type Tone } from "@/components/ui";
import { dateTime, money } from "@/lib/format";
import { useLive } from "@/lib/hooks";
import {
  CHECK_LABELS, type FeedEntry, KIND_LABELS, type Overview, type Policy, type PolicyKind, ROLE_LABELS, active, changed,
  latest, treasury,
} from "@/lib/treasury";

const STATUS_TONE: Record<Policy["status"], Tone> = { active: "cerulean", paused: "cream", draft: "soft", retired: "soft" };
const VERDICT_TONE: Record<string, Tone> = { allow: "cerulean", ask: "plum", block: "danger" };
const KINDS: PolicyKind[] = ["tax_reserve", "dispute_buffer", "ad_sweep", "rebalance"];

export default function TreasuryPage() {
  const { data, error, reload } = useLive<Overview>("/treasury/overview", 15_000);
  const feed = useLive<{ entries: FeedEntry[] }>("/treasury/feed", 10_000);

  if (error) return <Card><p className="text-sm text-danger">{error}</p></Card>;
  if (!data) return <Card><p className="text-sm text-muted">Loading your treasury…</p></Card>;

  const currency = data.limits.currency;
  const pending = data.plans.filter((p) => p.status === "needs_approval");
  const needsSetup = !data.accounts.some((a) => a.role === "operating") || data.accounts.every((a) => !a.verified_at);
  const missing = KINDS.filter((k) => !data.policies.some((p) => p.kind === k));

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="min-w-0 space-y-6">
        {needsSetup ? (
          <Card>
            <Empty icon="account_balance" title="Add your treasury accounts">
              Add an Operating account and the reserve accounts sweeps go to, then verify each one. Nothing can move until a
              destination is verified.
              <div className="mt-4"><Button variant="primary" href="/treasury/setup">Set up accounts</Button></div>
            </Empty>
          </Card>
        ) : (
          <PositionCards positions={data.positions} floor={data.limits.liquidity_floor} currency={currency} />
        )}

        {pending.length > 0 && (
          <Card>
            <CardTitle>Needs your approval</CardTitle>
            <div className="space-y-3">
              {pending.map((p) => (
                <div key={p.id} className="space-y-1.5">
                  <p className="text-xs text-muted">{p.reason} · expires {dateTime(p.expires_at)}</p>
                  <PlanApproval
                    plan={{ plan_id: p.id, plan_hash: p.plan_hash, total: p.total, items: p.items_json, status: p.status }}
                    currency={currency}
                    onDone={reload}
                  />
                </div>
              ))}
            </div>
          </Card>
        )}

        <Card>
          <CardTitle action={<Button variant="ghost" href="/treasury/setup"><Icon name="tune" className="text-[18px]" /> Accounts &amp; limits</Button>}>
            Policies
          </CardTitle>
          <div className="divide-y divide-ink/[0.06]">
            {data.policies.map((p) => <PolicyRow key={p.id} p={p} currency={currency} onChanged={reload} />)}
          </div>
          {missing.length > 0 && (
            <div className="mt-5 flex flex-wrap gap-2 border-t border-ink/[0.06] pt-5">
              {missing.map((k) => (
                <Button key={k} href={`/treasury/policy?kind=${k}`}>
                  <Icon name="add" className="text-[18px]" /> {KIND_LABELS[k].title}
                </Button>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <CardTitle>Recent movements</CardTitle>
          {data.movements.length === 0 ? (
            <p className="text-sm text-muted">No movements yet. Every proposal, including blocked ones, will show here.</p>
          ) : (
            <div className="-mx-2 overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead className="text-xs text-muted">
                  <tr><th className="px-2 py-2 font-medium">When</th><th className="px-2 font-medium">To</th><th className="px-2 font-medium">Amount</th><th className="px-2 font-medium">Engine</th><th className="px-2 font-medium">Status</th></tr>
                </thead>
                <tbody className="divide-y divide-ink/[0.06]">
                  {data.movements.map((m) => (
                    <tr key={m.id}>
                      <td className="whitespace-nowrap px-2 py-2.5 text-muted">{dateTime(m.created_at)}</td>
                      <td className="whitespace-nowrap px-2">{m.account_name ?? (m.role ? ROLE_LABELS[m.role] : m.kind)}</td>
                      <td className="px-2 font-semibold tabular-nums">{money(m.amount, m.currency)}</td>
                      <td className="px-2" title={m.reason}><Pill tone={VERDICT_TONE[m.verdict]}>{CHECK_LABELS[m.check_code ?? ""] ?? m.check_code}</Pill></td>
                      <td className="px-2 text-muted">{m.status.replace("_", " ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div className="xl:sticky xl:top-10 xl:h-[calc(100vh-7rem)]">
        <LiveLog entries={feed.data?.entries ?? []} />
      </div>
    </div>
  );
}

function PolicyRow({ p, currency, onChanged }: { p: Policy; currency: string; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const live = active(p);
  const last = latest(p);
  const draftAhead = last && live && last.version > live.version;
  const k = KIND_LABELS[p.kind];

  async function act(action: "pause" | "resume" | "run") {
    setBusy(action);
    setNote(null);
    try {
      const r = await treasury.action(p.id, action);
      if (action === "run") {
        const check = String(r.check ?? "");
        setNote(
          r.status === "allowed" ? `Ran: ${r.execution === "succeeded" ? "sent and confirmed" : "sent to PayPal"}.`
          : r.status === "needs_approval" ? `Needs your approval: ${String(r.reason)}`
          : r.status === "skipped" ? "Nothing to move: every target is met."
          : `Blocked: ${CHECK_LABELS[check] ?? check}. ${String(r.reason ?? "")}`,
        );
      }
      changed();
      onChanged();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-4 py-4 first:pt-0 last:pb-0">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-fixed text-primary"><Icon name={k.icon} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/treasury/policy?id=${p.id}`} className="font-semibold hover:text-primary">{live?.doc.name ?? last?.doc.name ?? k.title}</Link>
          <Pill tone={STATUS_TONE[p.status]}>{p.status}</Pill>
          {live && <Pill tone="soft">v{live.version} live</Pill>}
          {draftAhead && <Pill tone="plum">v{last.version} awaiting approval</Pill>}
        </div>
        <p className="mt-1 text-[13px] text-muted">
          {k.title}
          {p.status === "active" && p.next_run_at ? ` · next run ${dateTime(p.next_run_at)}` : ""}
          {p.failures > 0 ? ` · ${p.failures} failed run${p.failures === 1 ? "" : "s"}` : ""}
          {last?.doc.spec.kind === "ad_sweep" ? ` · ${money(last.doc.spec.amount, currency)} per run` : ""}
        </p>
        {note && <p className="mt-1.5 text-[13px] font-medium text-ink-2">{note}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        {p.status === "active" && (
          <>
            <Button variant="primary" disabled={!!busy} className="min-h-9 px-3.5 text-[13px]" onClick={() => act("run")}>
              <Icon name="play_arrow" className="text-[18px]" /> {busy === "run" ? "Running" : "Run now"}
            </Button>
            <Button disabled={!!busy} className="min-h-9 px-3.5 text-[13px]" onClick={() => act("pause")}>Pause</Button>
          </>
        )}
        {p.status === "paused" && <Button disabled={!!busy} className="min-h-9 px-3.5 text-[13px]" onClick={() => act("resume")}>Resume</Button>}
        <Button href={`/treasury/policy?id=${p.id}`} className="min-h-9 px-3.5 text-[13px]">{p.status === "draft" ? "Review" : "Edit"}</Button>
      </div>
    </div>
  );
}
