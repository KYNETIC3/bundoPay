"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import { Button, Card, Icon } from "@/components/ui";
import { money } from "@/lib/format";
import { changed, treasury } from "@/lib/treasury";

type Done = Awaited<ReturnType<typeof treasury.finishTestSale>>;

function Finish() {
  const order = useSearchParams().get("token");
  const [done, setDone] = useState<Done | null>(null);
  const [error, setError] = useState<string | null>(order ? null : "No payment to finish. Start a test sale from Treasury.");
  const started = useRef(false);

  useEffect(() => {
    if (!order || started.current) return;
    started.current = true;
    treasury.finishTestSale(order).then((r) => { setDone(r); changed(); }).catch((e) => setError((e as Error).message));
  }, [order]);

  return (
    <Card>
      <div className="mx-auto max-w-md py-6 text-center">
        {error ? (
          <p className="text-sm text-danger" role="alert">{error}</p>
        ) : !done ? (
          <p className="text-sm text-muted">Finishing your test sale with PayPal…</p>
        ) : (
          <>
            <Icon name="check_circle" className="text-[40px] text-primary" />
            <p className="mt-2 text-[19px] font-semibold">{money(done.amount, done.currency)} test sale received</p>
            <p className="mt-1 text-sm text-muted">
              {done.tax_policy === "ran" ? "Your tax rule ran straight away. Check Recent activity for the transfer."
                : done.tax_policy === "none" ? "No tax rule is switched on, so nothing was set aside."
                : "This sale was already counted."}
            </p>
          </>
        )}
        <div className="mt-6"><Button variant="primary" href="/treasury">Back to Treasury</Button></div>
      </div>
    </Card>
  );
}

export default function TestSalePage() {
  return <Suspense fallback={null}><Finish /></Suspense>;
}
