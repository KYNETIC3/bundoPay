"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useState } from "react";

import { CopilotButton } from "@/components/Copilot";
import { LimitsSummary } from "@/components/limits";
import { BalanceHero, JarStrip } from "@/components/money";
import { Skeleton, SuccessTick } from "@/components/motion";
import { ActivityList, PlanApproval, condense } from "@/components/treasury";
import { Button, Card, Empty, Icon } from "@/components/ui";
import { feedback } from "@/lib/feedback";
import { when } from "@/lib/format";
import { useLive } from "@/lib/hooks";
import { useMoneyModel } from "@/lib/studio/useModel";
import type { FeedEntry } from "@/lib/treasury";

// AG Studio measures the page and uses localStorage, so boards only ever render in the browser.
const Board = dynamic(() => import("@/components/Board"), { ssr: false, loading: () => <Skeleton className="h-[520px]" /> });

export default function JarsPage() {
  const { model, overview, disputes, hasStore, ready } = useMoneyModel(30);
  const feed = useLive<{ entries: FeedEntry[] }>("/treasury/feed", 15_000);
  // The card unmounts once its plan leaves the list, so its outcome is kept here.
  const [notice, setNotice] = useState<string | null>(null);
  const data = overview.data;

  if (overview.error) return <Card><p className="text-sm text-danger">{overview.error}</p></Card>;
  if (!data) return <div className="space-y-6"><Skeleton className="h-48" /><Skeleton className="h-36" /></div>;

  const currency = data.limits.currency;
  const pending = data.plans.filter((p) => p.status === "needs_approval");
  const needsSetup = !data.accounts.some((a) => a.role === "operating") || data.accounts.every((a) => !a.verified_at);
  const noJar = !data.accounts.some((a) => a.role !== "operating" && a.verified_at);
  const running = data.policies.filter((p) => p.status === "active");
  const next = running.map((p) => p.next_run_at).filter((t): t is string => !!t).sort()[0];
  const recent = condense(feed.data?.entries ?? [], currency).slice(0, 5);
  const reload = () => {
    overview.reload();
    feed.reload();
  };

  if (needsSetup) {
    return (
      <Card>
        <Empty icon="savings" title="Set up your jars">
          Add the account your business runs on, then the jars money is set aside into: tax, dispute cover and ads. Nothing
          moves until you&rsquo;ve confirmed each one.
          <div className="mt-5"><Button variant="primary" href="/money/jars/accounts">Add accounts</Button></div>
        </Empty>
      </Card>
    );
  }

  return (
    <div className="space-y-10">
      <BalanceHero overview={data} actions={<CopilotButton currency={currency} onChanged={reload} />} />

      {pending.length > 0 ? (
        <section aria-labelledby="needs-you" className="space-y-4">
          <h2 id="needs-you" className="flex items-center gap-2 text-[19px] font-semibold tracking-[-0.015em]">
            <span className="h-2 w-2 animate-pulse rounded-full bg-primary motion-reduce:animate-none" aria-hidden />
            {pending.length === 1 ? "1 transfer needs your OK" : `${pending.length} transfers need your OK`}
          </h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {pending.map((p) => (
              <PlanApproval
                key={p.id}
                plan={{ plan_id: p.id, plan_hash: p.plan_hash, total: p.total, items: p.items_json, status: p.status, reason: p.reason, expires_at: p.expires_at }}
                currency={currency}
                onDone={(said) => {
                  setNotice(said);
                  feedback(said.startsWith("Approved") ? "moved" : "tap");
                  reload();
                }}
              />
            ))}
          </div>
        </section>
      ) : notice ? (
        <p role="status" className="rise flex items-center justify-between gap-4 rounded-2xl bg-card px-5 py-4 text-[15px] shadow-card">
          <span className="flex items-center gap-2"><SuccessTick /> {notice}</span>
          <button onClick={() => setNotice(null)} className="text-sm font-medium text-muted hover:text-ink">Dismiss</button>
        </p>
      ) : null}

      {noJar ? (
        <Card>
          <p className="flex flex-wrap items-center gap-3 text-sm text-ink-2">
            <Icon name="info" className="text-[18px] text-muted" />
            <span className="flex-1">There&rsquo;s no jar to set money aside into yet. Add and verify one: Tax, Dispute cover or Ads.</span>
            <Button variant="primary" href="/money/jars/accounts" className="min-h-9 px-3.5 text-[13px]">Add a jar</Button>
          </p>
        </Card>
      ) : (
        <JarStrip overview={data} disputes={disputes.data ?? []} />
      )}

      {ready && <Board id="jars" data={model} store={hasStore} />}

      <div className="grid gap-4 lg:grid-cols-2">
        <Link href="/money/jars/rules" className="press group flex items-center gap-4 rounded-[20px] bg-card p-5 shadow-card transition hover:shadow-lift">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-fixed text-primary"><Icon name="rule" /></span>
          <span className="min-w-0 flex-1">
            <span className="block font-semibold">{running.length === 0 ? "No rules running" : `${running.length} ${running.length === 1 ? "rule" : "rules"} running`}</span>
            <span className="mt-0.5 block text-sm text-muted">
              {next ? `Next run ${when(next)}` : data.policies.length ? "Open Rules to turn one on." : "Add a rule to start filling your jars."}
            </span>
          </span>
          <Icon name="chevron_right" className="text-muted transition group-hover:translate-x-0.5 group-hover:text-ink" />
        </Link>
        <LimitsSummary limits={data.limits} onSaved={reload} />
      </div>

      <Card>
        <div className="mb-5 flex items-center justify-between gap-4">
          <h2 className="text-[19px] font-semibold tracking-[-0.015em]">What Bundo did</h2>
          <Link href="/money/jars/activity" className="inline-flex items-center text-sm font-medium text-primary hover:text-ink">
            See all <Icon name="chevron_right" className="text-[18px]" />
          </Link>
        </div>
        <ActivityList items={recent} empty={feed.data ? "Nothing yet. Every transfer, including stopped ones, will show here." : "Loading…"} />
      </Card>
    </div>
  );
}
