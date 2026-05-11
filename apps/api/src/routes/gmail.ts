import { Hono } from "hono";
import type { Env } from "../index";
import type { AuthVariables } from "../middleware/auth";
import { authMiddleware } from "../middleware/auth";
import { getValidAccessToken, fetchNewMessages, getGmailProfile } from "../services/gmail";
import type { QueueMessage } from "@assistant/shared";

type GmailApp = Hono<{ Bindings: Env; Variables: AuthVariables }>;

const gmail: GmailApp = new Hono();

gmail.use("*", authMiddleware);

// Manual sync trigger
gmail.post("/sync", async (c) => {
  const userId = c.get("userId");

  const accessToken = await getValidAccessToken(userId, c.env);

  // Get current sync state
  const syncState = await c.env.DB.prepare(
    "SELECT history_id FROM gmail_sync_state WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ history_id: string | null }>();

  const { messages, newHistoryId } = await fetchNewMessages(
    accessToken,
    syncState?.history_id
  );

  // Enqueue classification for each new message
  let enqueued = 0;
  for (const msg of messages) {
    // Skip if we already have this message
    const existing = await c.env.DB.prepare(
      "SELECT id FROM triage_items WHERE user_id = ? AND source_ref = ?"
    )
      .bind(userId, msg.messageId)
      .first();

    if (existing) continue;

    const queueMsg: QueueMessage = {
      type: "triage.classify",
      userId,
      email: {
        messageId: msg.messageId,
        threadId: msg.threadId,
        subject: msg.subject,
        from: msg.from,
        date: msg.date,
        bodyText: msg.bodyText,
      },
    };

    await c.env.TASKS.send(queueMsg);
    enqueued++;
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

  return c.json({ synced: messages.length, enqueued });
});

export { gmail };
