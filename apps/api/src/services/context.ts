/**
 * Unified context builder — one function, used by both classifier and chat.
 * Ensures both see identical data about the user's world.
 */

import type { Env } from "../index";
import type { FeedbackRow } from "@assistant/shared";
import { listUpcomingEvents, type CalendarEvent } from "./google-calendar";

export interface TriageItemContext {
  id: string;
  source_type: string;
  source_ref: string | null;
  thread_id: string | null;
  priority: number;
  urgency: number;
  category: string | null;
  summary: string | null;
  suggested_action: string | null;
  classifier_json: string | null;
  source_title: string | null;
  source_url: string | null;
  event_at: string | null;
  due_at: string | null;
  event_created_at: string | null;
  event_updated_at: string | null;
  extracted_content: string | null;
  created_at: string;
}

export interface ContextEntry {
  kind: string;
  label: string;
  detail: string | null;
}

export interface FullContext {
  // User
  userContext: ContextEntry[];
  preferences: ContextEntry[];
  features: ContextEntry[];

  // Triage
  openTriageItems: TriageItemContext[];
  recentDismissedItems: TriageItemContext[];

  // Calendar
  calendarEvents: CalendarEvent[];

  // Feedback
  feedbackHistory: FeedbackRow[];

  // Chat
  chatMegaSummary: string | null;
  chatChunkSummaries: string[];

  // Reminders
  activeReminders: { id: string; message: string; fire_at: string }[];

  // Documents with extracted content
  documents: { id: string; source_type: string; summary: string | null; extracted_content: string }[];

  // Time
  currentDateTime: string;
  timezone: string;
}

export async function buildFullContext(userId: string, env: Env): Promise<FullContext> {
  const tz = "America/Chicago";

  // All queries in parallel where possible
  const [
    contextResult,
    feedbackResult,
    openItemsResult,
    dismissedResult,
    megaResult,
    chunksResult,
    remindersResult,
    documentsResult,
  ] = await Promise.all([
    // User context
    env.DB.prepare(
      "SELECT kind, label, detail FROM user_context WHERE user_id = ?"
    ).bind(userId).all<ContextEntry>(),

    // All feedback
    env.DB.prepare(
      `SELECT f.kind, f.corrected_priority, f.corrected_urgency, f.note,
              t.summary, t.category, t.priority as original_priority, t.urgency as original_urgency
       FROM feedback f
       JOIN triage_items t ON t.id = f.triage_item_id
       WHERE f.user_id = ?
       ORDER BY f.created_at DESC`
    ).bind(userId).all<FeedbackRow>(),

    // All open triage items
    env.DB.prepare(
      `SELECT id, source_type, source_ref, thread_id, priority, urgency, category, summary,
              suggested_action, classifier_json, source_title, source_url, event_at, due_at,
              event_created_at, event_updated_at, extracted_content, created_at
       FROM triage_items WHERE user_id = ? AND status = 'open'
       ORDER BY priority DESC, urgency DESC`
    ).bind(userId).all<TriageItemContext>(),

    // Recent dismissed/done items (last 30 days)
    env.DB.prepare(
      `SELECT id, source_type, source_ref, thread_id, priority, urgency, category, summary,
              suggested_action, classifier_json, source_title, source_url, event_at, due_at,
              event_created_at, event_updated_at, extracted_content, created_at
       FROM triage_items WHERE user_id = ? AND status IN ('dismissed', 'done')
       AND updated_at > datetime('now', '-30 days')
       ORDER BY updated_at DESC`
    ).bind(userId).all<TriageItemContext>(),

    // Chat mega-summary
    env.DB.prepare(
      `SELECT summary FROM chat_summaries
       WHERE user_id = ? AND kind = 'mega'
       ORDER BY created_at DESC LIMIT 1`
    ).bind(userId).first<{ summary: string }>(),

    // Chunk summaries since last mega
    env.DB.prepare(
      `SELECT summary FROM chat_summaries
       WHERE user_id = ? AND kind = 'chunk'
       ORDER BY created_at`
    ).bind(userId).all<{ summary: string }>(),

    // Active reminders
    env.DB.prepare(
      `SELECT id, message, fire_at FROM reminders
       WHERE user_id = ? AND status = 'pending'
       ORDER BY fire_at`
    ).bind(userId).all<{ id: string; message: string; fire_at: string }>(),

    // Documents with extracted content (from all triage items, not just open)
    env.DB.prepare(
      `SELECT id, source_type, summary, extracted_content FROM triage_items
       WHERE user_id = ? AND extracted_content IS NOT NULL
       ORDER BY created_at DESC`
    ).bind(userId).all<{ id: string; source_type: string; summary: string | null; extracted_content: string }>(),
  ]);

  // Calendar events (full year) — separate because it hits Google API
  let calendarEvents: CalendarEvent[] = [];
  try {
    calendarEvents = await listUpcomingEvents(userId, env, 365, 500);
  } catch {
    // Token may be expired — continue without calendar
  }

  // Split context entries
  const allContext = contextResult.results;
  const userContext = allContext.filter((r) => r.kind !== "feature" && r.kind !== "preference");
  const preferences = allContext.filter((r) => r.kind === "preference");
  const features = allContext.filter((r) => r.kind === "feature");

  // Current date/time
  const now = new Date();
  const currentDateTime = now.toLocaleString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
    timeZone: tz,
  });

  return {
    userContext,
    preferences,
    features,
    openTriageItems: openItemsResult.results,
    recentDismissedItems: dismissedResult.results,
    calendarEvents,
    feedbackHistory: feedbackResult.results,
    chatMegaSummary: megaResult?.summary || null,
    chatChunkSummaries: chunksResult.results.map((r) => r.summary),
    activeReminders: remindersResult.results,
    documents: documentsResult.results,
    currentDateTime,
    timezone: `${tz} (CDT)`,
  };
}
