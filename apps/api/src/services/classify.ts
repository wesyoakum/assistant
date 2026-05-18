import type { Env } from "../index";
import type { FeedbackRow, QueueMessage } from "@assistant/shared";
import type { TriageResult } from "../prompts/triage.schema";
import { classifyEmail, classifyFile, logUsage } from "./claude";
import { buildSystemPrompt, type ContextEntry } from "../prompts/triage-system";

// ---------------------------------------------------------------------------
// Unified classify input — one discriminated union for all source types
// ---------------------------------------------------------------------------

export type ClassifyInput =
  | { kind: "email"; messageId: string; threadId: string; subject: string; from: string; date: string; bodyText: string }
  | { kind: "calendar"; eventId: string; calendarId: string; calendarName: string; summary: string; start: string; end: string; location?: string; description?: string }
  | { kind: "file"; fileId: string; fileKind: "pdf" | "image" | "audio"; r2Key: string }
  | { kind: "chat"; summary: string; userMessage: string };

// Keep the old shape as an alias for callers that haven't migrated yet
export type ClassifyEmailInput = Extract<ClassifyInput, { kind: "email" }>;

/** Fill in default next_check_at for Monitor items that the model didn't set. */
function ensureNextCheckAt(result: TriageResult): TriageResult {
  if (result.quadrant === "monitor" && !result.next_check_at) {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    result.next_check_at = d.toISOString();
  }
  return result;
}

// ---------------------------------------------------------------------------
// Shared helpers: fetch feedback, context, open items
// ---------------------------------------------------------------------------

async function fetchClassifyContext(userId: string, env: Env) {
  const [{ results: feedbackRows }, { results: contextRows }, { results: openItems }] = await Promise.all([
    env.DB.prepare(
      `SELECT f.kind, f.corrected_priority, f.corrected_urgency, f.note,
              t.summary, t.category, t.priority as original_priority, t.urgency as original_urgency
       FROM feedback f
       JOIN triage_items t ON t.id = f.triage_item_id
       WHERE f.user_id = ?
       ORDER BY f.created_at DESC
       LIMIT 10`
    ).bind(userId).all<FeedbackRow>(),
    env.DB.prepare(
      "SELECT kind, label, detail FROM user_context WHERE user_id = ?"
    ).bind(userId).all<ContextEntry>(),
    env.DB.prepare(
      `SELECT id, source_type, source_ref, summary, category, priority, urgency, quadrant
       FROM triage_items WHERE user_id = ? AND status = 'open'
       ORDER BY created_at DESC LIMIT 50`
    ).bind(userId).all<{
      id: string; source_type: string; source_ref: string | null;
      summary: string | null; category: string | null; priority: number; urgency: number;
      quadrant: string | null;
    }>(),
  ]);

  // Append open items so the classifier can detect merges
  const contextWithItems: ContextEntry[] = [...contextRows];
  if (openItems.length > 0) {
    const itemsList = openItems.map(
      (t) => `[id:${t.id}] ${t.quadrant || "?"} I${t.priority}U${t.urgency} ${t.source_type}: ${t.summary || "no summary"}`
    ).join("\n");
    contextWithItems.push({
      kind: "system",
      label: "open_triage_items",
      detail: `Currently open actions (use updates_existing with the ID if this input relates to one):\n${itemsList}`,
    });
  }

  return { feedbackRows, contextEntries: contextWithItems };
}

// ---------------------------------------------------------------------------
// Unified classify + store
// ---------------------------------------------------------------------------

