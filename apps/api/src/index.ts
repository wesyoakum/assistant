import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./routes/auth";
import { triage } from "./routes/triage";
import { gmail } from "./routes/gmail";
import { calendar } from "./routes/calendar";
import { chat } from "./routes/chat";
import { files } from "./routes/files";
import { context } from "./routes/context";
import { push } from "./routes/push";
import { classifyFile } from "./services/claude";
import { authMiddleware, type AuthVariables } from "./middleware/auth";
import { getValidAccessToken, fetchNewMessages, TokenExpiredError } from "./services/gmail";
import { classifyEmail } from "./services/claude";
import type { QueueMessage, FeedbackRow } from "@assistant/shared";

export type Env = {
  DB: D1Database;
  FILES: R2Bucket;
  TASKS: Queue;
  GOOGLE_CLIENT_SECRET: string;
  OAUTH_ENCRYPTION_KEY: string;
  SESSION_JWT_SECRET: string;
  ANTHROPIC_API_KEY: string;
  ENVIRONMENT: string;
  BRAVE_SEARCH_API_KEY: string;
};

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

app.use("*", cors());

app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.route("/auth", auth);
app.route("/triage", triage);
app.route("/gmail", gmail);
app.route("/calendar", calendar);
app.route("/chat", chat);
app.route("/files", files);
app.route("/context", context);
app.route("/push", push);

app.get("/me", authMiddleware, async (c) => {
  const userId = c.get("userId");
  const user = await c.env.DB.prepare(
    "SELECT id, email, name, picture_url, created_at FROM users WHERE id = ?"
  )
    .bind(userId)
    .first();

  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }
  return c.json(user);
});

export default {
  fetch: app.fetch,

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
  ) {
    // Gmail poll only on the 10-minute cron (*/10)
    // The 1-minute cron fires reminders and auto-dismiss only
    {
      const { results: users } = await env.DB.prepare(
        "SELECT id FROM users"
      ).all<{ id: string }>();

      for (const user of users) {
        const msg: QueueMessage = { type: "gmail.poll", userId: user.id };
        await env.TASKS.send(msg);
      }

      console.log(`Cron: enqueued gmail.poll for ${users.length} users`);
    }

    // Auto-dismiss past Noop calendar/event triage items
    const dismissed = await env.DB.prepare(
      `UPDATE triage_items SET status = 'dismissed', updated_at = datetime('now')
       WHERE status = 'open'
       AND source_type IN ('calendar', 'event')
       AND priority <= 2 AND urgency <= 2
       AND event_at IS NOT NULL AND datetime(event_at) < datetime('now')`
    ).run();
    if (dismissed.meta.changes) {
      console.log(`Cron: auto-dismissed ${dismissed.meta.changes} past Noop items`);
    }

    // Fire due reminders. Wrap both sides in datetime() so an ISO `fire_at`
    // (`...T...Z`) and SQLite's space-separated `datetime('now')` are compared
    // as parsed timestamps, not as raw strings.
    const { results: dueReminders } = await env.DB.prepare(
      `SELECT r.id, r.user_id, r.message
       FROM reminders r
       WHERE r.status = 'pending' AND datetime(r.fire_at) <= datetime('now')`
    ).all<{ id: string; user_id: string; message: string }>();

    for (const rem of dueReminders) {
      // Get push tokens for this user
      const { results: tokens } = await env.DB.prepare(
        "SELECT expo_token FROM push_tokens WHERE user_id = ?"
      ).bind(rem.user_id).all<{ expo_token: string }>();

      if (tokens.length > 0) {
        const messages = tokens.map((t) => ({
          to: t.expo_token,
          title: "Reminder",
          body: rem.message,
          sound: "default",
          categoryId: "reminder",
          priority: "high" as const,
          _contentAvailable: true,
        }));
        await sendExpoPush(env, messages);
      }

      // Mark as fired
      await env.DB.prepare(
        "UPDATE reminders SET status = 'fired' WHERE id = ?"
      ).bind(rem.id).run();
    }

    if (dueReminders.length > 0) {
      console.log(`Cron: fired ${dueReminders.length} reminders`);
    }
  },

  async queue(
    batch: MessageBatch<unknown>,
    env: Env,
    _ctx: ExecutionContext
  ) {
    for (const msg of batch.messages) {
      try {
        const body = msg.body as QueueMessage;

        switch (body.type) {
          case "gmail.poll":
            await handleGmailPoll(body.userId, env);
            break;
          case "triage.classify":
            await handleTriageClassify(body.userId, body.email, env);
            break;
          case "triage.classify.file":
            await handleFileClassify(body.userId, body.fileId, body.kind, body.r2Key, env);
            break;
          case "push.send":
            await handlePushSend(body.userId, body.triageItemId, body.summary, env);
            break;
          default:
            console.error("Unknown queue message type:", body);
        }

        msg.ack();
      } catch (err) {
        console.error("Queue message failed:", err);
        msg.retry();
      }
    }
  },
};

