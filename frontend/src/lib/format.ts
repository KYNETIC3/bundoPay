export const FEATURE_COPY: Record<string, { title: string; why: string }> = {
  READ_SELLER_DISPUTE: {
    title: "See your disputes",
    why: "To list open disputes, read what PayPal is asking you for, and follow each one to resolution.",
  },
  UPDATE_SELLER_DISPUTE: {
    title: "Respond to disputes, only after you approve",
    why: "To send evidence, an offer, or an acceptance that you have reviewed and approved. Nothing is sent without your approval.",
  },
  ADVANCED_TRANSACTIONS_SEARCH: {
    title: "Look up the disputed transactions",
    why: "To check amounts, dates and refunds against your own records.",
  },
  TRACKING_SHIPMENT_READWRITE: {
    title: "Read shipment tracking",
    why: "To see whether a package was delivered. PayPal bundles read and write access here, but BundoPay never adds or changes tracking.",
  },
  ACCESS_MERCHANT_INFORMATION: {
    title: "Confirm the connection",
    why: "To check which permissions you granted, so we never act beyond them.",
  },
};

export const STAGE_LABELS: Record<string, string> = {
  INQUIRY: "Inquiry",
  CHARGEBACK: "Chargeback",
  PRE_ARBITRATION: "Pre-arbitration",
  ARBITRATION: "Arbitration",
};

export const STATUS_LABELS: Record<string, string> = {
  OPEN: "Open",
  WAITING_FOR_BUYER_RESPONSE: "Waiting on buyer",
  WAITING_FOR_SELLER_RESPONSE: "Your response needed",
  UNDER_REVIEW: "PayPal reviewing",
  RESOLVED: "Resolved",
  OTHER: "Other",
};

export const ACTION_LABELS: Record<string, string> = {
  provide_evidence: "Provide evidence",
  make_offer: "Make an offer",
  accept_claim: "Accept the claim",
};

export function money(amount: string | null, currency: string | null): string {
  if (amount == null) return "—";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency ?? "USD" }).format(Number(amount));
  } catch {
    return `${currency ?? ""} ${amount}`;
  }
}

export function humanize(code: string | null | undefined): string {
  if (!code) return "";
  const s = code.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function remaining(iso: string | null): { text: string; hours: number } | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  const hours = ms / 36e5;
  if (ms <= 0) return { text: "Deadline passed", hours };
  if (hours < 1) return { text: `${Math.max(1, Math.round(ms / 6e4))} min left`, hours };
  if (hours < 48) return { text: `${Math.floor(hours)}h ${Math.floor((hours % 1) * 60)}m left`, hours };
  return { text: `${Math.floor(hours / 24)} days left`, hours };
}

/** "just now", "5 min ago", "2 hours ago", "3 days ago": for activity lists where the exact minute rarely matters. */
export function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 45) return "just now";
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (s < 3600) return rtf.format(-Math.round(s / 60), "minute");
  if (s < 86400) return rtf.format(-Math.round(s / 3600), "hour");
  if (s < 86400 * 14) return rtf.format(-Math.round(s / 86400), "day");
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** "Fri 30 Oct, 10:00" in the viewer's own time zone. */
export function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** "14:02" in the viewer's own time zone. */
export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Who did the reasoning: Gemini (whose output code then checks), or the built-in rules when no model answered. */
export function aiSource(source: string | null | undefined): { label: string; icon: string } {
  return source?.startsWith("model")
    ? { label: "Reasoned by Gemini \u00b7 checked by code", icon: "auto_awesome" }
    : { label: "Built-in rules", icon: "rule" };
}
