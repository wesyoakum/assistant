import type { Env } from "../index";
import type { FeedbackRow, QueueMessage } from "@assistant/shared";
import type { TriageResult } from "../prompts/triage.schema";
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
 * If the classifier determines this email relates to an existing action
 * (same thread, follow-up, reminder, etc.), it merges into the existing
 * triage item instead of creating a new one.
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

  // Pass open triage items so the classifier can detect merges
  const { results: openItems } = await env.DB.prepare(
    `SELECT id, source_type, source_ref, summary, category, priority, urgency
     FROM triage_items WHERE user_id = ? AND status = 'open'
     ORDER BY created_at DESC LIMIT 50`
  ).bind(userId).all<{
    id: string; source_type: string; source_ref: string | null;
    summary: string | null; category: string | null; priority: number; urgency: number;
  }>();

  // Append open items context to the user context entries so classifier sees them
  const contextWithItems = [...contextRows];
  if (openItems.length > 0) {
    const itemsList = openItems.map(
      (t) => `[id:${t.id}] P${t.priority}U${t.urgency} ${t.source_type}: ${t.summary || "no summary"}`
    ).join("\n");
    contextWithItems.push({
      kind: "system",
      label: "open_triage_items",
      detail: `Currently open actions (use updates_existing with the ID if this email relates to one):\n${itemsList}`,
    });
  }

  const result = await classifyEmail(
    email,
    feedbackRows,
    env.ANTHROPIC_API_KEY,
    contextWithItems,
    env.DB,
    userId
  );

  // Skip if already classified (prevents double-tap duplicates)
  const existingByRef = await env.DB.prepare(
    "SELECT id FROM triage_items WHERE user_id = ? AND source_ref = ? AND source_type = 'email'"
  ).bind(userId, email.messageId).first();
  if (existingByRef) {
    console.log(`Skipping duplicate classify for ${email.messageId}`);
    return { itemId: existingByRef.id as string, result };
  }

  // If classifier says this updates an existing triage item, merge
  if (result.updates_existing) {
    const target = await env.DB.prepare(
      "SELECT id, source_json, classifier_json FROM triage_items WHERE id = ? AND user_id = ?"
    ).bind(result.updates_existing, userId).first<{ id: string; source_json: string | null; classifier_json: string | null }>();

    if (target) {
      // Merge source_json: append this email to the sources array
      let sources: unknown[] = [];
      if (target.source_json) {
        try {
          const existing = JSON.parse(target.source_json);
          sources = Array.isArray(existing) ? existing : [existing];
        } catch { sources = []; }
      }
      sources.push(email);

      // Update the triage item with new scores and merged sources
      await env.DB.prepare(
        `UPDATE triage_items SET
           priority = ?, urgency = ?, category = ?, summary = ?,
           suggested_action = ?, classifier_json = ?, source_json = ?,
           source_title = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).bind(
        result.importance, result.urgency, result.category, result.summary,
        result.suggested_action, JSON.stringify(result), JSON.stringify(sources),
        email.from, target.id
      ).run();

      console.log(
        `Merged email ${email.messageId} into existing item ${target.id}: I${result.importance}/U${result.urgency}`
      );

      // Push if now high priority
      if (result.importance >= 4 || result.urgency >= 4) {
        await env.TASKS.send({
          type: "push.send", userId, triageItemId: target.id, summary: result.summary,
        } as QueueMessage);
      }

      return { itemId: target.id, result };
    }
  }

  // Create new triage item
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
      result.suggested_calendar_event?.start_iso
        ? new Date(result.suggested_calendar_event.start_iso).toISOString()
        : null,
      result.importance,
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

  if (result.importance >= 4 || result.urgency >= 4) {
    const pushMsg: QueueMessage = {
      type: "push.send",
      userId,
      triageItemId: itemId,
      summary: result.summary,
    };
    await env.TASKS.send(pushMsg);
  }

  console.log(
    `Classified email ${email.messageId} for user ${userId}: I${result.importance}/U${result.urgency} [impact:${result.impact} meaning:${result.meaning} resp:${result.responsibility} ts:${result.time_sensitivity} imm:${result.immediacy}]`
  );

  return { itemId, result };
}
