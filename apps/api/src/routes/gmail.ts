import { Hono } from "hono";
import type { Env } from "../index";
import type { AuthVariables } from "../middleware/auth";
import { authMiddleware } from "../middleware/auth";
import { getValidAccessToken, fetchNewMessages } from "../services/gmail";

type GmailApp = Hono<{ Bindings: Env; Variables: AuthVariables }>;

const gmail: GmailApp = new Hono();

gmail.use("*", authMiddleware);

// Sync Gmail — stores raw emails in pending_emails (no classification)
gmail.post("/sync", async (c) => {
  const userId = c.get("userId");
  const accessToken = await getValidAccessToken(userId, c.env);

  const syncState = await c.env.DB.prepare(
    "SELECT history_id FROM gmail_sync_state WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ history_id: string | null }>();

  const { messages, newHistoryId } = await fetchNewMessages(
    accessToken,
    syncState?.history_id
  );

  let stored = 0;
  for (const msg of messages) {
    // Skip if already stored
    const existing = await c.env.DB.prepare(
      "SELECT id FROM pending_emails WHERE user_id = ? AND message_id = ?"
    )
      .bind(userId, msg.messageId)
      .first();
    if (existing) continue;

    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO pending_emails
         (id, user_id, message_id, thread_id, subject, from_addr, email_date, snippet, body_text, source_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'email')`
    ).bind(
      crypto.randomUUID(), userId,
      msg.messageId, msg.threadId, msg.subject, msg.from, msg.date, msg.snippet, msg.bodyText
    ).run();
    stored++;
  }

  // Update sync state
  if (syncState) {
    await c.env.DB.prepare(
      "UPDATE gmail_sync_state SET history_id = ?, last_synced_at = datetime('now') WHERE user_id = ?"
    )
      .bind(newHistoryId, userId)
      .run();
  } else {
    await c.env.DB.prepare(
      "INSERT INTO gmail_sync_state (id, user_id, history_id, last_synced_at) VALUES (?, ?, ?, datetime('now'))"
    )
      .bind(crypto.randomUUID(), userId, newHistoryId)
      .run();
  }

  return c.json({ synced: messages.length, stored });
});

// List raw emails
gmail.get("/emails", async (c) => {
  const userId = c.get("userId");
  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 200);
  const offset = parseInt(c.req.query("offset") || "0");

  const { results } = await c.env.DB.prepare(
    `SELECT id, message_id, subject, from_addr, email_date, snippet, body_text, collected_at
     FROM pending_emails
     WHERE user_id = ? AND source_type = 'email'
     ORDER BY email_date DESC
     LIMIT ? OFFSET ?`
  )
    .bind(userId, limit, offset)
    .all();

  return c.json({ emails: results });
});

// Clear all stored emails and reset sync state
gmail.delete("/emails", async (c) => {
  const userId = c.get("userId");
  await c.env.DB.prepare("DELETE FROM pending_emails WHERE user_id = ? AND source_type = 'email'")
    .bind(userId)
    .run();
  await c.env.DB.prepare("DELETE FROM gmail_sync_state WHERE user_id = ?")
    .bind(userId)
    .run();
  return c.json({ ok: true });
});

export { gmail };
