import { Hono } from "hono";
import { z } from "zod/v4";
import type { Env } from "../index";
import type { AuthVariables } from "../middleware/auth";
import { authMiddleware } from "../middleware/auth";
import type { TriageItem } from "@assistant/shared";

type TriageApp = Hono<{ Bindings: Env; Variables: AuthVariables }>;

const triage: TriageApp = new Hono();

triage.use("*", authMiddleware);

// List triage items
triage.get("/", async (c) => {
  const userId = c.get("userId");
  const status = c.req.query("status") || "open";
  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 100);
  const cursor = c.req.query("cursor");

  let query = `SELECT * FROM triage_items WHERE user_id = ? AND status = ?`;
  const params: unknown[] = [userId, status];

  if (cursor) {
    query += ` AND created_at < ?`;
    params.push(cursor);
  }

  query += ` ORDER BY priority DESC, urgency DESC, created_at DESC LIMIT ?`;
  params.push(limit + 1);

  const stmt = env_bind(c.env.DB.prepare(query), params);
  const { results } = await stmt.all<TriageItem>();

  const hasMore = results.length > limit;
  const items = hasMore ? results.slice(0, limit) : results;
  const nextCursor = hasMore ? items[items.length - 1]?.created_at : undefined;

  return c.json({ items, cursor: nextCursor });
});

// Get single triage item
triage.get("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  const item = await c.env.DB.prepare(
    "SELECT * FROM triage_items WHERE id = ? AND user_id = ?"
  )
    .bind(id, userId)
    .first<TriageItem>();

  if (!item) return c.json({ error: "Not found" }, 404);
  return c.json(item);
});

// Submit feedback
const feedbackSchema = z.object({
  kind: z.enum(["up", "down", "wrong_priority"]),
  corrected_priority: z.number().int().min(1).max(5).optional(),
  corrected_urgency: z.number().int().min(1).max(5).optional(),
  note: z.string().max(500).optional(),
});

triage.post("/:id/feedback", async (c) => {
  const userId = c.get("userId");
  const triageItemId = c.req.param("id");

  const body = await c.req.json();
  const parsed = feedbackSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid feedback", details: parsed.error }, 400);
  }

  const fb = parsed.data;

  // Verify the triage item belongs to this user
  const item = await c.env.DB.prepare(
    "SELECT id, priority, urgency FROM triage_items WHERE id = ? AND user_id = ?"
  )
    .bind(triageItemId, userId)
    .first<{ id: string; priority: number; urgency: number }>();

  if (!item) return c.json({ error: "Not found" }, 404);

  await c.env.DB.prepare(
    `INSERT INTO feedback (id, user_id, triage_item_id, kind, corrected_priority, corrected_urgency, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      userId,
      triageItemId,
      fb.kind,
      fb.corrected_priority ?? null,
      fb.corrected_urgency ?? null,
      fb.note ?? null
    )
    .run();

  // If wrong_priority, update the triage item
  if (fb.kind === "wrong_priority") {
    const newPriority = fb.corrected_priority ?? item.priority;
    const newUrgency = fb.corrected_urgency ?? item.urgency;
    await c.env.DB.prepare(
      "UPDATE triage_items SET priority = ?, urgency = ?, updated_at = datetime('now') WHERE id = ?"
    )
      .bind(newPriority, newUrgency, triageItemId)
      .run();
  }

  return c.json({ ok: true });
});

// Update status
const statusSchema = z.object({
  status: z.enum(["done", "dismissed"]),
});

triage.post("/:id/status", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  const body = await c.req.json();
  const parsed = statusSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid status" }, 400);
  }

  const result = await c.env.DB.prepare(
    "UPDATE triage_items SET status = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
  )
    .bind(parsed.data.status, id, userId)
    .run();

  if (!result.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// Helper to bind an array of params to a D1 prepared statement
function env_bind(stmt: D1PreparedStatement, params: unknown[]) {
  return stmt.bind(...params);
}

export { triage };
