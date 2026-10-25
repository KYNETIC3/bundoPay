"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { CopilotButton } from "@/components/Copilot";
import { Button, Card, Empty, Icon, IconButton, Pill } from "@/components/ui";
import { when } from "@/lib/format";
import { useLive } from "@/lib/hooks";
import {
  CHECK_LABELS, KIND_LABELS, type Overview, type Policy, type PolicyKind, active, changed, describePolicy, latest, policyState, treasury,
} from "@/lib/treasury";

const KINDS: PolicyKind[] = ["tax_reserve", "dispute_buffer", "ad_sweep", "rebalance"];

export default function PoliciesPage() {
  const { data, error, reload } = useLive<Overview>("/treasury/overview", 30_000);
  if (error) return <Card><p className="text-sm text-danger">{error}</p></Card>;
  if (!data) return <Card><p className="text-sm text-muted">Loading…</p></Card>;

  const currency = data.limits.currency;
  const missing = KINDS.filter((k) => !data.policies.some((p) => p.kind === k));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="max-w-xl text-[15px] text-muted">Rules that set money aside for you. Each one runs only after you&rsquo;ve previewed and approved it.</p>
        <div className="flex items-center gap-2">
          <CopilotButton currency={currency} onChanged={reload} />
          {missing.length > 0 && <NewPolicy kinds={missing} />}
        </div>
      </div>

      <div className="rounded-[20px] bg-card shadow-card">
        {data.policies.length === 0 ? (
          <div className="p-7">
            <Empty icon="rule" title="No policies yet">
              Start with a tax reserve, or describe what you want with Copilot and it will draft the policies for you.
            </Empty>
          </div>
        ) : (
          <ul className="divide-y divide-ink/[0.06]">
            {data.policies.map((p) => <PolicyRow key={p.id} p={p} currency={currency} onChanged={reload} />)}
          </ul>
        )}
      </div>
    </div>
  );
}

function NewPolicy({ kinds }: { kinds: PolicyKind[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div ref={box} className="relative">
      <Button variant="primary" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)}>
        <Icon name="add" className="text-[18px]" /> New policy
      </Button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-40 mt-2 w-[320px] rounded-2xl bg-card p-1.5 shadow-lift ring-1 ring-ink/[0.06]">
          {kinds.map((k) => (
            <Link
              key={k}
              role="menuitem"
              href={`/treasury/policy?kind=${k}`}
              className="flex items-start gap-3 rounded-xl px-3 py-3 hover:bg-soft focus:bg-soft focus:outline-none"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary-fixed text-primary"><Icon name={KIND_LABELS[k].icon} className="text-[18px]" /></span>
              <span>
                <span className="block text-sm font-semibold">{KIND_LABELS[k].title}</span>
                <span className="mt-0.5 block text-[13px] leading-snug text-muted">{KIND_LABELS[k].blurb}</span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function PolicyRow({ p, currency, onChanged }: { p: Policy; currency: string; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const live = active(p);
  const last = latest(p);
  const doc = live?.doc ?? last?.doc;
  const k = KIND_LABELS[p.kind];
  const state = policyState(p);
  const href = `/treasury/policy?id=${p.id}`;

  async function act(action: "pause" | "resume" | "run") {
    setBusy(action);
    setNote(null);
    try {
      const r = await treasury.action(p.id, action);
      if (action === "run") {
        const check = String(r.check ?? "");
        setNote(
          r.status === "allowed" ? (r.execution === "succeeded" ? "Done. PayPal confirmed the transfer." : "Sent to PayPal. Waiting for confirmation.")
          : r.status === "needs_approval" ? "This one needs your OK. You'll find it on Overview."
          : r.status === "skipped" ? "Nothing to move: every reserve is already on target."
          : `Stopped: ${CHECK_LABELS[check]?.toLowerCase() ?? "a safety check failed"}. Nothing moved.`,
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
    <li className="flex flex-wrap items-center gap-x-4 gap-y-3 px-6 py-5 sm:px-7">
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary-fixed text-primary"><Icon name={k.icon} /></span>
      <div className="min-w-0 flex-1 basis-[180px]">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Link href={href} className="font-semibold hover:text-primary">{doc?.name ?? k.title}</Link>
          <Pill tone={state.tone}>{state.label}</Pill>
        </div>
        <p className="mt-1 text-[13px] leading-snug text-muted">
          {doc ? describePolicy(doc, currency) : k.blurb}
          {p.status === "active" && p.next_run_at ? ` Next run ${when(p.next_run_at)}.` : ""}
        </p>
        {p.failures > 0 && <p className="mt-1 text-[13px] font-medium text-danger">PayPal turned down the last {p.failures} run{p.failures === 1 ? "" : "s"}.</p>}
        {note && <p className="mt-1.5 text-[13px] font-medium text-ink-2" role="status">{note}</p>}
      </div>
      <div className="flex items-center gap-1">
        {p.status === "active" && (
          <>
            <Button disabled={!!busy} className="mr-1 min-h-9 px-3.5 text-[13px]" onClick={() => act("run")}>
              {busy === "run" ? "Running…" : "Run now"}
            </Button>
            <IconButton icon="pause" label="Pause" disabled={!!busy} onClick={() => act("pause")} />
          </>
        )}
        {p.status === "paused" && <IconButton icon="play_arrow" label="Resume" disabled={!!busy} onClick={() => act("resume")} />}
        {p.status === "draft" ? (
          <Button variant="primary" href={href} className="min-h-9 px-3.5 text-[13px]">Review</Button>
        ) : (
          <IconButton icon="edit" label="Edit" href={href} />
        )}
      </div>
    </li>
  );
}
