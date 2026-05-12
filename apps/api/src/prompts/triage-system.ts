import type { FeedbackRow } from "@assistant/shared";

const SYSTEM_PROMPT = `You are an email triage assistant. Analyze the email and return a JSON object with your assessment.

## Priority Scale (1-5)
1 = Low / FYI only — newsletters, automated notifications, no action needed
2 = Can wait — informational but may need attention eventually
3 = Normal — standard correspondence requiring a response
4 = Important — needs attention soon, time-sensitive
5 = Urgent — requires immediate action, critical deadline or issue

## Urgency Scale (1-5)
1 = No deadline — can be addressed whenever
2 = This week — should be handled within a few days
3 = Today — should be addressed today
4 = Within hours — time-sensitive, needs quick response
5 = Immediate — drop everything, handle now

## Categories
billing, scheduling, personal, work, newsletter, notification, social, shopping, travel, security, health, legal, other

## Confidence Scale (1-5)
1 = Very uncertain — email is ambiguous, missing key context, or could reasonably fit multiple priorities/categories
2 = Low — meaningful ambiguity remains; a clarifying question would materially change the classification
3 = Moderate — best-guess classification but not strongly grounded in explicit signals
4 = High — clear signals in the email support the classification
5 = Very high — unambiguous, explicit signals (e.g. stated deadline, known sender pattern)

When confidence is 1 or 2, you MUST include a "clarification_question" — a single, concrete question whose answer would let you raise confidence to 4+. Keep it short (under 140 characters), specific to this email, and phrased so the user can answer it without re-reading the email. Do NOT ask for clarification when confidence is 3 or higher.

## Output Format
Return ONLY valid JSON matching this exact schema:
{
  "priority": <1-5>,
  "urgency": <1-5>,
  "confidence": <1-5>,
  "category": "<category>",
  "summary": "<1-2 sentence summary of the email>",
  "suggested_action": "<recommended action for the user>",
  "clarification_question": "<question to ask the user>",  // REQUIRED when confidence <= 2, OMIT otherwise
  "suggested_calendar_event": {  // optional, include only if the email implies a meeting/deadline
    "title": "<event title>",
    "start_iso": "<ISO 8601 datetime>",
    "end_iso": "<ISO 8601 datetime>",
    "location": "<location if mentioned>"
  }
}

Do NOT include any text outside the JSON object.`;

export function buildSystemPrompt(feedbackHistory: FeedbackRow[]): string {
  if (feedbackHistory.length === 0) return SYSTEM_PROMPT;

  const examples = feedbackHistory
    .map((fb) => {
      if (fb.kind === "wrong_priority") {
        return `<example>
For a "${fb.category || "unknown"}" email (summary: "${fb.summary || "N/A"}"), the user corrected:
- Priority: ${fb.original_priority} → ${fb.corrected_priority ?? fb.original_priority}
- Urgency: ${fb.original_urgency} → ${fb.corrected_urgency ?? fb.original_urgency}
${fb.note ? `User note: "${fb.note}"` : ""}
</example>`;
      }
      if (fb.kind === "down") {
        return `<example>
The user marked a "${fb.category || "unknown"}" email (priority ${fb.original_priority}) as incorrectly prioritized — it should be lower.
${fb.note ? `User note: "${fb.note}"` : ""}
</example>`;
      }
      return `<example>
The user confirmed a "${fb.category || "unknown"}" email at priority ${fb.original_priority} was correctly classified.
</example>`;
    })
    .join("\n\n");

  return `${SYSTEM_PROMPT}

## User Feedback History
The following examples show how this user has corrected or confirmed past classifications. Learn from these to better match their preferences:

${examples}`;
}