export async function classifyAndStore(
  userId: string,
  input: ClassifyInput,
  env: Env
): Promise<{ itemId: string; result: TriageResult }> {
  const { feedbackRows, contextEntries } = await fetchClassifyContext(userId, env);

  // Source-specific: determine sourceType, sourceRef, call classifier
  let result: TriageResult;
  let sourceType: string;
  let sourceRef: string;
  let sourceTitle: string | null = null;
  let sourceJson: unknown = null;
  let eventAt: string | null = null;
  let extractedContent: string | null = null;

  if (input.kind === "email") {
    sourceType = "email";
    sourceRef = input.messageId;
    sourceTitle = input.from;
    sourceJson = input;
    if (input.date) eventAt = null; // email doesn't set event_at
    result = await classifyEmail(input, feedbackRows, env.ANTHROPIC_API_KEY, contextEntries, env.DB, userId);
  } else if (input.kind === "calendar") {
    sourceType = "event";
    sourceRef = input.eventId;
    sourceTitle = input.calendarName;
    sourceJson = input;
    eventAt = input.start;
    // Render calendar event as user message for the classifier
    const calendarContent = `Calendar Event: "${input.summary}"\nCalendar: ${input.calendarName}\nStart: ${input.start}\nEnd: ${input.end}${input.location ? `\nLocation: ${input.location}` : ""}${input.description ? `\nDescription: ${input.description}` : ""}`;
    const emailShape = {
      messageId: input.eventId,
      threadId: "",
      subject: input.summary,
      from: input.calendarName,
      date: input.start,
      bodyText: calendarContent,
    };
    result = await classifyEmail(emailShape, feedbackRows, env.ANTHROPIC_API_KEY, contextEntries, env.DB, userId);
  } else if (input.kind === "file") {
    sourceType = input.fileKind === "audio" ? "voice" : input.fileKind === "pdf" ? "document" : "image";
    sourceRef = input.fileId;
    // Fetch file from R2 and classify with vision/audio
    const obj = await env.FILES.get(input.r2Key);
    if (!obj) throw new Error(`File not found in R2: ${input.r2Key}`);
    const fileBytes = await obj.arrayBuffer();
    const contentType = obj.httpMetadata?.contentType || "application/octet-stream";
    result = await classifyFile(input.fileKind, fileBytes, contentType, feedbackRows, env.ANTHROPIC_API_KEY, contextEntries, env.DB, userId);
    // TODO: extract content from the classifier response for document memory
    // extractedContent = result.extracted_content;  // needs two-pass classifier
  } else {
    // kind === "chat"
    sourceType = "chat";
    sourceRef = crypto.randomUUID();
    const emailShape = {
      messageId: sourceRef,
      threadId: "",
      subject: input.summary,
      from: "User (chat)",
      date: new Date().toISOString(),
      bodyText: input.userMessage,
    };
    result = await classifyEmail(emailShape, feedbackRows, env.ANTHROPIC_API_KEY, contextEntries, env.DB, userId);
  }

  result = ensureNextCheckAt(result);

  // Dedup check
  if (input.kind === "email") {
    const existingByRef = await env.DB.prepare(
      "SELECT id FROM triage_items WHERE user_id = ? AND source_ref = ? AND source_type = 'email'"
    ).bind(userId, sourceRef).first();
    if (existingByRef) {
      console.log(`Skipping duplicate classify for ${sourceRef}`);
      return { itemId: existingByRef.id as string, result };
    }
  } else if (input.kind === "calendar") {
    const existingByRef = await env.DB.prepare(
      "SELECT id FROM triage_items WHERE user_id = ? AND source_ref = ? AND source_type IN ('event', 'calendar')"
    ).bind(userId, sourceRef).first();
    if (existingByRef) {
      console.log(`Skipping duplicate classify for calendar event ${sourceRef}`);
      return { itemId: existingByRef.id as string, result };
    }
  }

  // Merge path: if classifier says this updates an existing item
  if (result.updates_existing) {
    const target = await env.DB.prepare(
      "SELECT id, source_json, classifier_json FROM triage_items WHERE id = ? AND user_id = ?"
    ).bind(result.updates_existing, userId).first<{ id: string; source_json: string | null; classifier_json: string | null }>();

    if (target) {
      let sources: unknown[] = [];
      if (target.source_json) {
        try {
          const existing = JSON.parse(target.source_json);
          sources = Array.isArray(existing) ? existing : [existing];
        } catch { sources = []; }
      }
      if (sourceJson) sources.push(sourceJson);

      await env.DB.prepare(
        `UPDATE triage_items SET
           priority = ?, urgency = ?, quadrant = ?, next_check_at = ?,
           category = ?, summary = ?,
           suggested_action = ?, classifier_json = ?, source_json = ?,
           source_title = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).bind(
        result.importance, result.urgency, result.quadrant, result.next_check_at ?? null,
        result.category, result.summary,
        result.suggested_action, JSON.stringify(result), JSON.stringify(sources),
        sourceTitle, target.id
      ).run();

      console.log(`Merged ${input.kind} ${sourceRef} into existing item ${target.id}: ${result.quadrant} I${result.importance}/U${result.urgency}`);

      if (result.quadrant === "hot") {
        await env.TASKS.send({
          type: "push.send", userId, triageItemId: target.id, summary: result.summary,
        } as QueueMessage);
      }

      return { itemId: target.id, result };
    }
  }

  // Create new triage item
  const itemId = crypto.randomUUID();

  // Compute event_at: for calendar items use start; for emails use suggested event start if present
  if (!eventAt && result.suggested_calendar_event?.start_iso) {
    try {
      eventAt = new Date(result.suggested_calendar_event.start_iso).toISOString();
    } catch { /* ignore bad dates */ }
  }

  await env.DB.prepare(
    `INSERT INTO triage_items (id, user_id, source_type, source_ref, source_title, event_at, priority, urgency, quadrant, next_check_at, category, summary, suggested_action, classifier_json, source_json, extracted_content, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`
  ).bind(
    itemId, userId, sourceType, sourceRef, sourceTitle, eventAt,
    result.importance, result.urgency, result.quadrant, result.next_check_at ?? null,
    result.category, result.summary, result.suggested_action,
    JSON.stringify(result), sourceJson ? JSON.stringify(sourceJson) : null,
    extractedContent
  ).run();

  // Calendar suggestion (from email or calendar source)
  if (result.suggested_calendar_event) {
    const evt = result.suggested_calendar_event;
    await env.DB.prepare(
      `INSERT INTO calendar_suggestions (id, user_id, triage_item_id, title, start_iso, end_iso, location, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
    ).bind(crypto.randomUUID(), userId, itemId, evt.title, evt.start_iso, evt.end_iso, evt.location ?? null).run();
  }

  // Push for hot items
  if (result.quadrant === "hot") {
    await env.TASKS.send({
      type: "push.send", userId, triageItemId: itemId, summary: result.summary,
    } as QueueMessage);
  }

  // Update ingested_files status for file inputs
  if (input.kind === "file") {
    await env.DB.prepare(
      "UPDATE ingested_files SET status = 'done' WHERE id = ?"
    ).bind(input.fileId).run();
  }

  console.log(
    `Classified ${input.kind} ${sourceRef} for user ${userId}: ${result.quadrant} I${result.importance}/U${result.urgency}`
  );

  return { itemId, result };
}

// ---------------------------------------------------------------------------
// Backward-compatible wrapper — callers that use the old email-specific API
// ---------------------------------------------------------------------------

export async function classifyAndStoreEmail(
  userId: string,
  email: ClassifyEmailInput,
  env: Env
): Promise<{ itemId: string; result: TriageResult }> {
  return classifyAndStore(userId, email, env);
}
