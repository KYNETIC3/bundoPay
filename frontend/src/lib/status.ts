import type { Tone } from "@/components/ui";

export function disputeStatus(status: string): { label: string; tone: Tone } {
  switch (status) {
    case "WAITING_FOR_SELLER_RESPONSE":
      return { label: "Needs you", tone: "coral" };
    case "UNDER_REVIEW":
      return { label: "PayPal reviewing", tone: "steel" };
    case "WAITING_FOR_BUYER_RESPONSE":
      return { label: "Waiting on buyer", tone: "cream" };
    case "RESOLVED":
      return { label: "Closed", tone: "soft" };
    default:
      return { label: "Open", tone: "cream" };
  }
}

/** What the agent has done, in a word or two. */
export function agentState(d: { status: string; draft_status: string | null; draft_action: string | null }): {
  label: string;
  tone: Tone;
} {
  if (d.status === "RESOLVED") return { label: "Done", tone: "soft" };
  switch (d.draft_status) {
    case "awaiting_approval":
      return { label: d.draft_action === "accept_claim" ? "Refund ready" : "Reply ready", tone: "plum" };
    case "submitted":
      return { label: d.draft_action === "accept_claim" ? "Refunded" : "Sent", tone: "cerulean" };
    case "failed":
      return { label: "Didn't go through", tone: "danger" };
    case "rejected":
      return { label: "You declined", tone: "soft" };
    default:
      return d.status === "WAITING_FOR_SELLER_RESPONSE" ? { label: "Not reviewed", tone: "cream" } : { label: "—", tone: "soft" };
  }
}

export const ACTION_VERB: Record<string, string> = {
  accept_claim: "Refund",
  make_offer: "Offer partial refund",
  provide_evidence: "Send proof",
};
