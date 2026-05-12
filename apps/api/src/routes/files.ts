import { Hono } from "hono";
import type { Env } from "../index";
import type { AuthVariables } from "../middleware/auth";
import { authMiddleware } from "../middleware/auth";
import type { QueueMessage } from "@assistant/shared";

type FilesApp = Hono<{ Bindings: Env; Variables: AuthVariables }>;

const files: FilesApp = new Hono();

files.use("*", authMiddleware);

// Upload a file (image, PDF, or audio) — max 100MB
files.post("/upload", async (c) => {
  const userId = c.get("userId");
  const contentType = c.req.header("content-type") || "";

  let kind: "image" | "pdf" | "audio";
  if (contentType.startsWith("image/")) {
    kind = "image";
  } else if (contentType === "application/pdf") {
    kind = "pdf";
  } else if (contentType.startsWith("audio/")) {
    kind = "audio";
  } else {
    return c.json({ error: `Unsupported content type: ${contentType}` }, 400);
  }

  const ext = kind === "pdf" ? "pdf" : kind === "audio" ? "m4a" : "jpg";
  const fileId = crypto.randomUUID();
  const r2Key = `users/${userId}/files/${fileId}.${ext}`;

  // Stream body to R2
  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) {
    return c.json({ error: "Empty file" }, 400);
  }
  if (body.byteLength > 100 * 1024 * 1024) {
    return c.json({ error: "File too large (100MB max)" }, 413);
  }

  await c.env.FILES.put(r2Key, body, {
    httpMetadata: { contentType },
  });

  // Record in DB
  await c.env.DB.prepare(
    "INSERT INTO ingested_files (id, user_id, kind, r2_key, status) VALUES (?, ?, ?, ?, 'pending')"
  )
    .bind(fileId, userId, kind, r2Key)
    .run();

  // Enqueue for processing
  const msg: QueueMessage = {
    type: "triage.classify.file" as any,
    userId,
    fileId,
    kind,
    r2Key,
  };
  await c.env.TASKS.send(msg);

  return c.json({ id: fileId, kind, status: "pending" });
});

// Get file status
files.get("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  const file = await c.env.DB.prepare(
    "SELECT id, kind, r2_key, status, created_at FROM ingested_files WHERE id = ? AND user_id = ?"
  )
    .bind(id, userId)
    .first();

  if (!file) return c.json({ error: "Not found" }, 404);
  return c.json(file);
});

export { files };
