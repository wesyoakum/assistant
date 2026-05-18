import { z } from "zod/v4";

export const QUADRANTS = ["hot", "action", "plan", "monitor", "noop"] as const;
export type Quadrant = (typeof QUADRANTS)[number];

export const triageItemSchema = z
  .object({
    // Primary classification
    quadrant: z.enum(QUADRANTS),
    // Monitor re-check date (required when quadrant === 'monitor', optional otherwise)
    next_check_at: z.string().optional(),
    // 5 scoring dimensions
    impact: z.number().int().min(1).max(5),
    meaning: z.number().int().min(1).max(5),
    responsibility: z.number().int().min(1).max(5),
    time_sensitivity: z.number().int().min(1).max(5),
    immediacy: z.number().int().min(1).max(5),
    // Synthesized scores
    importance: z.number().int().min(1).max(5),
    urgency: z.number().int().min(1).max(5),
    // Classification
    confidence: z.number().int().min(1).max(5),
    category: z.string(),
    summary: z.string().max(500),
    suggested_action: z.string().max(500),
    reasoning: z.string().max(1000).optional(),
    skip: z.boolean().optional(),
    updates_existing: z.string().optional(),
    clarification_question: z.string().max(140).optional(),
    suggested_calendar_event: z
      .object({
        title: z.string(),
        start_iso: z.string(),
        end_iso: z.string(),
        location: z.string().optional(),
      })
      .optional(),
  })
  .refine(
    (v) => v.confidence > 2 || (v.clarification_question?.trim().length ?? 0) > 0,
    {
      message: "clarification_question is required when confidence <= 2",
      path: ["clarification_question"],
    }
  );

/** The wrapper schema: classifier returns { items: [...] }. */
export const triageResultSchema = z.object({
  items: z.array(triageItemSchema).min(1),
});

/** A single triage item from the classifier. */
export type TriageResult = z.infer<typeof triageItemSchema>;

/** The full classifier response (array of items). */
export type TriageResponse = z.infer<typeof triageResultSchema>;
