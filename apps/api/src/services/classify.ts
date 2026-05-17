import type { Env } from "../index";
import type { FeedbackRow, QueueMessage, TriageResult } from "@assistant/shared";
import { classifyEmail } from "./claude";

export interface ClassifyEmailInput {
  messageId: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  bodyText: string;
}

/**
 * Classify a single email with Claude, persist the triage item (plus any
 * calendar suggestion), and enqueue a high-priority push when warranted.
 *
 * This is the single source of truth for the email classify+store path,
 * shared by the automatic queue consumer and controlled-mode manual runs.
 * Push suppression for controlled mode is enforced downstream in the
 * `push.send` handler, so this always enqueues when priority/urgency is high.
 */
export async function classifyAndStoreEmail(
  userId: string,
  email: ClassifyEmailInput,
  env: Env
): Promise<{ itemId: string; result: TriageResult }> {
  const { results: feedbackRows } = await env.DB.prepare(
    `SELECT f.kind, f.corrected_priority, f.corrected_urgency, f.note,
            t.summary, t.category, t.priority as original_priority, t.urgency as original_urgency
     FROM feedback f
     JOIN triage_items t ON t.id = f.triage_item_id
     WHERE f.user_id = ?
     ORDER BY f.created_at DESC
     LIMIT 10`
  )
    .bind(userId)
    .all<FeedbackRow>();

  const { results: contextRows } = await env.DB.prepare(
    "SELECT kind, label, detail FROM user_context WHERE user_id = ?"
  )
    .bind(userId)
    .all<{ kind: string; label: string; detail: string | null }>();

  const result = await classifyEmail(
    email,
    feedbackRows,
    env.ANTHROPIC_API_KEY,
    contextRows
  );

  const itemId = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO triage_items (id, user_id, source_type, source_ref, source_title, event_at, priority, urgency, category, summary, suggested_action, classifier_json, source_json, status)
     VALUES (?, ?, 'email', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`
  )
    .bind(
      itemId,
      userId,
      email.messageId,
      email.from,
      email.date ? new Date(email.date).toISOString() : null,
      result.priority,
      result.urgency,
      result.category,
      result.summary,
      result.suggested_action,
      JSON.stringify(result),
      JSON.stringify(email)
    )
    .run();

  if (result.suggested_calendar_event) {
    const evt = result.suggested_calendar_event;
    await env.DB.prepare(
      `INSERT INTO calendar_suggestions (id, user_id, triage_item_id, title, start_iso, end_iso, location, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
    )
      .bind(
        crypto.randomUUID(),
        userId,
        itemId,
        evt.title,
        evt.start_iso,
        evt.end_iso,
        evt.location ?? null
      )
      .run();
  }

  if (result.priority >= 4 || result.urgency >= 4) {
    const pushMsg: QueueMessage = {
      type: "push.send",
      userId,
      triageItemId: itemId,
      summary: result.summary,
    };
    await env.TASKS.send(pushMsg);
  }

  console.log(
    `Classified email ${email.messageId} for user ${userId}: P${result.priority}/U${result.urgency}`
  );

  return { itemId, result };
}
