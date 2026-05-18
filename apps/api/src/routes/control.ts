import { Hono } from "hono";
import { z } from "zod/v4";
import type { Env } from "../index";
import type { AuthVariables } from "../middleware/auth";
import { authMiddleware } from "../middleware/auth";
import { getValidAccessToken, fetchNewMessages } from "../services/gmail";
import { listUpcomingEvents } from "../services/google-calendar";
import { classifyAndStoreEmail, classifyAndStore } from "../services/classify";
import { getUserSettings, setUserSettings } from "../services/settings";

type ControlApp = Hono<{ Bindings: Env; Variables: AuthVariables }>;

const control: ControlApp = new Hono();

control.use("*", authMiddleware);

interface PendingRow {
  id: string;
  message_id: string;
  thread_id: string | null;
  subject: string | null;
  from_addr: string | null;
  email_date: string | null;
  snippet: string | null;
  body_text: string | null;
  source_type: string;
  collected_at: string;
}

async function collectedCount(userId: string, env: Env): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) as c FROM pending_emails WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

async function collectedPreview(userId: string, env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT subject, from_addr, snippet, source_type, collected_at
     FROM pending_emails WHERE user_id = ?
     ORDER BY collected_at ASC LIMIT 50`
  )
    .bind(userId)
    .all<{ subject: string | null; from_addr: string | null; snippet: string | null; source_type: string; collected_at: string }>();
  return results.map((r) => ({
    subject: r.subject || "(no subject)",
    from: r.from_addr || "",
    snippet: r.snippet || "",
    source_type: r.source_type || "email",
    collected_at: r.collected_at,
  }));
}

// Current mode, batch size, and what is collected awaiting classification.
control.get("/status", async (c) => {
  const userId = c.get("userId");
  const settings = await getUserSettings(userId, c.env);
  const collected = await collectedCount(userId, c.env);
  return c.json({
    mode: settings.mode,
    batchSize: settings.controlledBatchSize,
    collected,
    pending: collected,
    items: await collectedPreview(userId, c.env),
  });
});

const modeSchema = z.object({
  mode: z.enum(["normal", "controlled"]).optional(),
  batch_size: z.number().int().min(1).max(20).optional(),
});

// Toggle mode / set batch size.
control.post("/mode", async (c) => {
  const userId = c.get("userId");
  const parsed = modeSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }
  const settings = await setUserSettings(userId, c.env, {
    mode: parsed.data.mode,
    controlledBatchSize: parsed.data.batch_size,
  });
  return c.json({ mode: settings.mode, batchSize: settings.controlledBatchSize });
});

// Step 1 — manual context collection from ALL sources: email, calendar, captures.
control.post("/collect", async (c) => {
  const userId = c.get("userId");

  let emailsCollected = 0;
  let calendarCollected = 0;
  let capturesCollected = 0;

  // --- Emails ---
  try {
    const accessToken = await getValidAccessToken(userId, c.env);

    const syncState = await c.env.DB.prepare(
      "SELECT history_id FROM gmail_sync_state WHERE user_id = ?"
    ).bind(userId).first<{ history_id: string | null }>();

    const { messages, newHistoryId } = await fetchNewMessages(
      accessToken,
      syncState?.history_id
    );

    for (const msg of messages) {
      const existing = await c.env.DB.prepare(
        "SELECT id FROM triage_items WHERE user_id = ? AND source_ref = ?"
      ).bind(userId, msg.messageId).first();
      if (existing) continue;

      const alreadyPending = await c.env.DB.prepare(
        "SELECT id FROM pending_emails WHERE user_id = ? AND message_id = ?"
      ).bind(userId, msg.messageId).first();
      if (alreadyPending) continue;

      const result = await c.env.DB.prepare(
        `INSERT OR IGNORE INTO pending_emails
           (id, user_id, message_id, thread_id, subject, from_addr, email_date, snippet, body_text, source_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'email')`
      ).bind(
        crypto.randomUUID(), userId,
        msg.messageId, msg.threadId, msg.subject, msg.from, msg.date, msg.snippet, msg.bodyText
      ).run();
      if (result.meta.changes) emailsCollected++;
    }

    if (syncState) {
      await c.env.DB.prepare(
        "UPDATE gmail_sync_state SET history_id = ?, last_synced_at = datetime('now') WHERE user_id = ?"
      ).bind(newHistoryId, userId).run();
    } else {
      await c.env.DB.prepare(
        "INSERT INTO gmail_sync_state (id, user_id, history_id, last_synced_at) VALUES (?, ?, ?, datetime('now'))"
      ).bind(crypto.randomUUID(), userId, newHistoryId).run();
    }
  } catch (err) {
    console.error("Collect emails failed:", err);
  }

  // --- Calendar events ---
  try {
    const events = await listUpcomingEvents(userId, c.env, 30, 100);

    for (const evt of events) {
      // Skip if already triaged
      const existing = await c.env.DB.prepare(
        "SELECT id FROM triage_items WHERE user_id = ? AND source_ref = ? AND source_type IN ('event', 'calendar')"
      ).bind(userId, evt.id).first();
      if (existing) continue;

      // Skip if already pending
      const alreadyPending = await c.env.DB.prepare(
        "SELECT id FROM pending_emails WHERE user_id = ? AND message_id = ? AND source_type = 'calendar'"
      ).bind(userId, evt.id).first();
      if (alreadyPending) continue;

      const evtSummary = `${evt.summary} — ${new Date(evt.start).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}`;
      const evtBody = `Calendar: ${evt.calendarName}\nStart: ${evt.start}\nEnd: ${evt.end}${evt.location ? `\nLocation: ${evt.location}` : ""}${evt.description ? `\nDescription: ${evt.description}` : ""}`;

      await c.env.DB.prepare(
        `INSERT OR IGNORE INTO pending_emails
           (id, user_id, message_id, thread_id, subject, from_addr, email_date, snippet, body_text, source_type)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 'calendar')`
      ).bind(
        crypto.randomUUID(), userId,
        evt.id, evtSummary, evt.calendarName, evt.start, evt.summary, evtBody
      ).run();
      calendarCollected++;
    }
  } catch (err) {
    console.error("Collect calendar failed:", err);
  }

  // --- Pending file captures ---
  try {
    const { results: pendingFiles } = await c.env.DB.prepare(
      `SELECT f.id, f.kind, f.r2_key FROM ingested_files f
       WHERE f.user_id = ? AND f.status = 'done'
       AND f.id NOT IN (SELECT source_ref FROM triage_items WHERE user_id = ? AND source_ref IS NOT NULL)
       AND f.id NOT IN (SELECT message_id FROM pending_emails WHERE user_id = ? AND source_type = 'capture')`
    ).bind(userId, userId, userId).all<{ id: string; kind: string; r2_key: string }>();

    for (const file of pendingFiles) {
      await c.env.DB.prepare(
        `INSERT OR IGNORE INTO pending_emails
           (id, user_id, message_id, thread_id, subject, from_addr, email_date, snippet, body_text, source_type)
         VALUES (?, ?, ?, NULL, ?, ?, datetime('now'), ?, NULL, 'capture')`
      ).bind(
        crypto.randomUUID(), userId,
        file.id, `${file.kind} capture`, file.kind, `File: ${file.r2_key}`
      ).run();
      capturesCollected++;
    }
  } catch (err) {
    console.error("Collect captures failed:", err);
  }

  const total = await collectedCount(userId, c.env);

  return c.json({
    collected: emailsCollected + calendarCollected + capturesCollected,
    emails: emailsCollected,
    calendar: calendarCollected,
    captures: capturesCollected,
    total,
    items: await collectedPreview(userId, c.env),
  });
});

// Step 2 — manual classification of up to batch_size collected items.
control.post("/classify-next", async (c) => {
  const userId = c.get("userId");
  const settings = await getUserSettings(userId, c.env);

  const body = await c.req.json().catch(() => ({}));
  const override = z.number().int().min(1).max(20).safeParse(body?.batch_size);
  const batchSize = override.success ? override.data : settings.controlledBatchSize;

  const { results: rows } = await c.env.DB.prepare(
    `SELECT id, message_id, thread_id, subject, from_addr, email_date, snippet, body_text, source_type, collected_at
     FROM pending_emails WHERE user_id = ?
     ORDER BY collected_at ASC LIMIT ?`
  )
    .bind(userId, batchSize)
    .all<PendingRow>();

  const classified: Array<{
    subject: string;
    from: string;
    source_type: string;
    importance: number;
    urgency: number;
    category: string;
    summary: string;
    suggested_action: string;
    triage_item_id: string;
  }> = [];

  for (const row of rows) {
    const sourceType = row.source_type || "email";

    if (sourceType === "email") {
      const { itemId, result } = await classifyAndStoreEmail(
        userId,
        {
          kind: "email",
          messageId: row.message_id,
          threadId: row.thread_id || "",
          subject: row.subject || "",
          from: row.from_addr || "",
          date: row.email_date || "",
          bodyText: row.body_text || "",
        },
        c.env
      );

      classified.push({
        subject: row.subject || "(no subject)",
        from: row.from_addr || "",
        source_type: "email",
        importance: result.importance,
        urgency: result.urgency,
        category: result.category,
        summary: result.summary,
        suggested_action: result.suggested_action,
        triage_item_id: itemId,
      });
    } else if (sourceType === "calendar") {
      try {
        const { itemId, result } = await classifyAndStore(userId, {
          kind: "calendar",
          eventId: row.message_id,
          calendarId: row.from_addr || "primary",
          calendarName: row.from_addr || "primary",
          summary: row.subject || "Calendar event",
          start: row.email_date || "",
          end: "",
          description: row.body_text || undefined,
        }, c.env);

        classified.push({
          subject: row.subject || "",
          from: row.from_addr || "",
          source_type: "calendar",
          importance: result.importance,
          urgency: result.urgency,
          category: result.category,
          summary: result.summary,
          suggested_action: result.suggested_action,
          triage_item_id: itemId,
        });
      } catch (err) {
        console.error(`Calendar classify failed for ${row.message_id}:`, err);
      }
    } else if (sourceType === "capture") {
      // Re-queue file classification via the queue
      const file = await c.env.DB.prepare(
        "SELECT id, kind, r2_key FROM ingested_files WHERE id = ?"
      ).bind(row.message_id).first<{ id: string; kind: string; r2_key: string }>();

      if (file) {
        await c.env.TASKS.send({
          type: "triage.classify.file" as const,
          userId,
          fileId: file.id,
          kind: file.kind as "image" | "pdf" | "audio",
          r2Key: file.r2_key,
        });
        classified.push({ subject: `${file.kind} capture`, from: "", source_type: "capture", importance: 3, urgency: 3, category: "other", summary: "Processing...", suggested_action: "Will appear in triage when done", triage_item_id: "" });
      }
    }

    // Remove from pending
    await c.env.DB.prepare("DELETE FROM pending_emails WHERE id = ?").bind(row.id).run();
  }

  return c.json({
    classified,
    remaining: await collectedCount(userId, c.env),
  });
});

export { control };
