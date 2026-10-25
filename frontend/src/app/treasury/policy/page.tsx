"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";

import { Button, Card, CardTitle, Details, Fact, Icon, Pill, type Tone } from "@/components/ui";
import { dateTime, money, when } from "@/lib/format";
import { useLive } from "@/lib/hooks";
import {
  CHECK_LABELS, DEFAULT_SPECS, KIND_LABELS, type Overview, type PolicyDoc, type PolicyKind, ROLE_LABELS, type Simulation,
  type Spec, WEEKDAYS, active, changed, latest, policyState, treasury,
} from "@/lib/treasury";

const OUTCOME: Record<string, [Tone, string]> = {
  allow: ["cerulean", "Runs on its own"],
  ask: ["plum", "Asks you first"],
  block: ["danger", "Stopped"],
  skip: ["soft", "Nothing to move"],
};

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[13px] font-semibold text-ink-2">{label}</span>
      <div className="mt-1.5">{children}</div>
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

const input = "min-h-11 w-full rounded-xl bg-card px-3.5 text-[15px] tabular-nums ring-1 ring-inset ring-ink/20 focus:outline-none focus:ring-2 focus:ring-primary";

function Block({ tag, icon, children, folded }: { tag: string; icon: string; children: React.ReactNode; folded?: boolean }) {
  const head = (
    <span className="flex items-center gap-3">
      <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary-fixed text-primary"><Icon name={icon} className="text-[18px]" /></span>
      <span className="text-[15px] font-semibold">{tag}</span>
    </span>
  );
  if (folded) {
    return (
      <details className="group/blk rounded-[18px] bg-card p-5 shadow-card">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
          {head}
          <Icon name="expand_more" className="text-muted transition-transform group-open/blk:rotate-180" />
        </summary>
        <div className="mt-4 space-y-4">{children}</div>
      </details>
    );
  }
  return (
    <div className="rounded-[18px] bg-card p-5 shadow-card">
      {head}
      <div className="mt-4 space-y-4">{children}</div>
    </div>
  );
}

function pct(v: string) {
  return String(Math.round(Number(v) * 10000) / 100);
}
function fromPct(v: string, dp: number) {
  const n = Number(v);
  return Number.isFinite(n) ? (n / 100).toFixed(dp) : "0";
}

