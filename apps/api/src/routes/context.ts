import { Hono } from "hono";
import type { Env } from "../index";
import type { AuthVariables } from "../middleware/auth";
import { authMiddleware } from "../middleware/auth";

type ContextApp = Hono<{ Bindings: Env; Variables: AuthVariables }>;

const context: ContextApp = new Hono();

context.use("*", authMiddleware);

// List all context entries
context.get("/", async (c) => {
  const userId = c.get("userId");
  const { results } = await c.env.DB.prepare(
    "SELECT id, kind, label, detail, created_at FROM user_context WHERE user_id = ? ORDER BY kind, label"
  )
    .bind(userId)
    .all();
  return c.json({ entries: results });
});

// Add a context entry
context.post("/", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json()) as {
    kind: string;
    label: string;
    detail?: string;
  };

  if (!body.kind?.trim() || !body.label?.trim()) {
    return c.json({ error: "kind and label required" }, 400);
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO user_context (id, user_id, kind, label, detail) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(id, userId, body.kind.trim(), body.label.trim(), body.detail?.trim() || null)
    .run();

  return c.json({ id, kind: body.kind, label: body.label, detail: body.detail || null });
});

// Delete a context entry
context.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  const result = await c.env.DB.prepare(
    "DELETE FROM user_context WHERE id = ? AND user_id = ?"
  )
    .bind(id, userId)
    .run();

  if (!result.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

export { context };
