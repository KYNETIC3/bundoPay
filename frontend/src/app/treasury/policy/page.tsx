"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";

import { Button, Card, CardTitle, Icon, Pill, type Tone } from "@/components/ui";
import { dateTime, money } from "@/lib/format";
import { useLive } from "@/lib/hooks";
import {
  CHECK_LABELS, DEFAULT_SPECS, KIND_LABELS, type Overview, type PolicyDoc, type PolicyKind, ROLE_LABELS, type Simulation,
  type Spec, WEEKDAYS, active, changed, latest, treasury,
} from "@/lib/treasury";

const OUTCOME: Record<string, [Tone, string]> = {
  allow: ["cerulean", "Runs on its own"],
  ask: ["plum", "Asks you first"],
  block: ["danger", "Blocked"],
  skip: ["soft", "Skipped"],
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

function Block({ tag, icon, children }: { tag: string; icon: string; children: React.ReactNode }) {
  return (
    <div className="relative rounded-[18px] bg-card p-5 shadow-card">
      <span className="mb-4 inline-flex items-center gap-1.5 rounded-full bg-ink px-3 py-1 text-[11px] font-bold uppercase tracking-[0.08em] text-ice">
        <Icon name={icon} className="text-[14px]" /> {tag}
      </span>
      <div className="space-y-4">{children}</div>
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
      setDone(`Version ${saved.version} is live.`);
      changed();
      await reload();
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[22px] font-semibold tracking-[-0.02em]">{KIND_LABELS[kind].title}</h2>
          {policy && <Pill tone={policy.status === "active" ? "cerulean" : "soft"}>{policy.status}</Pill>}
          {live && <Pill tone="soft">v{live.version} live</Pill>}
        </div>
        <p className="text-sm text-muted">{KIND_LABELS[kind].blurb}</p>

        <Field label="Name">
          <input className={input} value={doc.name} maxLength={80} onChange={(e) => setDoc({ ...doc, name: e.target.value })} />
        </Field>

        <Block tag="When" icon="schedule">
          {s.kind === "tax_reserve" && <p className="text-sm">PayPal confirms a capture (webhook, re-fetched from PayPal). Leftovers are swept every hour.</p>}
          {s.kind === "dispute_buffer" && <p className="text-sm">A dispute opens or changes, and every hour.</p>}
          {s.kind === "ad_sweep" && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Day">
                <select className={input} value={s.weekday} onChange={(e) => set({ weekday: Number(e.target.value) })}>
                  {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
                </select>
              </Field>
              <Field label="Hour (UTC)">
                <input type="number" min={0} max={23} className={input} value={s.hour} onChange={(e) => set({ hour: Number(e.target.value) })} />
              </Field>
            </div>
          )}
          {s.kind === "rebalance" && (
            <Field label="Every day at (UTC hour)">
              <input type="number" min={0} max={23} className={input} value={s.hour} onChange={(e) => set({ hour: Number(e.target.value) })} />
            </Field>
          )}
        </Block>

        <Block tag="If" icon="rule">
          <p className="text-sm">
            Operating stays at or above the <strong>{money(lim.liquidity_floor, currency)}</strong> liquidity floor after the move, and every
            destination is a verified account.
          </p>
          {s.kind === "dispute_buffer" && <p className="text-sm text-muted">The buffer is below its target.</p>}
        </Block>

        <Block tag="Do" icon="bolt">
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
            <Field label={`Sweep to ${ROLE_LABELS.ad_spend}`} hint="If the floor wouldn't hold, BundoPay funds reserves first and sweeps only what still fits.">
              <input inputMode="decimal" className={input} value={s.amount} onChange={(e) => set({ amount: e.target.value })} />
            </Field>
          )}
          {s.kind === "rebalance" && (
            <Field label="Then top up ad spend by up to" hint="After tax and the dispute buffer are funded, in that order.">
              <input inputMode="decimal" className={input} value={s.ad_amount} onChange={(e) => set({ ad_amount: e.target.value })} />
            </Field>
          )}
        </Block>

        <Block tag="Limits" icon="lock">
          <ul className="space-y-1 text-sm">
            <li>Runs on its own up to <strong>{money(lim.solo_limit, currency)}</strong> per run; above that it asks you.</li>
            <li>Never more than <strong>{money(lim.hard_cap_per_run, currency)}</strong> per run or <strong>{money(lim.hard_cap_per_week, currency)}</strong> per week.</li>
            <li>Pauses itself after 3 runs in a row that PayPal rejects.</li>
          </ul>
          <p className="text-xs text-muted">Account-level limits. A policy can&rsquo;t raise them; change them in Accounts &amp; limits.</p>
        </Block>

        <Block tag="Otherwise" icon="notifications">
          <p className="text-sm">Nothing moves. The reason is written to History and the live log.</p>
        </Block>

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" disabled={!!busy || !dirty} onClick={save}>
            <Icon name="save" className="text-[18px]" /> {busy === "save" ? "Saving" : policy ? "Save as new version" : "Save draft"}
          </Button>
          {saved && !dirty && <span className="text-[13px] text-muted">Version {saved.version} · <span className="font-mono">{saved.spec_hash.slice(0, 10)}</span></span>}
          {dirty && saved && <span className="text-[13px] font-medium text-ink-2">Unsaved changes. Saving creates a new version that needs approval.</span>}
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>

      <div className="space-y-4">
        <Card className="lg:sticky lg:top-10">
          <CardTitle>Pre-flight simulator</CardTitle>
          {!policy || !saved || dirty ? (
            <p className="text-sm text-muted">Save this version, then simulate it. Only the exact version you simulate can be approved.</p>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-[180px] flex-1">
                  <Field label="Assume weekly sales of" hint="Leave empty to use your last 30 days.">
                    <input inputMode="decimal" className={input} value={inflow} placeholder="30-day average" onChange={(e) => setInflow(e.target.value)} />
                  </Field>
                </div>
                <Button disabled={!!busy} onClick={simulate} className="mb-[22px]">
                  <Icon name="science" className="text-[18px]" /> {busy === "simulate" ? "Simulating" : `Simulate v${saved.version}`}
                </Button>
              </div>
              {sim && <SimResult sim={sim} currency={currency} />}
              <div className="border-t border-ink/[0.06] pt-4">
                {isLiveVersion && !done ? (
                  <p className="text-sm text-muted">Version {saved.version} is already live.</p>
                ) : (
                  <Button variant="primary" disabled={!!busy || !sim} onClick={approve}>
                    <Icon name="verified" className="text-[18px]" /> {busy === "approve" ? "Approving" : `I've read the summary. Approve v${saved.version}`}
                  </Button>
                )}
                {done && <p className="mt-2 text-sm font-semibold text-ink-2">{done}</p>}
                {live && !isLiveVersion && <p className="mt-2 text-xs text-muted">v{live.version} keeps running until you approve this one.</p>}
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
      <div className="-mx-2 overflow-x-auto">
        <table className="w-full min-w-[460px] text-left text-sm">
          <thead className="text-xs text-muted">
            <tr><th className="px-2 py-2 font-medium">Run</th><th className="px-2 font-medium">Operating</th><th className="px-2 font-medium">What happens</th></tr>
          </thead>
          <tbody className="divide-y divide-ink/[0.06] align-top">
            {sim.rows.map((r) => {
              const [tone, label] = OUTCOME[r.outcome];
              return (
                <tr key={r.at}>
                  <td className="whitespace-nowrap px-2 py-2.5">{dateTime(r.at)}</td>
                  <td className="px-2 py-2.5 tabular-nums">{money(r.operating_before, currency)}</td>
                  <td className="px-2 py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Pill tone={tone}>{label}</Pill>
                      <span className="text-[13px]">{r.items.map((i) => `${money(i.amount, currency)} → ${ROLE_LABELS[i.to]}`).join(", ") || "—"}</span>
                    </div>
                    {r.outcome !== "allow" && <p className="mt-1 text-xs text-muted">{CHECK_LABELS[r.check] ?? r.check}: {r.reason}</p>}
                    {r.fallback && r.fallback.length > 0 && (
                      <p className="mt-1 text-xs font-medium text-ink-2">
                        Re-planned: {r.fallback.map((i) => `${money(i.amount, currency)} → ${ROLE_LABELS[i.to]}`).join(" + ")}
                      </p>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <details className="rounded-xl bg-soft px-4 py-3 text-sm">
        <summary className="cursor-pointer font-semibold">What happens when things go wrong</summary>
        <ul className="mt-3 space-y-2">
          {sim.failure_cases.map((c) => (
            <li key={c.case}>
              <span className="font-medium">{c.case}</span>: <span className="text-muted">{c.result === "block" ? `blocked (${CHECK_LABELS[c.check] ?? c.check})` : c.reason}</span>
            </li>
          ))}
        </ul>
      </details>
      <p className="text-xs text-muted"><Icon name="info" className="mr-1 align-[-4px] text-[16px]" />{sim.disclaimer}</p>
    </div>
  );
}

export default function PolicyPage() {
  return (
    <Suspense>
      <Editor />
    </Suspense>
  );
}
