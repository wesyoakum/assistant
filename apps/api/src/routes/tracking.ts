import { Hono } from "hono";
import type { Env } from "../index";
import type { AuthVariables } from "../middleware/auth";
import { authMiddleware } from "../middleware/auth";

type TrackingApp = Hono<{ Bindings: Env; Variables: AuthVariables }>;

const tracking: TrackingApp = new Hono();

tracking.use("*", authMiddleware);

// POST /tracking — save a tracking session (camera pose + detections).
// Stored as a JSON file in R2 under users/<uid>/tracking/<id>.json.
tracking.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const key = `users/${userId}/tracking/${id}.json`;

  const payload = {
    id,
    userId,
    savedAt: new Date().toISOString(),
    ...body,
  };

  await c.env.FILES.put(key, JSON.stringify(payload, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });

  return c.json({ id, key });
});

// GET /tracking — list saved tracking sessions.
tracking.get("/", async (c) => {
  const userId = c.get("userId");
  const prefix = `users/${userId}/tracking/`;
  const list = await c.env.FILES.list({ prefix, limit: 50 });

  const sessions = list.objects.map((obj) => ({
    key: obj.key,
    id: obj.key.replace(prefix, "").replace(".json", ""),
    size: obj.size,
    uploaded: obj.uploaded.toISOString(),
  }));

  return c.json({ sessions });
});

// GET /tracking/:id — retrieve a specific tracking session.
tracking.get("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const key = `users/${userId}/tracking/${id}.json`;
  const obj = await c.env.FILES.get(key);
  if (!obj) return c.json({ error: "Not found" }, 404);
  const data = await obj.json();
  return c.json(data);
});

// ── Model storage ──────────────────────────────────────────────────

// POST /tracking/models — upload a .mlmodel file.
// Body is the raw model bytes. Name from query param.
tracking.post("/models", async (c) => {
  const userId = c.get("userId");
  const name = c.req.query("name");
  if (!name) return c.json({ error: "name query param required" }, 400);
  const data = await c.req.arrayBuffer();
  if (data.byteLength === 0) return c.json({ error: "Empty body" }, 400);
  const key = `models/${name}.mlmodel`;
  await c.env.FILES.put(key, data, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { uploadedBy: userId, uploadedAt: new Date().toISOString() },
  });
  return c.json({ key, size: data.byteLength });
});

// GET /tracking/models — list available models.
tracking.get("/models", async (c) => {
  const list = await c.env.FILES.list({ prefix: "models/", limit: 50 });
  const models = list.objects.map((obj) => ({
    name: obj.key.replace("models/", "").replace(".mlmodel", ""),
    key: obj.key,
    size: obj.size,
    uploaded: obj.uploaded.toISOString(),
  }));
  return c.json({ models });
});

// GET /tracking/models/:name — download a model file.
tracking.get("/models/:name", async (c) => {
  const name = c.req.param("name");
  const key = `models/${name}.mlmodel`;
  const obj = await c.env.FILES.get(key);
  if (!obj) return c.json({ error: "Model not found" }, 404);
  return new Response(obj.body, {
    headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${name}.mlmodel"` },
  });
});

export { tracking };
