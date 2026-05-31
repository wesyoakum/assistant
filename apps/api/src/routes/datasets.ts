import { Hono } from "hono";
import type { Env } from "../index";
import type { AuthVariables } from "../middleware/auth";
import { authMiddleware } from "../middleware/auth";

type DatasetApp = Hono<{ Bindings: Env; Variables: AuthVariables }>;

const datasets: DatasetApp = new Hono();

datasets.use("*", authMiddleware);

// One labeled training sample = a frame image + its label JSON, uploaded together.
// Used by the lab app's Field tab to build a keypoint-detection dataset in R2.
// Stored as two R2 objects under a per-user, per-dataset prefix:
//   users/<uid>/datasets/<dataset>/<sampleId>.jpg
//   users/<uid>/datasets/<dataset>/<sampleId>.json
// No D1 schema change — listing enumerates R2 directly.

interface LabelKeypoint {
  id: string;       // landmark id, e.g. "first_base", "rubber"
  nx: number;       // normalized 0..1
  ny: number;
  visible: boolean; // false = labeled-but-occluded / absent
}
interface LabelLine {
  id: string;                       // "foul_1b" | "foul_3b"
  p1: { nx: number; ny: number };   // two points on the chalk (normalized)
  p2: { nx: number; ny: number };
}
interface LabelPayload {
  dataset: string;
  imageBase64: string;       // JPEG, no data: prefix
  imageWidth: number;
  imageHeight: number;
  fieldSpec?: string;        // level of play used when labeling
  keypoints: LabelKeypoint[];
  lines?: LabelLine[];       // foul lines, each two tapped points on the chalk
  sourceVideo?: string;      // optional provenance
  timeSec?: number;
}

const DATASET_RE = /^[a-zA-Z0-9_-]{1,64}$/;

// POST /datasets/sample — upload one labeled frame.
datasets.post("/sample", async (c) => {
  const userId = c.get("userId");
  let body: LabelPayload;
  try {
    body = await c.req.json<LabelPayload>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const dataset = (body.dataset || "default").trim();
  if (!DATASET_RE.test(dataset)) {
    return c.json({ error: "dataset must be 1-64 chars [A-Za-z0-9_-]" }, 400);
  }
  const hasLabels = (body.keypoints?.length ?? 0) > 0 || (body.lines?.length ?? 0) > 0;
  if (!body.imageBase64 || !hasLabels) {
    return c.json({ error: "imageBase64 and at least one keypoint or line are required" }, 400);
  }

  // Decode the base64 JPEG.
  let bytes: Uint8Array;
  try {
    const clean = body.imageBase64.replace(/^data:[^,]+,/, "");
    const bin = atob(clean);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return c.json({ error: "imageBase64 did not decode" }, 400);
  }
  if (bytes.byteLength === 0) return c.json({ error: "Empty image" }, 400);
  if (bytes.byteLength > 20 * 1024 * 1024) return c.json({ error: "Image too large (20MB max)" }, 413);

  const sampleId = crypto.randomUUID();
  const prefix = `users/${userId}/datasets/${dataset}/${sampleId}`;

  const label = {
    sampleId,
    dataset,
    imageWidth: body.imageWidth,
    imageHeight: body.imageHeight,
    fieldSpec: body.fieldSpec ?? null,
    keypoints: body.keypoints ?? [],
    lines: body.lines ?? [],
    sourceVideo: body.sourceVideo ?? null,
    timeSec: body.timeSec ?? null,
    createdAt: new Date().toISOString(),
  };

  await c.env.FILES.put(`${prefix}.jpg`, bytes, { httpMetadata: { contentType: "image/jpeg" } });
  await c.env.FILES.put(`${prefix}.json`, JSON.stringify(label), { httpMetadata: { contentType: "application/json" } });

  return c.json({ sampleId, dataset });
});

// GET /datasets — list the user's datasets with sample counts.
datasets.get("/", async (c) => {
  const userId = c.get("userId");
  const base = `users/${userId}/datasets/`;
  const counts = new Map<string, number>();
  let cursor: string | undefined;
  do {
    const listed = await c.env.FILES.list({ prefix: base, cursor, limit: 1000 });
    for (const obj of listed.objects) {
      if (!obj.key.endsWith(".json")) continue;
      const rest = obj.key.slice(base.length);
      const ds = rest.split("/")[0];
      if (ds) counts.set(ds, (counts.get(ds) ?? 0) + 1);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return c.json({ datasets: [...counts.entries()].map(([name, samples]) => ({ name, samples })) });
});

// GET /datasets/:name/labels — concatenated label JSON for the whole dataset,
// for pulling down + converting to YOLO-keypoint txt on the training machine.
datasets.get("/:name/labels", async (c) => {
  const userId = c.get("userId");
  const name = c.req.param("name");
  if (!DATASET_RE.test(name)) return c.json({ error: "bad dataset name" }, 400);
  const prefix = `users/${userId}/datasets/${name}/`;

  const samples: unknown[] = [];
  let cursor: string | undefined;
  do {
    const listed = await c.env.FILES.list({ prefix, cursor, limit: 1000 });
    for (const obj of listed.objects) {
      if (!obj.key.endsWith(".json")) continue;
      const r = await c.env.FILES.get(obj.key);
      if (r) samples.push(await r.json());
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return c.json({ dataset: name, count: samples.length, samples });
});

export { datasets };