function Editor() {
  const params = useSearchParams();
  const router = useRouter();
  const id = params.get("id");
  const { data, reload } = useLive<Overview>("/treasury/overview", 60_000);
  const policy = data?.policies.find((p) => p.id === id);
  const kind = (policy?.kind ?? params.get("kind") ?? "ad_sweep") as PolicyKind;
  const base = policy ? latest(policy) : undefined;
  const live = policy ? active(policy) : undefined;
  const last = policy ? latest(policy) : undefined;

  const [doc, setDoc] = useState<PolicyDoc | null>(null);
  const [saved, setSaved] = useState<{ version: number; spec_hash: string; json: string } | null>(null);
  const [sim, setSim] = useState<Simulation | null>(null);
  const [inflow, setInflow] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (doc || !data) return;
    if (base) {
      setDoc(base.doc);
      setSaved({ version: base.version, spec_hash: base.spec_hash, json: JSON.stringify(base.doc) });
    } else {
      setDoc({ name: KIND_LABELS[kind].title, spec: DEFAULT_SPECS[kind] });
    }
  }, [data, base, doc, kind]);

  const dirty = useMemo(() => !saved || (doc && JSON.stringify(doc) !== saved.json), [doc, saved]);
  if (!data || !doc) return <Card><p className="text-sm text-muted">Loading…</p></Card>;
  const currency = data.limits.currency;
  const lim = data.limits;
  const s = doc.spec;
  const set = (patch: Partial<Spec>) => setDoc({ ...doc, spec: { ...s, ...patch } as Spec });
  const isLiveVersion = !!(saved && live && saved.version === live.version);

  async function step<T>(name: string, fn: () => Promise<T>) {
    setBusy(name);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    const r = await step("save", () => (policy ? treasury.editPolicy(policy.id, doc!) : treasury.createPolicy(doc!)));
    if (!r) return;
    setSaved({ version: r.version, spec_hash: r.spec_hash, json: JSON.stringify(doc) });
    setSim(null);
    changed();
    await reload();
    if (!policy) router.replace(`/treasury/policy?id=${r.policy_id}`);
  }

  async function simulate() {
    const pid = policy?.id;
    if (!pid || !saved) return;
    const r = await step("simulate", () => treasury.simulate(pid, saved.version, inflow || undefined));
    if (r) setSim(r);
  }

  async function approve() {
    const pid = policy?.id;
    if (!pid || !saved) return;
    const r = await step("approve", () => treasury.approve(pid, saved.version, saved.spec_hash));
    if (r) {
      setDone("Approved. This policy is now running.");
      changed();
      await reload();
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-[24px] font-semibold tracking-[-0.02em]">{doc.name || KIND_LABELS[kind].title}</h2>
          {policy && <Pill tone={policyState(policy).tone}>{policyState(policy).label}</Pill>}
        </div>
        <p className="text-sm text-muted">{KIND_LABELS[kind].blurb}</p>

        <Field label="Name">
          <input className={input} value={doc.name} maxLength={80} onChange={(e) => setDoc({ ...doc, name: e.target.value })} />
        </Field>

        <Block tag="When it runs" icon="schedule">
          {s.kind === "tax_reserve" && <p className="text-sm">Each time PayPal confirms a sale, and once an hour for anything left over.</p>}
          {s.kind === "dispute_buffer" && <p className="text-sm">When a dispute opens or changes, and once an hour.</p>}
          {s.kind === "ad_sweep" && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Day">
                <select className={input} value={s.weekday} onChange={(e) => set({ weekday: Number(e.target.value) })}>
                  {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
                </select>
              </Field>
              <Field label="Hour (UTC, 0–23)">
                <input type="number" min={0} max={23} className={input} value={s.hour} onChange={(e) => set({ hour: Number(e.target.value) })} />
              </Field>
            </div>
          )}
          {s.kind === "rebalance" && (
            <Field label="Every day at (UTC hour, 0–23)">
              <input type="number" min={0} max={23} className={input} value={s.hour} onChange={(e) => set({ hour: Number(e.target.value) })} />
            </Field>
          )}
        </Block>

        <Block tag="Only if" icon="rule">
          <p className="text-sm leading-relaxed">
            Operating still has at least <strong>{money(lim.liquidity_floor, currency)}</strong> afterwards, and the money only goes to accounts
            you&rsquo;ve confirmed.
          </p>
          {s.kind === "dispute_buffer" && <p className="text-sm text-muted">The buffer is below its target.</p>}
        </Block>

        <Block tag="What it does" icon="bolt">
          {s.kind === "tax_reserve" && (
            <Field label="Set aside (% of each capture)" hint={`Sent to ${ROLE_LABELS.tax_reserve}. Not tax advice; use your own rate.`}>
              <input inputMode="decimal" className={input} value={pct(s.rate)} onChange={(e) => set({ rate: fromPct(e.target.value, 4) })} />
            </Field>
          )}
          {s.kind === "dispute_buffer" && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Cover open disputes (%)">
                <input inputMode="decimal" className={input} value={pct(s.coverage)} onChange={(e) => set({ coverage: fromPct(e.target.value, 2) })} />
              </Field>
              <Field label="Plus % of 30-day sales">
                <input inputMode="decimal" className={input} value={pct(s.volume_pct)} onChange={(e) => set({ volume_pct: fromPct(e.target.value, 4) })} />
              </Field>
            </div>
          )}
          {s.kind === "ad_sweep" && (
            <Field label={`Sweep to ${ROLE_LABELS.ad_spend}`} hint="If Operating would drop below its floor, reserves are funded first and only what still fits is moved.">
              <input inputMode="decimal" className={input} value={s.amount} onChange={(e) => set({ amount: e.target.value })} />
            </Field>
          )}
          {s.kind === "rebalance" && (
            <Field label="Then top up ad spend by up to" hint="After tax and the dispute buffer are funded, in that order.">
              <input inputMode="decimal" className={input} value={s.ad_amount} onChange={(e) => set({ ad_amount: e.target.value })} />
            </Field>
          )}
        </Block>

        <Block tag="Safety limits" icon="lock" folded>
          <ul className="space-y-1 text-sm">
            <li>Runs on its own up to <strong>{money(lim.solo_limit, currency)}</strong> per run; above that it asks you.</li>
            <li>Never more than <strong>{money(lim.hard_cap_per_run, currency)}</strong> per run or <strong>{money(lim.hard_cap_per_week, currency)}</strong> per week.</li>
            <li>Pauses itself if PayPal turns down 3 runs in a row.</li>
          </ul>
          <p className="text-xs text-muted">These apply to every policy. Change them in Accounts.</p>
        </Block>

        <Block tag="If a check fails" icon="notifications" folded>
          <p className="text-sm">Nothing moves, and you&rsquo;ll see why in Activity.</p>
        </Block>

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" disabled={!!busy || !dirty} onClick={save}>
            {busy === "save" ? "Saving…" : policy ? "Save changes" : "Save draft"}
          </Button>
          {saved && !dirty && <span className="text-[13px] text-muted">{isLiveVersion ? "Saved. This is the version that's running." : "Saved. Preview it, then approve to turn it on."}</span>}
          {dirty && saved && <span className="text-[13px] font-medium text-ink-2">Unsaved changes. They need your approval before they take effect.</span>}
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        {policy && last && (
          <Details>
            <dl className="divide-y divide-ink/[0.05] rounded-xl bg-card px-4 py-1 shadow-card">
              <Fact label="Version">{last.version}</Fact>
              <Fact label="Last saved">{dateTime(last.created_at)}{last.created_by === "copilot" ? ", drafted by Copilot" : ""}</Fact>
              <Fact label="Changes kept">Every saved change is kept, so you can see what was running when.</Fact>
            </dl>
          </Details>
        )}
      </div>

      <div className="space-y-4">
        <Card className="lg:sticky lg:top-10">
          <CardTitle>Preview</CardTitle>
          {!policy || !saved || dirty ? (
            <p className="text-sm text-muted">Save your changes, then preview what this policy would do over its next few runs. You approve exactly what you previewed.</p>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-[180px] flex-1">
                  <Field label="Assume weekly sales of" hint="Leave empty to use your last 30 days.">
                    <input inputMode="decimal" className={input} value={inflow} placeholder="30-day average" onChange={(e) => setInflow(e.target.value)} />
                  </Field>
                </div>
                <Button disabled={!!busy} onClick={simulate} className="mb-[22px]">
                  <Icon name="visibility" className="text-[18px]" /> {busy === "simulate" ? "Previewing…" : sim ? "Preview again" : "Preview next runs"}
                </Button>
              </div>
              {sim && <SimResult sim={sim} currency={currency} />}
              <div className="border-t border-ink/[0.06] pt-4">
                {isLiveVersion && !done ? (
                  <p className="flex items-center gap-2 text-sm text-muted"><Icon name="check_circle" className="text-primary" /> This is the version that&rsquo;s running.</p>
                ) : (
                  <Button variant="primary" disabled={!!busy || !sim} onClick={approve}>
                    {busy === "approve" ? "Approving…" : "Approve and turn on"}
                  </Button>
                )}
                {done && <p className="mt-2 text-sm font-semibold text-ink-2" role="status">{done}</p>}
                {!sim && !isLiveVersion && <p className="mt-2 text-xs text-muted">Preview first, so you know what you&rsquo;re approving.</p>}
                {live && !isLiveVersion && <p className="mt-2 text-xs text-muted">The current version keeps running until you approve this one.</p>}
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function SimResult({ sim, currency }: { sim: Simulation; currency: string }) {
  return (
    <div className="space-y-4">
      <p className="rounded-xl bg-primary-fixed px-4 py-3 text-sm font-medium">{sim.summary}</p>
      <ul className="divide-y divide-ink/[0.06]">
        {sim.rows.map((r) => {
          const [tone, label] = OUTCOME[r.outcome];
          const moves = r.items.map((i) => `${money(i.amount, currency)} to ${ROLE_LABELS[i.to]}`).join(", ");
          return (
            <li key={r.at} className="py-3.5 first:pt-0">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">{when(r.at)}</span>
                <Pill tone={tone}>{label}</Pill>
              </div>
              {moves && <p className="mt-1 text-[13px] text-ink-2">{r.outcome === "block" ? `Would try ${moves}` : moves}</p>}
              {r.outcome !== "allow" && <p className="mt-1 text-xs text-muted">{r.outcome === "skip" ? r.reason : `${CHECK_LABELS[r.check] ?? "A safety check"}. ${r.reason}`}</p>}
              {r.fallback && r.fallback.length > 0 && (
                <p className="mt-1 text-xs font-medium text-ink-2">
                  Instead: {r.fallback.map((i) => `${money(i.amount, currency)} to ${ROLE_LABELS[i.to]}`).join(" and ")}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <Details summary="What happens when things go wrong" className="rounded-xl bg-soft px-4 py-3 text-sm">
        <ul className="space-y-2">
          {sim.failure_cases.map((c) => (
            <li key={c.case}>
              <span className="font-medium">{c.case}</span>: <span className="text-muted">{c.result === "block" ? `stopped (${(CHECK_LABELS[c.check] ?? "safety check").toLowerCase()})` : c.reason}</span>
            </li>
          ))}
        </ul>
      </Details>
      <p className="text-xs text-muted"><Icon name="info" className="mr-1 align-[-4px] text-[16px]" />{sim.disclaimer}</p>
    </div>
  );
}

function Keyed() {
  // A fresh editor per policy: its form state must never carry over from the one viewed before.
  const params = useSearchParams();
  return <Editor key={params.get("id") ?? `new:${params.get("kind")}`} />;
}

export default function PolicyPage() {
  return (
    <Suspense>
      <Keyed />
    </Suspense>
  );
}
