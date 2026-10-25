"use client";

import Link from "next/link";

import { CopilotButton } from "@/components/Copilot";
import { Menu } from "@/components/overlay";
import { ActivityList, PlanApproval, TreasuryHero, condense } from "@/components/treasury";
import { Button, Card, Empty, Icon } from "@/components/ui";
import { money, when } from "@/lib/format";
import { useLive } from "@/lib/hooks";
import { type FeedEntry, type Overview, downloadStatement } from "@/lib/treasury";

export default function TreasuryPage() {
  const { data, error, reload } = useLive<Overview>("/treasury/overview", 15_000);
  const feed = useLive<{ entries: FeedEntry[] }>("/treasury/feed", 15_000);

  if (error) return <Card><p className="text-sm text-danger">{error}</p></Card>;
  if (!data) return <Card><p className="text-sm text-muted">Loading your treasury…</p></Card>;

  const currency = data.limits.currency;
  const pending = data.plans.filter((p) => p.status === "needs_approval");
  const needsSetup = !data.accounts.some((a) => a.role === "operating") || data.accounts.every((a) => !a.verified_at);
  const running = data.policies.filter((p) => p.status === "active");
  const next = running.map((p) => p.next_run_at).filter((t): t is string => !!t).sort()[0];
  const recent = condense(feed.data?.entries ?? [], currency).slice(0, 5);

  if (needsSetup) {
    return (
      <Card>
        <Empty icon="account_balance" title="Set up your treasury accounts">
          Add the account your business runs on, then the reserves money is set aside into. Nothing moves until you&rsquo;ve
          confirmed each one.
          <div className="mt-5"><Button variant="primary" href="/treasury/setup">Add accounts</Button></div>
        </Empty>
      </Card>
    );
  }

  return (
    <div className="space-y-10">
      <TreasuryHero
        positions={data.positions}
        floor={data.limits.liquidity_floor}
        currency={currency}
        actions={
          <>
            <CopilotButton currency={currency} onChanged={reload} />
            <Menu items={[{ icon: "download", label: "Download statement (CSV)", onSelect: () => downloadStatement(data.movements) }]} />
          </>
        }
      />

      {pending.length > 0 ? (
        <section aria-labelledby="needs-you" className="space-y-4">
          <h2 id="needs-you" className="flex items-center gap-2 text-[19px] font-semibold tracking-[-0.015em]">
            <span className="h-2 w-2 rounded-full bg-primary" aria-hidden />
            {pending.length === 1 ? "1 transfer needs your OK" : `${pending.length} transfers need your OK`}
          </h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {pending.map((p) => (
              <PlanApproval
                key={p.id}
                plan={{ plan_id: p.id, plan_hash: p.plan_hash, total: p.total, items: p.items_json, status: p.status, reason: p.reason, expires_at: p.expires_at }}
                currency={currency}
                onDone={reload}
              />
            ))}
          </div>
        </section>
      ) : (
        <p className="flex items-center gap-2 text-[15px] text-muted">
          <Icon name="check_circle" className="text-primary" /> Nothing needs you right now.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
        <div className="flex flex-col gap-6">
        <Link href="/treasury/policies" className="group rounded-[20px] bg-card p-7 shadow-card transition hover:shadow-lift">
          <div className="flex items-center justify-between">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary-fixed text-primary"><Icon name="rule" /></span>
            <Icon name="chevron_right" className="text-muted transition group-hover:translate-x-0.5 group-hover:text-ink" />
          </div>
          <p className="mt-5 text-[19px] font-semibold tracking-[-0.015em]">
            {running.length === 0 ? "No policies running" : `${running.length} ${running.length === 1 ? "policy" : "policies"} running`}
          </p>
          <p className="mt-1 text-sm text-muted">
            {next ? `Next run ${when(next)}` : data.policies.length ? "Open Policies to turn one on." : "Add a policy to start setting money aside."}
          </p>
        </Link>

        <Link href="/treasury/setup" className="group flex-1 rounded-[20px] bg-card p-7 shadow-card transition hover:shadow-lift">
          <div className="flex items-center justify-between">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary-fixed text-primary"><Icon name="shield" /></span>
            <Icon name="chevron_right" className="text-muted transition group-hover:translate-x-0.5 group-hover:text-ink" />
          </div>
          <p className="mt-5 text-[19px] font-semibold tracking-[-0.015em]">Safety limits</p>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between gap-4"><dt className="text-muted">Always keep in Operating</dt><dd className="font-medium tabular-nums">{money(data.limits.liquidity_floor, currency)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted">Moves on its own up to</dt><dd className="font-medium tabular-nums">{money(data.limits.solo_limit, currency)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted">Never more than, per week</dt><dd className="font-medium tabular-nums">{money(data.limits.hard_cap_per_week, currency)}</dd></div>
          </dl>
        </Link>
        </div>

        <Card className="lg:self-start">
          <div className="mb-5 flex items-center justify-between gap-4">
            <h2 className="text-[19px] font-semibold tracking-[-0.015em]">Recent activity</h2>
            <Link href="/treasury/activity" className="inline-flex items-center text-sm font-medium text-primary hover:text-ink">
              See all <Icon name="chevron_right" className="text-[18px]" />
            </Link>
          </div>
          <ActivityList items={recent} empty={feed.data ? "Nothing has happened yet. Every transfer, including stopped ones, will show here." : "Loading…"} />
        </Card>
      </div>
    </div>
  );
}