async function handleGmailPoll(userId: string, env: Env) {
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken(userId, env);
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      console.warn(`User ${userId}: token expired, skipping poll`);
      return;
    }
    throw err;
  }

  const syncState = await env.DB.prepare(
    "SELECT history_id FROM gmail_sync_state WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ history_id: string | null }>();

  const { messages, newHistoryId } = await fetchNewMessages(
    accessToken,
    syncState?.history_id
  );

  for (const email of messages) {
    // Skip duplicates
    const existing = await env.DB.prepare(
      "SELECT id FROM triage_items WHERE user_id = ? AND source_ref = ?"
    )
      .bind(userId, email.messageId)
      .first();

    if (existing) continue;

    const queueMsg: QueueMessage = {
      type: "triage.classify",
      userId,
      email: {
        messageId: email.messageId,
        threadId: email.threadId,
        subject: email.subject,
        from: email.from,
        date: email.date,
        bodyText: email.bodyText,
      },
    };
    await env.TASKS.send(queueMsg);
  }

  // Update sync state
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

  console.log(`Gmail poll for user ${userId}: ${messages.length} messages`);
}

async function handleTriageClassify(
  userId: string,
  email: { messageId: string; threadId: string; subject: string; from: string; date: string; bodyText: string },
  env: Env
) {
  // Get user's recent feedback for few-shot learning
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

  // Load user context
  const { results: contextRows } = await env.DB.prepare(
    "SELECT kind, label, detail FROM user_context WHERE user_id = ?"
  ).bind(userId).all<{ kind: string; label: string; detail: string | null }>();

  const result = await classifyEmail(email, feedbackRows, env.ANTHROPIC_API_KEY, contextRows);

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

  // Create calendar suggestion if present
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

  // If high priority, trigger push notification
  if (result.priority >= 4 || result.urgency >= 4) {
    const pushMsg: QueueMessage = {
      type: "push.send",
      userId,
      triageItemId: itemId,
      summary: result.summary,
    };
    await env.TASKS.send(pushMsg);
  }

  console.log(`Classified email ${email.messageId} for user ${userId}: P${result.priority}/U${result.urgency}`);
}

async function handlePushSend(
  userId: string,
  triageItemId: string,
  summary: string,
  env: Env
) {
  const { results: tokens } = await env.DB.prepare(
    "SELECT expo_token FROM push_tokens WHERE user_id = ?"
  )
    .bind(userId)
    .all<{ expo_token: string }>();

  if (tokens.length === 0) return;

  const messages = tokens.map((t) => ({
    to: t.expo_token,
    title: "High Priority Item",
    body: summary,
    sound: "default" as const,
    categoryId: "triage-high",
    priority: "high" as const,
    _contentAvailable: true,
    data: { url: `whyapp://triage/${triageItemId}` },
  }));
  await sendExpoPush(env, messages);

  console.log(`Push sent to ${tokens.length} devices for user ${userId}`);
}

type ExpoPushMessage = {
  to: string;
  title: string;
  body: string;
  sound?: string;
  categoryId?: string;
  priority?: "default" | "normal" | "high";
  _contentAvailable?: boolean;
  data?: Record<string, unknown>;
};

type ExpoPushTicket =
  | { status: "ok"; id: string }
  | { status: "error"; message: string; details?: { error?: string } };

