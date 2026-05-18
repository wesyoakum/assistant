// Quadrant — primary classifier output
export type Quadrant = "hot" | "action" | "plan" | "monitor" | "noop";

// Triage item from D1
export interface TriageItem {
  id: string;
  user_id: string;
  source_type: "email" | "document" | "image" | "voice" | "chat" | "calendar" | "event";
  source_ref: string | null;
  priority: number;
  urgency: number;
  quadrant: Quadrant | null;
  next_check_at: string | null;
  category: string | null;
  summary: string | null;
  suggested_action: string | null;
  classifier_json: string | null;
  status: "open" | "done" | "dismissed";
  created_at: string;
  updated_at: string;
}

export type FeedbackKind = "up" | "down" | "wrong_priority";

export interface FeedbackPayload {
  kind: FeedbackKind;
  corrected_priority?: number;
  corrected_urgency?: number;
  note?: string;
}

export interface StatusPayload {
  status: "done" | "dismissed";
}

// Queue message types
export type QueueMessage =
  | { type: "gmail.poll"; userId: string }
  | { type: "triage.classify"; userId: string; email: EmailContent }
  | { type: "triage.classify.file"; userId: string; fileId: string; kind: "image" | "pdf" | "audio"; r2Key: string }
  | { type: "push.send"; userId: string; triageItemId: string; summary: string };

export interface EmailContent {
  messageId: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  bodyText: string;
}

// Classifier output — 5-dimension scoring rubric
export interface TriageResult {
  // Primary classification
  quadrant: Quadrant;
  next_check_at?: string;
  // Scoring dimensions
  impact: number;
  meaning: number;
  responsibility: number;
  time_sensitivity: number;
  immediacy: number;
  // Synthesized scores (importance → maps to DB priority, urgency → DB urgency)
  importance: number;
  urgency: number;
  // Classification
  confidence: number;
  category: string;
  summary: string;
  suggested_action: string;
  reasoning?: string;
  skip?: boolean;
  updates_existing?: string;
  clarification_question?: string;
  suggested_calendar_event?: {
    title: string;
    start_iso: string;
    end_iso: string;
    location?: string;
  };
}

// Feedback row from D1 (used in prompt building)
export interface FeedbackRow {
  kind: FeedbackKind;
  corrected_priority: number | null;
  corrected_urgency: number | null;
  note: string | null;
  summary: string | null;
  category: string | null;
  original_priority: number;
  original_urgency: number;
}
