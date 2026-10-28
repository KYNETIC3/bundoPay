"use client";

import { useEffect, useMemo, useState } from "react";

import { api } from "@/lib/api";
import { useLive } from "@/lib/hooks";
import type { Insights, Overview } from "@/lib/treasury";
import type { DisputeSummary } from "@/lib/types";

import { type StoreKind, type StoreRecords, buildModel } from "./model";

/** Store CSVs the merchant uploaded in Settings. Only kinds with rows are fetched, so a store with no data costs
 * one small request and adds nothing to the boards. */
function useStoreRecords(): StoreRecords {
  const summary = useLive<{ kind: StoreKind; rows: number }[]>("/data/summary", 300_000);
  const [records, setRecords] = useState<StoreRecords>({});
  const kinds = (summary.data ?? []).filter((s) => s.rows > 0).map((s) => s.kind).sort().join(",");
  useEffect(() => {
    if (!kinds) return setRecords({});
    let live = true;
    Promise.all(
      kinds.split(",").map((k) =>
        api<{ rows: Record<string, string | null>[] }>(`/data/records?kind=${k}`)
          .then((r) => [k, r.rows] as const)
          .catch(() => [k, []] as const),
      ),
    ).then((pairs) => live && setRecords(Object.fromEntries(pairs)));
    return () => {
      live = false;
    };
  }, [kinds]);
  return records;
}

/** Everything a board needs, loaded once per page and kept fresh the same way as the rest of the app. */
export function useMoneyModel(days = 30) {
  const overview = useLive<Overview>("/treasury/overview", 15_000);
  const insights = useLive<Insights>("/treasury/insights?days=90", 60_000);
  const disputes = useLive<DisputeSummary[]>("/disputes");
  const records = useStoreRecords();
  const currency = overview.data?.limits.currency ?? disputes.data?.find((d) => d.currency)?.currency ?? "USD";
  const model = useMemo(
    () => buildModel({ currency, overview: overview.data, insights: insights.data, disputes: disputes.data ?? [], records, days }),
    [currency, overview.data, insights.data, disputes.data, records, days],
  );
  return {
    model,
    currency,
    overview,
    disputes,
    insights,
    hasStore: !!records.orders?.length,
    ready: !!overview.data && !!disputes.data && !!insights.data,
  };
}