async function sendExpoPush(env: Env, messages: ExpoPushMessage[]) {
  const res = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(messages),
  });

  if (!res.ok) {
    console.error(`Expo push HTTP ${res.status}: ${await res.text()}`);
    return;
  }

  const json = (await res.json()) as { data?: ExpoPushTicket[] };
  const tickets = json.data ?? [];
  const deadTokens: string[] = [];

  tickets.forEach((ticket, i) => {
    if (ticket.status === "error") {
      const errCode = ticket.details?.error;
      console.error(
        `Expo push ticket error for ${messages[i].to}: ${errCode ?? "unknown"} — ${ticket.message}`
      );
      // Token is permanently invalid (uninstalled, project-mismatch, etc.) — prune it.
      if (errCode === "DeviceNotRegistered" || errCode === "InvalidCredentials") {
        deadTokens.push(messages[i].to);
      }
    }
  });

  if (deadTokens.length > 0) {
    const placeholders = deadTokens.map(() => "?").join(",");
    await env.DB.prepare(
      `DELETE FROM push_tokens WHERE expo_token IN (${placeholders})`
    )
      .bind(...deadTokens)
      .run();
    console.log(`Pruned ${deadTokens.length} dead push tokens`);
  }
}

async function handleFileClassify(
  userId: string,
  fileId: string,
  kind: "image" | "pdf" | "audio",
  r2Key: string,
  env: Env
) {
  // Update status to processing
  await env.DB.prepare(
    "UPDATE ingested_files SET status = 'processing' WHERE id = ?"
  ).bind(fileId).run();

  try {
    // Fetch file from R2
    const obj = await env.FILES.get(r2Key);
    if (!obj) throw new Error(`File not found in R2: ${r2Key}`);

    const fileBytes = await obj.arrayBuffer();
    const contentType = obj.httpMetadata?.contentType || (
      kind === "pdf" ? "application/pdf" :
      kind === "audio" ? "audio/m4a" :
      "image/jpeg"
    );

    // Get user feedback for few-shot
    const { results: feedbackRows } = await env.DB.prepare(
      `SELECT f.kind, f.corrected_priority, f.corrected_urgency, f.note,
              t.summary, t.category, t.priority as original_priority, t.urgency as original_urgency
       FROM feedback f
       JOIN triage_items t ON t.id = f.triage_item_id
       WHERE f.user_id = ?
       ORDER BY f.created_at DESC
       LIMIT 10`
    ).bind(userId).all<FeedbackRow>();

    const { results: ctxRows } = await env.DB.prepare(
      "SELECT kind, label, detail FROM user_context WHERE user_id = ?"
    ).bind(userId).all<{ kind: string; label: string; detail: string | null }>();

    const result = await classifyFile(kind, fileBytes, contentType, feedbackRows, env.ANTHROPIC_API_KEY, ctxRows);

    const sourceType = kind === "audio" ? "voice" : kind === "pdf" ? "document" : "image";
    const itemId = crypto.randomUUID();

    await env.DB.prepare(
      `INSERT INTO triage_items (id, user_id, source_type, source_ref, priority, urgency, category, summary, suggested_action, classifier_json, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`
    ).bind(
      itemId, userId, sourceType, fileId,
      result.priority, result.urgency, result.category,
      result.summary, result.suggested_action, JSON.stringify(result)
    ).run();

    // Update file status
    await env.DB.prepare(
      "UPDATE ingested_files SET status = 'done' WHERE id = ?"
    ).bind(fileId).run();

    // Push if high priority
    if (result.priority >= 4 || result.urgency >= 4) {
      const pushMsg: QueueMessage = { type: "push.send", userId, triageItemId: itemId, summary: result.summary };
      await env.TASKS.send(pushMsg);
    }

    console.log(`Classified ${kind} file ${fileId} for user ${userId}: P${result.priority}/U${result.urgency}`);
  } catch (err) {
    console.error(`File classify failed for ${fileId}:`, err);
    await env.DB.prepare(
      "UPDATE ingested_files SET status = 'error' WHERE id = ?"
    ).bind(fileId).run();
  }
}
