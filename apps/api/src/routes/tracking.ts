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

export { tracking };
