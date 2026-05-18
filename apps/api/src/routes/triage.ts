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

  const sourceType = c.req.query("source_type");

  let query = `SELECT * FROM triage_items WHERE user_id = ? AND status = ?`;
  const params: unknown[] = [userId, status];

  if (sourceType) {
    query += ` AND source_type = ?`;
    params.push(sourceType);
  }

  if (cursor) {
    query += ` AND created_at < ?`;
    params.push(cursor);
  }

  // Email tab: newest first. Triage tab: priority order.
  if (sourceType) {
    query += ` ORDER BY created_at DESC LIMIT ?`;
  } else {
    query += ` ORDER BY priority DESC, urgency DESC, created_at DESC LIMIT ?`;
  }
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

// Direct edit (priority, urgency, category, 5-factor dimensions)
const editSchema = z.object({
  priority: z.number().int().min(1).max(5).optional(),
  urgency: z.number().int().min(1).max(5).optional(),
  category: z.string().max(50).optional(),
  impact: z.number().int().min(1).max(5).optional(),
  meaning: z.number().int().min(1).max(5).optional(),
  responsibility: z.number().int().min(1).max(5).optional(),
  time_sensitivity: z.number().int().min(1).max(5).optional(),
  immediacy: z.number().int().min(1).max(5).optional(),
});

triage.patch("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  const body = await c.req.json();
  const parsed = editSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid edit", details: parsed.error }, 400);
  }

  const updates = parsed.data;
  const setClauses: string[] = [];
  const params: unknown[] = [];

  if (updates.priority !== undefined) {
    setClauses.push("priority = ?");
    params.push(updates.priority);
  }
  if (updates.urgency !== undefined) {
    setClauses.push("urgency = ?");
    params.push(updates.urgency);
  }
  if (updates.category !== undefined) {
    setClauses.push("category = ?");
    params.push(updates.category);
  }

  // Update dimension scores in classifier_json
  const dimensionFields = ["impact", "meaning", "responsibility", "time_sensitivity", "immediacy"] as const;
  const hasDimensions = dimensionFields.some((f) => updates[f] !== undefined);
  if (hasDimensions) {
    // Read existing classifier_json and merge
    const existing = await c.env.DB.prepare(
      "SELECT classifier_json FROM triage_items WHERE id = ? AND user_id = ?"
    ).bind(id, userId).first<{ classifier_json: string | null }>();

    let classifierData: Record<string, unknown> = {};
    if (existing?.classifier_json) {
      try { classifierData = JSON.parse(existing.classifier_json); } catch { /* ignore */ }
    }

    for (const f of dimensionFields) {
      if (updates[f] !== undefined) classifierData[f] = updates[f];
    }
    if (updates.priority !== undefined) classifierData.importance = updates.priority;
    if (updates.urgency !== undefined) classifierData.urgency = updates.urgency;

    setClauses.push("classifier_json = ?");
    params.push(JSON.stringify(classifierData));
  }

  if (setClauses.length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  setClauses.push("updated_at = datetime('now')");
  params.push(id, userId);

  const result = await c.env.DB.prepare(
    `UPDATE triage_items SET ${setClauses.join(", ")} WHERE id = ? AND user_id = ?`
  )
    .bind(...params)
    .run();

  if (!result.meta.changes) return c.json({ error: "Not found" }, 404);
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

// Re-evaluate a single triage item from its source data
triage.post("/:id/reevaluate", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  const item = await c.env.DB.prepare(
    "SELECT source_type, source_ref, source_json FROM triage_items WHERE id = ? AND user_id = ?"
  ).bind(id, userId).first<{ source_type: string; source_ref: string | null; source_json: string | null }>();

  if (!item) return c.json({ error: "Not found" }, 404);

  if (item.source_type === "email" && item.source_json) {
    try {
      const parsed = JSON.parse(item.source_json);
      // Handle merged sources (array) — use the latest email
      const email = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
      if (!email.messageId) return c.json({ error: "No email data" }, 400);

      const { classifyAndStoreEmail } = await import("../services/classify");

      // Delete the existing item first (classify will create a new one)
      // Clear FK references
      await c.env.DB.prepare("DELETE FROM feedback WHERE triage_item_id = ?").bind(id).run();
      await c.env.DB.prepare("DELETE FROM notification_log WHERE triage_item_id = ?").bind(id).run();
      await c.env.DB.prepare("DELETE FROM calendar_suggestions WHERE triage_item_id = ?").bind(id).run();
      await c.env.DB.prepare("DELETE FROM triage_items WHERE id = ?").bind(id).run();

      const { itemId, result } = await classifyAndStoreEmail(userId, {
        messageId: email.messageId,
        threadId: email.threadId || "",
        subject: email.subject || "",
        from: email.from || "",
        date: email.date || "",
        bodyText: email.bodyText || "",
      }, c.env);

      // If source was merged (array), restore the full source_json
      if (Array.isArray(parsed)) {
        await c.env.DB.prepare(
          "UPDATE triage_items SET source_json = ? WHERE id = ?"
        ).bind(JSON.stringify(parsed), itemId).run();
      }

      return c.json({ ok: true, newItemId: itemId, importance: result.importance, urgency: result.urgency, summary: result.summary });
    } catch (err) {
      return c.json({ error: "Re-evaluate failed", detail: String(err) }, 500);
    }
  }

  if ((item.source_type === "image" || item.source_type === "document" || item.source_type === "voice") && item.source_ref) {
    // Queue file re-classification
    const file = await c.env.DB.prepare(
      "SELECT id, kind, r2_key FROM ingested_files WHERE id = ?"
    ).bind(item.source_ref).first<{ id: string; kind: string; r2_key: string }>();

    if (file) {
      await c.env.DB.prepare("DELETE FROM feedback WHERE triage_item_id = ?").bind(id).run();
      await c.env.DB.prepare("DELETE FROM notification_log WHERE triage_item_id = ?").bind(id).run();
      await c.env.DB.prepare("DELETE FROM triage_items WHERE id = ?").bind(id).run();

      await c.env.TASKS.send({
        type: "triage.classify.file" as const,
        userId,
        fileId: file.id,
        kind: file.kind as "image" | "pdf" | "audio",
        r2Key: file.r2_key,
      });
      return c.json({ ok: true, queued: true });
    }
  }

  return c.json({ error: "Cannot re-evaluate this item type" }, 400);
});

function env_bind(stmt: D1PreparedStatement, params: unknown[]) {
  return stmt.bind(...params);
}

export { triage };
