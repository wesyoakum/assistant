import { Hono } from "hono";
import { z } from "zod/v4";
import type { Env } from "../index";
import type { AuthVariables } from "../middleware/auth";
import { authMiddleware } from "../middleware/auth";
import { getValidAccessToken, fetchNewMessages } from "../services/gmail";
import { classifyAndStoreEmail } from "../services/classify";
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
    `SELECT subject, from_addr, snippet, collected_at
     FROM pending_emails WHERE user_id = ?
     ORDER BY collected_at ASC LIMIT 50`
  )
    .bind(userId)
    .all<{ subject: string | null; from_addr: string | null; snippet: string | null; collected_at: string }>();
  return results.map((r) => ({
    subject: r.subject || "(no subject)",
    from: r.from_addr || "",
    snippet: r.snippet || "",
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

// Step 1 — manual context collection: raw Gmail pull, NO Claude calls.
control.post("/collect", async (c) => {
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

  let collected = 0;
  for (const msg of messages) {
    // Skip if already classified or already collected
    const existing = await c.env.DB.prepare(
      "SELECT id FROM triage_items WHERE user_id = ? AND source_ref = ?"
    )
      .bind(userId, msg.messageId)
      .first();
    if (existing) continue;

    const result = await c.env.DB.prepare(
      `INSERT OR IGNORE INTO pending_emails
         (id, user_id, message_id, thread_id, subject, from_addr, email_date, snippet, body_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    if (result.meta.changes) collected++;
  }

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

  return c.json({
    collected,
    total: await collectedCount(userId, c.env),
    items: await collectedPreview(userId, c.env),
  });
});

// Step 2 — manual classification of up to batch_size collected emails.
control.post("/classify-next", async (c) => {
  const userId = c.get("userId");
  const settings = await getUserSettings(userId, c.env);

  // Allow an explicit override per-call, else fall back to the saved batch size.
  const body = await c.req.json().catch(() => ({}));
  const override = z.number().int().min(1).max(20).safeParse(body?.batch_size);
  const batchSize = override.success ? override.data : settings.controlledBatchSize;

  const { results: rows } = await c.env.DB.prepare(
    `SELECT id, message_id, thread_id, subject, from_addr, email_date, snippet, body_text, collected_at
     FROM pending_emails WHERE user_id = ?
     ORDER BY collected_at ASC LIMIT ?`
  )
    .bind(userId, batchSize)
    .all<PendingRow>();

  const classified: Array<{
    subject: string;
    from: string;
    priority: number;
    urgency: number;
    category: string;
    summary: string;
    suggested_action: string;
    triage_item_id: string;
  }> = [];

  for (const row of rows) {
    const { itemId, result } = await classifyAndStoreEmail(
      userId,
      {
        messageId: row.message_id,
        threadId: row.thread_id || "",
        subject: row.subject || "",
        from: row.from_addr || "",
        date: row.email_date || "",
        bodyText: row.body_text || "",
      },
      c.env
    );

    await c.env.DB.prepare("DELETE FROM pending_emails WHERE id = ?")
      .bind(row.id)
      .run();

    classified.push({
      subject: row.subject || "(no subject)",
      from: row.from_addr || "",
      priority: result.priority,
      urgency: result.urgency,
      category: result.category,
      summary: result.summary,
      suggested_action: result.suggested_action,
      triage_item_id: itemId,
    });
  }

  return c.json({
    classified,
    remaining: await collectedCount(userId, c.env),
  });
});

export { control };
