import { Hono } from "hono";
import type { Env } from "../index";
import type { AuthVariables } from "../middleware/auth";
import { authMiddleware } from "../middleware/auth";

const CLAUDE_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-7";

type ChatApp = Hono<{ Bindings: Env; Variables: AuthVariables }>;

const chat: ChatApp = new Hono();

chat.use("*", authMiddleware);

// Generic chat. No system prompt, no injected context, no steering.
// The model only sees the raw persisted transcript plus the new message.
chat.post("/", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json()) as { message: string };

  if (!body.message?.trim()) {
    return c.json({ error: "Message required" }, 400);
  }

  const { results: historyRows } = await c.env.DB.prepare(
    "SELECT role, content FROM chat_messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 20"
  )
    .bind(userId)
    .all<{ role: "user" | "assistant"; content: string }>();

  const messages: { role: "user" | "assistant"; content: string }[] = [];
  for (const row of historyRows.reverse()) {
    messages.push({ role: row.role, content: row.content });
  }
  messages.push({ role: "user", content: body.message });

  const res = await fetch(CLAUDE_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": c.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      messages,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Chat Claude error:", res.status, err);
    return c.json(
      { error: "Assistant unavailable", detail: `${res.status}: ${err.slice(0, 200)}` },
      502
    );
  }

  const data = (await res.json()) as {
    content: { type: string; text?: string }[];
  };
  const textBlock = data.content.find((b) => b.type === "text");
  const reply = textBlock?.text || "Sorry, I couldn't generate a response.";

  await c.env.DB.prepare(
    "INSERT INTO chat_messages (id, user_id, role, content) VALUES (?, ?, 'user', ?)"
  ).bind(crypto.randomUUID(), userId, body.message).run();

  await c.env.DB.prepare(
    "INSERT INTO chat_messages (id, user_id, role, content) VALUES (?, ?, 'assistant', ?)"
  ).bind(crypto.randomUUID(), userId, reply).run();

  return c.json({ reply });
});

// Get chat history (oldest first).
chat.get("/history", async (c) => {
  const userId = c.get("userId");
  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 100);

  const { results } = await c.env.DB.prepare(
    "SELECT id, role, content, created_at FROM chat_messages WHERE user_id = ? ORDER BY created_at DESC LIMIT ?"
  )
    .bind(userId, limit)
    .all<{ id: string; role: string; content: string; created_at: string }>();

  return c.json({ messages: results.reverse() });
});

// Clear chat history.
chat.delete("/history", async (c) => {
  const userId = c.get("userId");
  await c.env.DB.prepare("DELETE FROM chat_messages WHERE user_id = ?")
    .bind(userId)
    .run();
  return c.json({ ok: true });
});

export { chat };
