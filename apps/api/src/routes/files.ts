import { Hono } from "hono";
import type { Env } from "../index";
import type { AuthVariables } from "../middleware/auth";
import { authMiddleware } from "../middleware/auth";
import { verifyJwt } from "../services/jwt";

type FilesApp = Hono<{ Bindings: Env; Variables: AuthVariables }>;

const files: FilesApp = new Hono();

// Auth middleware that also accepts ?token= query param (for opening files in browser)
files.use("*", async (c, next) => {
  const queryToken = c.req.query("token");
  if (queryToken && !c.req.header("Authorization")) {
    const payload = await verifyJwt(queryToken, c.env.SESSION_JWT_SECRET);
    if (!payload) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }
    c.set("userId", payload.sub);
    c.set("email", payload.email);
    return next();
  }
  return authMiddleware(c, next);
});

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

  // Record in DB — stored raw, no processing.
  await c.env.DB.prepare(
    "INSERT INTO ingested_files (id, user_id, kind, r2_key, status) VALUES (?, ?, ?, ?, 'stored')"
  )
    .bind(fileId, userId, kind, r2Key)
    .run();

  return c.json({ id: fileId, kind, status: "stored" });
});

// List user's uploaded files
files.get("/", async (c) => {
  const userId = c.get("userId");
  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 100);

  const { results } = await c.env.DB.prepare(
    "SELECT id, kind, r2_key, status, created_at FROM ingested_files WHERE user_id = ? ORDER BY created_at DESC LIMIT ?"
  )
    .bind(userId, limit)
    .all();

  return c.json({ files: results });
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

// Download file from R2
files.get("/:id/download", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  const file = await c.env.DB.prepare(
    "SELECT id, kind, r2_key FROM ingested_files WHERE id = ? AND user_id = ?"
  )
    .bind(id, userId)
    .first<{ id: string; kind: string; r2_key: string }>();

  if (!file) return c.json({ error: "Not found" }, 404);

  const obj = await c.env.FILES.get(file.r2_key);
  if (!obj) return c.json({ error: "File not found in storage" }, 404);

  const contentType =
    obj.httpMetadata?.contentType ||
    (file.kind === "pdf"
      ? "application/pdf"
      : file.kind === "audio"
        ? "audio/m4a"
        : "image/jpeg");

  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", "private, max-age=3600");
  if (obj.size) {
    headers.set("Content-Length", obj.size.toString());
  }

  return new Response(obj.body, { headers });
});

export { files };
