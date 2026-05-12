import { z } from "zod/v4";

export const triageResultSchema = z
  .object({
    priority: z.number().int().min(1).max(5),
    urgency: z.number().int().min(1).max(5),
    confidence: z.number().int().min(1).max(5),
    category: z.string(),
    summary: z.string().max(300),
    suggested_action: z.string().max(500),
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

export type TriageResult = z.infer<typeof triageResultSchema>;
