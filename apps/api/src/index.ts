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
import { usage } from "./routes/usage";
import { syncIcalFeed } from "./services/ical";
import { authMiddleware, type AuthVariables } from "./middleware/auth";
import { getValidAccessToken, fetchNewMessages, TokenExpiredError } from "./services/gmail";
import { classifyAndStoreEmail, classifyAndStore } from "./services/classify";
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
app.route("/usage", usage);

// Fresh start: clear triage + chat + summaries, re-evaluate from source data.
// Keeps user_context, feedback, auth, push tokens.
app.post("/triage/fresh-start", authMiddleware, async (c) => {
  const userId = c.get("userId");

  // Collect source data from ALL triage items that have source_json
  const { results: emailItems } = await c.env.DB.prepare(
    `SELECT source_ref, source_json FROM triage_items
     WHERE user_id = ? AND source_type = 'email' AND source_json IS NOT NULL`
  ).bind(userId).all<{ source_ref: string; source_json: string }>();

  const { results: fileItems } = await c.env.DB.prepare(
    `SELECT DISTINCT source_ref FROM triage_items
     WHERE user_id = ? AND source_type IN ('image', 'document', 'voice') AND source_ref IS NOT NULL`
  ).bind(userId).all<{ source_ref: string }>();

  // Clear tables that reference triage_items first (FK constraints)
  await c.env.DB.prepare("DELETE FROM feedback WHERE user_id = ?").bind(userId).run();
  await c.env.DB.prepare("DELETE FROM notification_log WHERE user_id = ?").bind(userId).run();
  await c.env.DB.prepare("DELETE FROM calendar_suggestions WHERE user_id = ?").bind(userId).run();
  await c.env.DB.prepare("DELETE FROM pending_emails WHERE user_id = ?").bind(userId).run();
  await c.env.DB.prepare("DELETE FROM calendar_sync_state WHERE user_id = ?").bind(userId).run();

  // Delete all triage items
  const deleted = await c.env.DB.prepare(
    "DELETE FROM triage_items WHERE user_id = ?"
  ).bind(userId).run();

  // Clear chat messages and summaries
  await c.env.DB.prepare("DELETE FROM chat_messages WHERE user_id = ?").bind(userId).run();
  await c.env.DB.prepare("DELETE FROM chat_summaries WHERE user_id = ?").bind(userId).run();

  // Clear reminders
  await c.env.DB.prepare("DELETE FROM reminders WHERE user_id = ?").bind(userId).run();

  // Reset gmail sync state
  await c.env.DB.prepare(
    "UPDATE gmail_sync_state SET history_id = NULL, last_synced_at = NULL WHERE user_id = ?"
  ).bind(userId).run();

  // Check if user is in controlled mode — if so, don't auto re-queue
  const controlled = await isControlled(userId, c.env);

  let emailsQueued = 0;
  let filesQueued = 0;

  if (!controlled) {
    // Re-queue unique emails
    const seenRefs = new Set<string>();
    for (const item of emailItems) {
      if (seenRefs.has(item.source_ref)) continue;
      seenRefs.add(item.source_ref);
      try {
        const email = JSON.parse(item.source_json);
        if (email.messageId) {
          await c.env.TASKS.send({
            type: "triage.classify", userId,
            email: { messageId: email.messageId, threadId: email.threadId || "", subject: email.subject || "", from: email.from || "", date: email.date || "", bodyText: email.bodyText || "" },
          } as QueueMessage);
          emailsQueued++;
        }
      } catch { /* skip */ }
    }

    // Re-queue files
    for (const item of fileItems) {
      const file = await c.env.DB.prepare(
        "SELECT id, kind, r2_key FROM ingested_files WHERE id = ?"
      ).bind(item.source_ref).first<{ id: string; kind: string; r2_key: string }>();
      if (file) {
        await c.env.TASKS.send({
          type: "triage.classify.file", userId,
          fileId: file.id, kind: file.kind as "image" | "pdf" | "audio", r2Key: file.r2_key,
        } as QueueMessage);
        filesQueued++;
      }
    }
  }

  return c.json({
    deleted: deleted.meta.changes, emailsQueued, filesQueued,
    controlled,
    note: controlled
      ? "Everything cleared. You're in controlled mode — use Collect and Classify to rebuild your triage."
      : "Triage, chat, summaries, reminders, and suggestions cleared. User context and preferences preserved. Re-evaluating emails and files.",
  });
});

