import { Hono } from "hono";
import type { Env } from "../index";
import type { AuthVariables } from "../middleware/auth";
import { authMiddleware } from "../middleware/auth";

type PushApp = Hono<{ Bindings: Env; Variables: AuthVariables }>;

const push: PushApp = new Hono();

push.use("*", authMiddleware);

// Register or upsert an Expo push token for this user/device.
push.post("/register", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json()) as { token?: string; platform?: string };
  const token = body.token?.trim();
  if (!token) return c.json({ error: "token required" }, 400);

  const existing = await c.env.DB.prepare(
    "SELECT id, user_id FROM push_tokens WHERE expo_token = ?"
  )
    .bind(token)
    .first<{ id: string; user_id: string }>();

  if (existing) {
    if (existing.user_id !== userId) {
      await c.env.DB.prepare("UPDATE push_tokens SET user_id = ? WHERE id = ?")
        .bind(userId, existing.id)
        .run();
    }
    return c.json({ ok: true, reused: true });
  }

  await c.env.DB.prepare(
    "INSERT INTO push_tokens (id, user_id, expo_token, platform) VALUES (?, ?, ?, ?)"
  )
    .bind(crypto.randomUUID(), userId, token, body.platform ?? null)
    .run();

  return c.json({ ok: true });
});

// Remove a push token (sign-out / device unregister).
push.post("/unregister", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => ({}))) as { token?: string };
  if (body.token) {
    await c.env.DB.prepare(
      "DELETE FROM push_tokens WHERE user_id = ? AND expo_token = ?"
    )
      .bind(userId, body.token)
      .run();
  } else {
    await c.env.DB.prepare("DELETE FROM push_tokens WHERE user_id = ?")
      .bind(userId)
      .run();
  }
  return c.json({ ok: true });
});

export { push };
