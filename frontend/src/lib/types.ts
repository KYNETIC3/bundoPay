export type DisputeSummary = {
  id: string;
  paypal_dispute_id: string;
  status: string;
  reason: string | null;
  reason_label: string | null;
  lifecycle_stage: string | null;
  amount: string | null;
  currency: string | null;
  due_date: string | null;
  updated_at: string;
  draft_id?: string | null;
  draft_action?: string | null;
  draft_status?: string | null;
};

export type EvidenceRow = {
  requested_evidence_type: string;
  satisfying_record: string | null;
  source_system: string | null;
  match_confidence: number;
  gap_or_conflict: string | null;
  requested_by: "PAYPAL" | "REASON_DEFAULT";
  evidence_info: Record<string, unknown>;
};

export type Flag = { kind: string; detail: string; severity: "high" | "medium" };

export type Recommendation = {
  action: string | null;
  reasons: string[];
  allowed_actions: string[];
  hours_remaining: number | null;
  past_due: boolean;
  source: string;
  offer_amount: string | null;
};

export type DraftFile = { filename: string; content_type: string; size: number; sha256: string; evidence_type: string };

export type Draft = {
  id: string;
  action: "provide_evidence" | "make_offer" | "accept_claim";
  payload_json: Record<string, any>;
  files: DraftFile[];
  missing_items: { evidence_type: string | null; detail: string }[];
  payload_hash: string;
  status: string;
  created_at: string;
  updated_at: string;
};

export type DisputeDetail = DisputeSummary & {
  past_due: boolean;
  allowed_actions: string[];
  requested_evidences: { evidence_type: string; notes?: string; date?: string }[];
  outcome_code: string | null;
  paypal_timeline: { at: string; label: string; kind?: string }[];
  activity: { event: string; data_json: Record<string, any>; created_at: string }[];
  evidence_map: {
    id: string;
    rows_json: EvidenceRow[];
    integrity_flags: Flag[];
    coverage_score: string;
    recommendation: Recommendation | null;
    created_at: string;
  } | null;
  draft: Draft | null;
  outcome: { final_status: string; resolved_at: string } | null;
};
