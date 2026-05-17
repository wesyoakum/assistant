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
import { control } from "./routes/control";
import { classifyFile } from "./services/claude";
import { syncIcalFeed } from "./services/ical";
import { authMiddleware, type AuthVariables } from "./middleware/auth";
import { getValidAccessToken, fetchNewMessages, TokenExpiredError } from "./services/gmail";
import { classifyAndStoreEmail } from "./services/classify";
import { isControlled } from "./services/settings";
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
app.route("/control", control);

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
      // Controlled-mode users are skipped: in controlled mode all polling
      // and classification is manual (see /control/collect).
      const { results: users } = await env.DB.prepare(
        `SELECT id FROM users
         WHERE id NOT IN (
           SELECT user_id FROM user_settings WHERE mode = 'controlled'
         )`
      ).all<{ id: string }>();

      for (const user of users) {
        const msg: QueueMessage = { type: "gmail.poll", userId: user.id };
        await env.TASKS.send(msg);
      }

      console.log(`Cron: enqueued gmail.poll for ${users.length} users`);
    }

    // Poll iCal feeds
    {
      const { results: feeds } = await env.DB.prepare(
        "SELECT id FROM ical_feeds WHERE enabled = 1"
      ).all<{ id: string }>();
      for (const feed of feeds) {
        try {
          await syncIcalFeed(feed.id, env);
        } catch (err) {
          console.error(`iCal sync failed for feed ${feed.id}:`, err);
        }
      }
      if (feeds.length > 0) {
        console.log(`Cron: synced ${feeds.length} iCal feeds`);
      }
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
        await env.DB.prepare(
          "INSERT INTO notification_log (id, user_id, title, body, category) VALUES (?, ?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), rem.user_id, "Reminder", rem.message, "reminder").run();
      }

      // Mark as fired
      await env.DB.prepare(
        "UPDATE reminders SET status = 'fired' WHERE id = ?"
      ).bind(rem.id).run();
    }

    if (dueReminders.length > 0) {
      console.log(`Cron: fired ${dueReminders.length} reminders`);
    }

    // --- Overdue urgency bump (non-calendar items past due_at or event_at) ---
    const bumped = await env.DB.prepare(
      `UPDATE triage_items SET urgency = 5, updated_at = datetime('now')
       WHERE status = 'open' AND urgency < 5
       AND (
         (due_at IS NOT NULL AND datetime(due_at) < datetime('now'))
         OR (event_at IS NOT NULL AND datetime(event_at) < datetime('now')
             AND source_type NOT IN ('calendar', 'event'))
       )`
    ).run();
    if (bumped.meta.changes) {
      console.log(`Cron: urgency-bumped ${bumped.meta.changes} overdue items`);
    }

    // --- Auto-archive stale low-priority items (14+ days, P<=2, U<=2) ---
    const archived = await env.DB.prepare(
      `UPDATE triage_items SET status = 'dismissed', updated_at = datetime('now')
       WHERE status = 'open' AND priority <= 2 AND urgency <= 2
       AND created_at < datetime('now', '-14 days')`
    ).run();
    if (archived.meta.changes) {
      console.log(`Cron: auto-archived ${archived.meta.changes} stale items`);
    }

    // --- Event heads-up (30 min before) ---
    {
      const { results: upcoming } = await env.DB.prepare(
        `SELECT id, user_id, summary, event_at FROM triage_items
         WHERE source_type IN ('calendar', 'event')
         AND status = 'open'
         AND event_at IS NOT NULL
         AND datetime(event_at) > datetime('now')
         AND datetime(event_at) <= datetime('now', '+31 minutes')`
      ).all<{ id: string; user_id: string; summary: string; event_at: string }>();

      for (const item of upcoming) {
        // Deduplicate: skip if already notified for this item recently
        const already = await env.DB.prepare(
          `SELECT id FROM notification_log
           WHERE triage_item_id = ? AND category = 'event-headsup'
           AND created_at > datetime('now', '-1 hour')`
        ).bind(item.id).first();
        if (already) continue;

        const { results: tokens } = await env.DB.prepare(
          "SELECT expo_token FROM push_tokens WHERE user_id = ?"
        ).bind(item.user_id).all<{ expo_token: string }>();

        if (tokens.length > 0) {
          const eventTime = new Date(item.event_at).toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
            timeZone: "America/Chicago",
          });
          const body = `${item.summary} at ${eventTime}`;
          const messages = tokens.map((t) => ({
            to: t.expo_token,
            title: "Coming up soon",
            body,
            sound: "default" as const,
            categoryId: "event-headsup",
            priority: "high" as const,
            _contentAvailable: true,
            data: { url: `whyapp://triage/${item.id}` },
          }));
          await sendExpoPush(env, messages);
          await env.DB.prepare(
            "INSERT INTO notification_log (id, user_id, title, body, category, triage_item_id) VALUES (?, ?, ?, ?, ?, ?)"
          ).bind(crypto.randomUUID(), item.user_id, "Coming up soon", body, "event-headsup", item.id).run();
        }
      }

      if (upcoming.length > 0) {
        console.log(`Cron: checked ${upcoming.length} upcoming events for heads-up`);
      }
    }

    // --- Daily notifications (overdue + morning briefing) at 13:00 UTC / ~7-8 AM CDT ---
    const now = new Date();
    if (now.getUTCHours() === 13 && now.getUTCMinutes() === 0) {
      const { results: allUsers } = await env.DB.prepare(
        "SELECT id FROM users"
      ).all<{ id: string }>();

      for (const user of allUsers) {
        const { results: userTokens } = await env.DB.prepare(
          "SELECT expo_token FROM push_tokens WHERE user_id = ?"
        ).bind(user.id).all<{ expo_token: string }>();
        if (userTokens.length === 0) continue;

        // --- Overdue notification ---
        const { results: overdueItems } = await env.DB.prepare(
          `SELECT summary FROM triage_items
           WHERE user_id = ? AND status = 'open' AND priority >= 3
           AND (
             (due_at IS NOT NULL AND datetime(due_at) < datetime('now'))
             OR (event_at IS NOT NULL AND datetime(event_at) < datetime('now')
                 AND source_type NOT IN ('calendar', 'event'))
           )
           ORDER BY priority DESC, urgency DESC
           LIMIT 5`
        ).bind(user.id).all<{ summary: string }>();

        if (overdueItems.length > 0) {
          const listing = overdueItems.map((r) => `• ${r.summary}`).join("\n");
          const overdueBody = `${overdueItems.length} overdue item${overdueItems.length > 1 ? "s" : ""}:\n${listing}`;
          const msgs = userTokens.map((t) => ({
            to: t.expo_token,
            title: "Overdue Items",
            body: overdueBody,
            sound: "default" as const,
            categoryId: "triage",
            priority: "high" as const,
            _contentAvailable: true,
          }));
          await sendExpoPush(env, msgs);
          await env.DB.prepare(
            "INSERT INTO notification_log (id, user_id, title, body, category) VALUES (?, ?, ?, ?, ?)"
          ).bind(crypto.randomUUID(), user.id, "Overdue Items", overdueBody, "triage").run();
        }

        // --- Morning briefing ---
        const counts = await env.DB.prepare(
          `SELECT
             SUM(CASE WHEN priority >= 4 AND urgency >= 4 THEN 1 ELSE 0 END) as hot,
             SUM(CASE WHEN priority >= 4 AND urgency < 4 THEN 1 ELSE 0 END) as important,
             SUM(CASE WHEN priority < 4 AND urgency >= 4 THEN 1 ELSE 0 END) as urgent,
             SUM(CASE WHEN priority < 4 AND urgency < 4 THEN 1 ELSE 0 END) as low,
             COUNT(*) as total
           FROM triage_items
           WHERE user_id = ? AND status = 'open'`
        ).bind(user.id).first<{
          hot: number; important: number; urgent: number; low: number; total: number;
        }>();

        const todayEvents = await env.DB.prepare(
          `SELECT COUNT(*) as cnt FROM triage_items
           WHERE user_id = ? AND source_type IN ('calendar', 'event')
           AND status = 'open'
           AND event_at IS NOT NULL
           AND date(event_at) = date('now')`
        ).bind(user.id).first<{ cnt: number }>();

        const hot = counts?.hot ?? 0;
        const evtCount = todayEvents?.cnt ?? 0;
        const total = counts?.total ?? 0;
        const overdueCount = overdueItems.length;

        const parts: string[] = [];
        if (hot > 0) parts.push(`${hot} Hot item${hot > 1 ? "s" : ""}`);
        if ((counts?.important ?? 0) > 0) parts.push(`${counts!.important} important`);
        if ((counts?.urgent ?? 0) > 0) parts.push(`${counts!.urgent} urgent`);
        if (evtCount > 0) parts.push(`${evtCount} event${evtCount > 1 ? "s" : ""} today`);
        if (overdueCount > 0) parts.push(`${overdueCount} overdue`);

        const briefBody = parts.length > 0
          ? `Good morning! ${parts.join(", ")}. ${total} open total.`
          : `Good morning! All clear — ${total} open items.`;

        const briefMsgs = userTokens.map((t) => ({
          to: t.expo_token,
          title: "Morning Briefing",
          body: briefBody,
          sound: "default" as const,
          categoryId: "briefing",
          priority: "default" as const,
          _contentAvailable: true,
        }));
        await sendExpoPush(env, briefMsgs);
        await env.DB.prepare(
          "INSERT INTO notification_log (id, user_id, title, body, category) VALUES (?, ?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), user.id, "Morning Briefing", briefBody, "briefing").run();
      }

      console.log("Cron: sent daily overdue + morning briefing notifications");
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
  // Defense in depth: controlled-mode users poll manually via /control/collect.
  if (await isControlled(userId, env)) {
    console.log(`User ${userId}: controlled mode, skipping gmail.poll`);
    return;
  }

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
  await classifyAndStoreEmail(userId, email, env);
}

async function handlePushSend(
  userId: string,
  triageItemId: string,
  summary: string,
  env: Env
) {
  // Controlled mode deactivates high-priority push notifications.
  if (await isControlled(userId, env)) {
    console.log(`User ${userId}: controlled mode, suppressing high-priority push`);
    return;
  }

  const { results: tokens } = await env.DB.prepare(
    "SELECT expo_token FROM push_tokens WHERE user_id = ?"
  )
    .bind(userId)
    .all<{ expo_token: string }>();

  if (tokens.length === 0) return;

  // Look up source info for deep actions (Open Original, Reply)
  const item = await env.DB.prepare(
    "SELECT source_type, source_ref, source_url FROM triage_items WHERE id = ?"
  ).bind(triageItemId).first<{ source_type: string; source_ref: string | null; source_url: string | null }>();

  let sourceUrl: string | null = null;
  let sourceType: string | null = null;
  if (item) {
    sourceType = item.source_type;
    sourceUrl = item.source_url || null;
    if (!sourceUrl && item.source_type === "email" && item.source_ref) {
      sourceUrl = `https://mail.google.com/mail/u/0/#inbox/${item.source_ref}`;
    } else if (!sourceUrl && (item.source_type === "event" || item.source_type === "calendar") && item.source_ref) {
      sourceUrl = `https://calendar.google.com/calendar/event?eid=${item.source_ref}`;
    }
  }

  // Use email-specific category for emails (has Reply button)
  const categoryId = sourceType === "email" ? "triage-email" : "triage";

  const messages = tokens.map((t) => ({
    to: t.expo_token,
    title: "High Priority Item",
    body: summary,
    sound: "default" as const,
    categoryId,
    priority: "high" as const,
    _contentAvailable: true,
    data: {
      url: `whyapp://triage/${triageItemId}`,
      sourceUrl: sourceUrl || undefined,
      sourceType: sourceType || undefined,
    },
  }));
  await sendExpoPush(env, messages);
  await env.DB.prepare(
    "INSERT INTO notification_log (id, user_id, title, body, category, triage_item_id) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(crypto.randomUUID(), userId, "High Priority Item", summary, categoryId, triageItemId).run();

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
