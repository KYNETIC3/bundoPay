"use client";

import Link from "next/link";
import Script from "next/script";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { Button, Card, Icon } from "@/components/ui";
import { api, json } from "@/lib/api";
import { money } from "@/lib/format";

/** The sandbox buyer's side of a sale: PayPal Checkout through the JavaScript SDK v6. The price is set by the
 * server; this page only says which product. A paid order is a real sandbox capture, which BundoPay then
 * treats like any sale (it sets the tax aside). */

type Product = { id: string; name: string; blurb: string; price: string; currency: string };
type Config = { enabled: boolean; client_id: string; products: Product[] };
type Paid = { capture_id: string | null; amount: string | null; currency: string | null; recorded: boolean };
type Phase = "loading" | "ready" | "paying" | "paid" | "unavailable";

const SDK_URL = "https://www.sandbox.paypal.com/web-sdk/v6/core";

export default function StorePage() {
  const [config, setConfig] = useState<Config | null>(null);
  const [chosen, setChosen] = useState<string>("tote");
  const [phase, setPhase] = useState<Phase>("loading");
  const [eligible, setEligible] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [paid, setPaid] = useState<Paid | null>(null);
  const [scriptReady, setScriptReady] = useState(false);
  const sdk = useRef<PayPalSdkInstance | null>(null);
  const chosenRef = useRef(chosen);
  chosenRef.current = chosen;
  const hintId = useId();

  useEffect(() => {
    api<Config>("/checkout/config")
      .then((c) => {
        setConfig(c);
        if (!c.enabled) setPhase("unavailable");
      })
      .catch(() => setPhase("unavailable"));
  }, []);

  // Start the SDK once both the script and our client id are here, then show the button only if PayPal says so.
  useEffect(() => {
    if (!scriptReady || !config?.enabled || sdk.current || !window.paypal) return;
    (async () => {
      try {
        sdk.current = await window.paypal!.createInstance({ clientId: config.client_id, components: ["paypal-payments"], pageType: "checkout" });
        const methods = await sdk.current.findEligibleMethods({ currencyCode: "USD" });
        setEligible(methods.isEligible("paypal"));
        setPhase("ready");
      } catch {
        setProblem("PayPal checkout couldn't start. Refresh the page to try again.");
        setPhase("unavailable");
      }
    })();
  }, [scriptReady, config]);

  const pay = useCallback(async () => {
    if (!sdk.current || phase === "paying") return;
    setProblem(null);
    setPhase("paying");
    const session = sdk.current.createPayPalOneTimePaymentSession({
      onApprove: async ({ orderId }) => {
        try {
          const r = await api<Paid & { status: string }>(`/checkout/orders/${orderId}/capture`, { method: "POST" });
          if (r.status !== "COMPLETED") throw new Error("PayPal didn't complete the payment.");
          setPaid(r);
          setPhase("paid");
        } catch (e) {
          setProblem((e as Error).message);
          setPhase("ready");
        }
      },
      onCancel: () => {
        setProblem("Payment cancelled. Nothing was charged.");
        setPhase("ready");
      },
      onError: () => {
        setProblem("PayPal couldn't take the payment. Nothing was charged.");
        setPhase("ready");
      },
    });
    try {
      await session.start({ presentationMode: "auto" }, api<{ orderId: string }>("/checkout/orders", json({ product_id: chosenRef.current })));
    } catch (e) {
      setProblem((e as Error).message || "PayPal checkout didn't open.");
      setPhase("ready");
    }
  }, [phase]);

  // The SDK's button is a web component; listen for its click the standard DOM way.
  const button = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = button.current;
    if (!el) return;
    el.addEventListener("click", pay);
    return () => el.removeEventListener("click", pay);
  }, [pay, eligible, phase]);

  const product = config?.products.find((p) => p.id === chosen);

  return (
    <div className="mx-auto max-w-[560px] space-y-6">
      {config?.enabled && <Script src={SDK_URL} strategy="afterInteractive" onReady={() => setScriptReady(true)} onError={() => {
        setProblem("PayPal checkout couldn't load. Check your connection and refresh.");
        setPhase("unavailable");
      }} />}

      <p role="note" className="flex items-start gap-2 rounded-2xl bg-primary-fixed px-4 py-3 text-sm text-ink">
        <Icon name="science" className="mt-px text-[18px]" />
        <span><strong>Test store.</strong> This uses PayPal&apos;s sandbox, so no real money moves. Pay with a sandbox buyer account.</span>
      </p>

      <header>
        <h1 className="text-[28px] font-semibold tracking-[-0.02em]">Bundo Test Store</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-muted">
          Buying something here makes a real sandbox sale for the demo shop. BundoPay then sets the tax on it aside on its own.
        </p>
      </header>

      {phase === "paid" && paid ? (
        <Card>
          <div role="status" className="space-y-4">
            <p className="flex items-center gap-2 text-lg font-semibold">
              <Icon name="check_circle" className="text-[24px] text-primary" /> Paid {money(paid.amount, paid.currency)}
            </p>
            <p className="text-[15px] leading-relaxed text-muted">
              {paid.recorded
                ? "BundoPay has the sale. Its tax rule now sets the tax aside, within your limits."
                : "PayPal has the payment. BundoPay picks it up when PayPal tells it about the sale."}
            </p>
            <p className="text-[13px] text-muted">PayPal payment ID: <span className="font-mono">{paid.capture_id}</span></p>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" href="/money/jars/activity">See the tax set aside</Button>
              <Button onClick={() => { setPaid(null); setPhase("ready"); }}>Buy something else</Button>
            </div>
          </div>
        </Card>
      ) : (
        <Card>
          {phase === "unavailable" && !config?.enabled ? (
            <p role="status" className="text-[15px] text-muted">The test store is off on this server. It needs the PayPal sandbox keys.</p>
          ) : (
            <form onSubmit={(e) => e.preventDefault()} className="space-y-5">
              <fieldset>
                <legend className="mb-3 text-[17px] font-semibold">Choose an item</legend>
                <div className="space-y-2">
                  {(config?.products ?? []).map((p) => (
                    <label
                      key={p.id}
                      className={`flex min-h-14 cursor-pointer items-center gap-3 rounded-2xl px-4 py-3 ring-1 transition has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-aqua ${
                        chosen === p.id ? "bg-primary-fixed ring-primary" : "ring-ink/[0.12] hover:bg-soft"
                      }`}
                    >
                      <input
                        type="radio"
                        name="product"
                        value={p.id}
                        checked={chosen === p.id}
                        onChange={() => setChosen(p.id)}
                        disabled={phase === "paying"}
                        className="h-5 w-5 accent-[var(--color-primary)]"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold">{p.name}</span>
                        <span className="block text-[13px] text-muted">{p.blurb}</span>
                      </span>
                      <span className="font-semibold tabular-nums">{money(p.price, p.currency)}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="space-y-2">
                {phase === "loading" && (
                  <p role="status" className="flex items-center gap-2 text-sm text-muted">
                    <Icon name="progress_activity" className="animate-spin text-[18px] motion-reduce:animate-none" /> Loading PayPal checkout…
                  </p>
                )}
                {(phase === "ready" || phase === "paying") && eligible && (
                  <>
                    <div aria-busy={phase === "paying"} className={phase === "paying" ? "pointer-events-none opacity-60" : ""}>
                      <paypal-button ref={button} type="pay" aria-describedby={hintId} />
                    </div>
                    <p id={hintId} className="text-[13px] text-muted">
                      Pays {product ? money(product.price, product.currency) : ""} for the {product?.name.toLowerCase() ?? "item"}. Opens PayPal&apos;s sandbox checkout.
                    </p>
                  </>
                )}
                {phase === "ready" && !eligible && (
                  <p role="status" className="text-sm text-muted">PayPal checkout isn&apos;t available in this browser.</p>
                )}
                <p aria-live="polite" className="sr-only">{phase === "paying" ? "Waiting for PayPal…" : ""}</p>
                {problem && <p role="alert" className="text-sm text-danger">{problem}</p>}
              </div>
            </form>
          )}
        </Card>
      )}

      <p className="text-center text-[13px] text-muted">
        Shop owner? <Link href="/" className="font-medium text-primary underline-offset-2 hover:underline">Open BundoPay</Link>
      </p>
    </div>
  );
}
