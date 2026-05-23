import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./routes/auth";
import { gmail } from "./routes/gmail";
import { calendar } from "./routes/calendar";
import { chat } from "./routes/chat";
import { files } from "./routes/files";
import { context } from "./routes/context";
import { push } from "./routes/push";
import { usage } from "./routes/usage";
import { groupme } from "./routes/groupme";
import { authMiddleware, type AuthVariables } from "./middleware/auth";

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
  GROUPME_CLIENT_ID: string;
};

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

app.use("*", cors());

app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.route("/auth", auth);
app.route("/gmail", gmail);
app.route("/calendar", calendar);
app.route("/chat", chat);
app.route("/files", files);
app.route("/context", context);
app.route("/push", push);
app.route("/usage", usage);
app.route("/groupme", groupme);

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
    // Fire due reminders.
    const { results: dueReminders } = await env.DB.prepare(
      `SELECT r.id, r.user_id, r.message
       FROM reminders r
       WHERE r.status = 'pending' AND datetime(r.fire_at) <= datetime('now')`
    ).all<{ id: string; user_id: string; message: string }>();

    for (const rem of dueReminders) {
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
    _env: Env,
    _ctx: ExecutionContext
  ) {
    // Queue is no longer used. Drain anything still in flight.
    for (const msg of batch.messages) {
      msg.ack();
    }
  },
};

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
      const target = messages[i];
      console.error(
        `Expo push ticket error for ${target?.to ?? "?"}: ${errCode ?? "unknown"} — ${ticket.message}`
      );
      if (errCode === "DeviceNotRegistered" || errCode === "InvalidCredentials") {
        if (target) deadTokens.push(target.to);
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
