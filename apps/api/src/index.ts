import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./routes/auth";
import { gmail, syncGmailForUser } from "./routes/gmail";
import { calendar } from "./routes/calendar";
import { chat } from "./routes/chat";
import { files } from "./routes/files";
import { syncIcalFeed } from "./services/ical";
import { TokenExpiredError } from "./services/gmail";
import { authMiddleware, type AuthVariables } from "./middleware/auth";

export type Env = {
  DB: D1Database;
  FILES: R2Bucket;
  GOOGLE_CLIENT_SECRET: string;
  OAUTH_ENCRYPTION_KEY: string;
  SESSION_JWT_SECRET: string;
  ANTHROPIC_API_KEY: string;
  ENVIRONMENT: string;
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

  // Cron: pull raw Gmail per user and refresh iCal feeds. No classification.
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
  ) {
    const { results: users } = await env.DB.prepare(
      "SELECT id FROM users"
    ).all<{ id: string }>();

    for (const user of users) {
      try {
        const n = await syncGmailForUser(user.id, env);
        if (n > 0) console.log(`Cron: collected ${n} emails for ${user.id}`);
      } catch (err) {
        if (err instanceof TokenExpiredError) {
          console.warn(`User ${user.id}: token expired, skipping gmail pull`);
        } else {
          console.error(`Gmail pull failed for ${user.id}:`, err);
        }
      }
    }

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
  },
};
