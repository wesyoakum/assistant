import { Hono } from "hono";
import type { Env } from "../index";
import type { AuthVariables } from "../middleware/auth";
import { authMiddleware } from "../middleware/auth";
import { getValidAccessToken, fetchNewMessages } from "../services/gmail";

type GmailApp = Hono<{ Bindings: Env; Variables: AuthVariables }>;

const gmail: GmailApp = new Hono();

/**
 * Pull new Gmail messages for a user and store them raw in `raw_emails`.
 * No classification — just collection. Returns the number of new emails stored.
 */
export async function syncGmailForUser(userId: string, env: Env): Promise<number> {
  const accessToken = await getValidAccessToken(userId, env);

  const syncState = await env.DB.prepare(
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
    const result = await env.DB.prepare(
      `INSERT INTO raw_emails
         (id, user_id, message_id, thread_id, subject, from_addr, email_date, snippet, body_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, message_id) DO NOTHING`
    )
      .bind(
        crypto.randomUUID(),
        userId,
        msg.messageId,
        msg.threadId,
        msg.subject,
        msg.from,
        msg.date,
        msg.snippet,
        msg.bodyText
      )
      .run();
    if (result.meta.changes) stored++;
  }

  if (syncState) {
    await env.DB.prepare(
      "UPDATE gmail_sync_state SET history_id = ?, last_synced_at = datetime('now') WHERE user_id = ?"
    )
      .bind(newHistoryId, userId)
      .run();
  } else {
    await env.DB.prepare(
      "INSERT INTO gmail_sync_state (id, user_id, history_id, last_synced_at) VALUES (?, ?, ?, datetime('now'))"
    )
      .bind(crypto.randomUUID(), userId, newHistoryId)
      .run();
  }

  return stored;
}

gmail.use("*", authMiddleware);

// Manual sync trigger — pulls and stores raw emails.
gmail.post("/sync", async (c) => {
  const userId = c.get("userId");
  const stored = await syncGmailForUser(userId, c.env);
  return c.json({ stored });
});

// List collected raw emails (newest first).
gmail.get("/messages", async (c) => {
  const userId = c.get("userId");
  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 100);

  const { results } = await c.env.DB.prepare(
    `SELECT id, message_id, thread_id, subject, from_addr, email_date, snippet, collected_at
     FROM raw_emails WHERE user_id = ? ORDER BY collected_at DESC LIMIT ?`
  )
    .bind(userId, limit)
    .all();

  return c.json({ messages: results });
});

// Full body for one collected email.
gmail.get("/messages/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  const row = await c.env.DB.prepare(
    `SELECT id, message_id, thread_id, subject, from_addr, email_date, snippet, body_text, collected_at
     FROM raw_emails WHERE id = ? AND user_id = ?`
  )
    .bind(id, userId)
    .first();

  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(row);
});

export { gmail };
