import { Hono } from "hono";
import type { Env } from "../index";
import type { AuthVariables } from "../middleware/auth";
import { authMiddleware } from "../middleware/auth";
import { logUsage } from "../services/claude";

type VisionApp = Hono<{ Bindings: Env; Variables: AuthVariables }>;

const vision: VisionApp = new Hono();

vision.use("*", authMiddleware);

const VISION_MODEL = "claude-haiku-4-5-20251001";

// POST /vision/detect — body is raw image bytes (image/jpeg or image/png).
// Returns { objects: [{ label, count, confidence, description }, ...], note }
vision.post("/detect", async (c) => {
  const userId = c.get("userId");
  const contentType = c.req.header("content-type") || "image/jpeg";
  if (!contentType.startsWith("image/")) {
    return c.json({ error: `Unsupported content type: ${contentType}` }, 400);
  }
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength === 0) return c.json({ error: "Empty image" }, 400);
  if (buf.byteLength > 5 * 1024 * 1024) return c.json({ error: "Image too large (max 5 MB)" }, 400);

  const base64 = arrayBufferToBase64(buf);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": c.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: contentType, data: base64 } },
          {
            type: "text",
            text: `List the distinct objects visible in this image. Return ONLY JSON of the form:
{
  "objects": [
    { "label": "string", "count": number, "confidence": "high" | "medium" | "low", "description": "short phrase" }
  ],
  "note": "optional one-sentence summary of the scene"
}
Use specific labels (e.g. "MacBook Pro" not just "laptop" if obvious). Group identical instances under count.`
          },
        ],
      }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    return c.json({ error: `Claude API error ${res.status}: ${err}` }, 500);
  }
  const data = await res.json() as { content: { type: string; text?: string }[]; usage?: any };
  await logUsage(c.env.DB, userId, "vision-detect", VISION_MODEL, data.usage);

  const text = data.content.find((b) => b.type === "text")?.text || "";
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
  const jsonStr = match ? match[1]! : text;
  try {
    const parsed = JSON.parse(jsonStr);
    return c.json(parsed);
  } catch {
    return c.json({ objects: [], note: text.slice(0, 500), raw: true });
  }
});

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

export { vision };