// Re-classify: dismiss all open items and re-queue through new classifier
app.post("/triage/reclassify-all", authMiddleware, async (c) => {
  const userId = c.get("userId");
  const controlled = await isControlled(userId, c.env);

  if (controlled) {
    // In controlled mode, just dismiss — user will manually collect/classify
    const dismissed = await c.env.DB.prepare(
      `UPDATE triage_items SET status = 'dismissed', updated_at = datetime('now') WHERE user_id = ? AND status = 'open'`
    ).bind(userId).run();
    return c.json({
      dismissed: dismissed.meta.changes, emailsQueued: 0, filesQueued: 0, calendarSkipped: 0,
      note: "Items dismissed. You're in controlled mode — use Collect and Classify to re-evaluate.",
    });
  }

  const { results: openItems } = await c.env.DB.prepare(
    `SELECT id, source_type, source_ref, source_json FROM triage_items WHERE user_id = ? AND status = 'open'`
  ).bind(userId).all<{ id: string; source_type: string; source_ref: string | null; source_json: string | null }>();

  const dismissed = await c.env.DB.prepare(
    `UPDATE triage_items SET status = 'dismissed', updated_at = datetime('now') WHERE user_id = ? AND status = 'open'`
  ).bind(userId).run();

  let emailsQueued = 0;
  let filesQueued = 0;
  let calendarSkipped = 0;

  for (const item of openItems) {
    if (item.source_type === "email" && item.source_json) {
      try {
        const email = JSON.parse(item.source_json);
        if (email.messageId) {
          await c.env.TASKS.send({
            type: "triage.classify", userId,
            email: { messageId: email.messageId, threadId: email.threadId || "", subject: email.subject || "", from: email.from || "", date: email.date || "", bodyText: email.bodyText || "" },
          } as QueueMessage);
          emailsQueued++;
        }
      } catch { /* skip */ }
    } else if ((item.source_type === "image" || item.source_type === "document" || item.source_type === "voice") && item.source_ref) {
      const file = await c.env.DB.prepare(
        "SELECT id, kind, r2_key FROM ingested_files WHERE id = ?"
      ).bind(item.source_ref).first<{ id: string; kind: string; r2_key: string }>();
      if (file) {
        await c.env.TASKS.send({
          type: "triage.classify.file", userId,
          fileId: file.id, kind: file.kind as "image" | "pdf" | "audio", r2Key: file.r2_key,
        } as QueueMessage);
        filesQueued++;
      }
    } else if (item.source_type === "calendar" || item.source_type === "event") {
      calendarSkipped++;
    }
  }

  return c.json({
    dismissed: dismissed.meta.changes, emailsQueued, filesQueued, calendarSkipped,
    note: "Calendar/event items will be re-created by the next cron cycle. Chat-created items were dismissed but not re-queued.",
  });
});

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
       AND (quadrant = 'noop' OR (quadrant IS NULL AND priority <= 2 AND urgency <= 2))
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

    // --- Auto-archive stale Noop items (14+ days) — Plan and Monitor are long-lived by design ---
    const archived = await env.DB.prepare(
      `UPDATE triage_items SET status = 'dismissed', updated_at = datetime('now')
       WHERE status = 'open'
       AND (quadrant = 'noop' OR (quadrant IS NULL AND priority <= 2 AND urgency <= 2))
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
             SUM(CASE WHEN quadrant = 'hot' THEN 1 WHEN quadrant IS NULL AND priority >= 4 AND urgency >= 4 THEN 1 ELSE 0 END) as hot,
             SUM(CASE WHEN quadrant = 'action' THEN 1 WHEN quadrant IS NULL AND priority < 4 AND urgency >= 4 THEN 1 ELSE 0 END) as action_count,
             SUM(CASE WHEN quadrant = 'plan' THEN 1 WHEN quadrant IS NULL AND priority >= 4 AND urgency < 4 THEN 1 ELSE 0 END) as plan_count,
             SUM(CASE WHEN quadrant = 'monitor' THEN 1 ELSE 0 END) as monitor_count,
             COUNT(*) as total
           FROM triage_items
           WHERE user_id = ? AND status = 'open'`
        ).bind(user.id).first<{
          hot: number; action_count: number; plan_count: number; monitor_count: number; total: number;
        }>();

        const todayEvents = await env.DB.prepare(
          `SELECT COUNT(*) as cnt FROM triage_items
           WHERE user_id = ? AND source_type IN ('calendar', 'event')
           AND status = 'open'
           AND event_at IS NOT NULL
           AND date(event_at) = date('now')`
        ).bind(user.id).first<{ cnt: number }>();

        // Monitor items due for re-check
        const { results: dueMonitors } = await env.DB.prepare(
          `SELECT id, summary FROM triage_items
           WHERE user_id = ? AND status = 'open' AND quadrant = 'monitor'
           AND next_check_at IS NOT NULL AND datetime(next_check_at) <= datetime('now')
           LIMIT 5`
        ).bind(user.id).all<{ id: string; summary: string }>();

        const hot = counts?.hot ?? 0;
        const evtCount = todayEvents?.cnt ?? 0;
        const total = counts?.total ?? 0;
        const overdueCount = overdueItems.length;

        const parts: string[] = [];
        if (hot > 0) parts.push(`${hot} Hot`);
        if ((counts?.action_count ?? 0) > 0) parts.push(`${counts!.action_count} Action`);
        if ((counts?.plan_count ?? 0) > 0) parts.push(`${counts!.plan_count} Plan`);
        if ((counts?.monitor_count ?? 0) > 0) parts.push(`${counts!.monitor_count} Monitor`);
        if (evtCount > 0) parts.push(`${evtCount} event${evtCount > 1 ? "s" : ""} today`);
        if (overdueCount > 0) parts.push(`${overdueCount} overdue`);
        if (dueMonitors.length > 0) parts.push(`${dueMonitors.length} monitor check-in${dueMonitors.length > 1 ? "s" : ""} due`);

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
    // All queue processing paused — drain messages silently
    for (const msg of batch.messages) {
      msg.ack();
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
  await classifyAndStoreEmail(userId, { kind: "email", ...email }, env);
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
    await classifyAndStore(userId, { kind: "file", fileId, fileKind: kind, r2Key }, env);
  } catch (err) {
    console.error(`File classify failed for ${fileId}:`, err);
    await env.DB.prepare(
      "UPDATE ingested_files SET status = 'error' WHERE id = ?"
    ).bind(fileId).run();
  }
}
