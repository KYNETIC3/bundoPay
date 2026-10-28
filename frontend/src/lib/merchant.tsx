"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

import { api } from "./api";

export type MerchantStatus = {
  email: string;
  paypal_merchant_id: string | null;
  grant_status: "not_connected" | "pending" | "granted" | "revoked";
  granted_scopes: string[];
  connected_at: string | null;
  last_synced_at: string | null;
  test_mode: boolean;
  is_demo: boolean;
};

type Ctx = { status: MerchantStatus | null; refresh: () => Promise<void> };
const MerchantContext = createContext<Ctx>({ status: null, refresh: async () => {} });

export function MerchantProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<MerchantStatus | null>(null);
  const refresh = useCallback(async () => {
    try {
      setStatus(await api<MerchantStatus>("/onboarding/status"));
    } catch {
      /* shown as "not connected" until the next refresh */
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return <MerchantContext.Provider value={{ status, refresh }}>{children}</MerchantContext.Provider>;
}

export const useMerchant = () => useContext(MerchantContext);
