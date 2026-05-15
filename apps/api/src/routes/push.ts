import { Hono } from "hono";
import type { Env } from "../index";
import type { AuthVariables } from "../middleware/auth";
import { authMiddleware } from "../middleware/auth";

type PushApp = Hono<{ Bindings: Env; Variables: AuthVariables }>;

const push: PushApp = new Hono();

push.use("*", authMiddleware);

// Register a push token
push.post("/register", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json()) as { token: string; platform?: string };

  if (!body.token?.trim()) {
    return c.json({ error: "token required" }, 400);
  }

  const token = body.token.trim();
  const platform = body.platform || "ios";

  // Upsert — same token might re-register
  await c.env.DB.prepare(
    `INSERT INTO push_tokens (id, user_id, expo_token, platform)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (expo_token)
     DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform`
  )
    .bind(crypto.randomUUID(), userId, token, platform)
    .run();

  return c.json({ ok: true });
});

// Debug: list this user's tokens
push.get("/tokens", async (c) => {
  const userId = c.get("userId");
  const { results } = await c.env.DB.prepare(
    "SELECT expo_token, platform, created_at FROM push_tokens WHERE user_id = ? ORDER BY created_at DESC"
  )
    .bind(userId)
    .all<{ expo_token: string; platform: string | null; created_at: string }>();
  return c.json({ tokens: results });
});

// Unregister a push token
push.post("/unregister", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json()) as { token: string };

  if (!body.token?.trim()) {
    return c.json({ error: "token required" }, 400);
  }

  await c.env.DB.prepare(
    "DELETE FROM push_tokens WHERE user_id = ? AND expo_token = ?"
  )
    .bind(userId, body.token.trim())
    .run();

  return c.json({ ok: true });
});

// Notification history
push.get("/history", async (c) => {
  const userId = c.get("userId");
  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 100);

  const { results } = await c.env.DB.prepare(
    `SELECT id, title, body, category, triage_item_id, created_at
     FROM notification_log WHERE user_id = ?
     ORDER BY created_at DESC LIMIT ?`
  )
    .bind(userId, limit)
    .all<{ id: string; title: string; body: string; category: string | null; triage_item_id: string | null; created_at: string }>();

  return c.json({ notifications: results });
});

export { push };
