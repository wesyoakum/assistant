/**
 * Classifier eval harness — type definitions.
 *
 * Each fixture describes one classifier input and the expected outputs.
 * Expected values use buckets (not exact numbers) for score checks, so the
 * eval is resilient to minor score drift while still catching regressions.
 *
 * The primary correctness metric is quadrant accuracy. Dimension-bucket
 * checks are secondary.
 */

/** The five quadrants — primary classifier output. */
export type Quadrant = "hot" | "action" | "plan" | "monitor" | "noop";

/** Bucket for importance / urgency scores. */
export type ScoreBucket = "low" | "medium" | "high";

/** Map a 1-5 score to a bucket. */
export function toBucket(score: number): ScoreBucket {
  if (score <= 2) return "low";
  if (score === 3) return "medium";
  return "high";
}

/** Input source type — the eval can cover more than just email. */
export type FixtureSource = "email" | "calendar" | "capture" | "chat" | "ical";

/** A single eval fixture — one classifier input + expected outputs. */
export interface EvalFixture {
  /** Short human-readable ID, e.g. "noop-email-promo-01". */
  id: string;
  /** Optional description of what this fixture tests. */
  description?: string;
  /** Source type for this fixture. */
  source?: FixtureSource;
  /** The input fed to the classifier (rendered as the user message). */
  input: {
    from: string;
    subject: string;
    date: string;
    bodyText: string;
    /** Thread ID (optional, for merge-detection tests). */
    threadId?: string;
  };
  /** Expected classification outputs. */
  expected: {
    /** Expected quadrant — primary correctness metric. */
    quadrant: Quadrant;
    /** Expected category (exact match). */
    category: string;
    /** Expected importance bucket (secondary). */
    importanceBucket: ScoreBucket;
    /** Expected urgency bucket (secondary). */
    urgencyBucket: ScoreBucket;
    /** Whether the classifier should emit a suggested_calendar_event. */
    createsCalendarEvent: boolean;
    /** If set, the classifier should flag updates_existing. */
    shouldMerge?: boolean;
  };
}

/** Result of running one fixture through the classifier. */
export interface EvalResult {
  fixtureId: string;
  /** Whether the fixture passed all checks. */
  pass: boolean;
  /** Per-check results. */
  checks: {
    quadrant: { expected: Quadrant; actual: string; pass: boolean };
    category: { expected: string; actual: string; pass: boolean };
    importanceBucket: { expected: ScoreBucket; actual: ScoreBucket; pass: boolean };
    urgencyBucket: { expected: ScoreBucket; actual: ScoreBucket; pass: boolean };
    calendarEvent: { expected: boolean; actual: boolean; pass: boolean };
    merge?: { expected: boolean; actual: boolean; pass: boolean };
  };
  /** Raw classifier output for inspection. */
  raw: Record<string, unknown>;
  /** Cost in cents for this classification. */
  costCents: number;
  /** Latency in milliseconds. */
  latencyMs: number;
}

/** Summary of a full eval run. */
export interface EvalSummary {
  timestamp: string;
  model: string;
  totalFixtures: number;
  passed: number;
  failed: number;
  accuracy: number;
  /** Per-check accuracy. */
  quadrantAccuracy: number;
  categoryAccuracy: number;
  importanceAccuracy: number;
  urgencyAccuracy: number;
  calendarAccuracy: number;
  /** Quadrant confusion matrix: confusionMatrix[expected][predicted] = count. */
  confusionMatrix: Record<Quadrant, Record<string, number>>;
  /** Cost and latency. */
  totalCostCents: number;
  avgLatencyMs: number;
  /** Individual results. */
  results: EvalResult[];
}
