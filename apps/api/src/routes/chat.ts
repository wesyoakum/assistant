import { Hono } from "hono";
import type { Env } from "../index";
import type { AuthVariables } from "../middleware/auth";
import { authMiddleware } from "../middleware/auth";

const CLAUDE_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-5";

type ChatApp = Hono<{ Bindings: Env; Variables: AuthVariables }>;

const chat: ChatApp = new Hono();

chat.use("*", authMiddleware);

chat.post("/", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json()) as {
    message: string;
    triage_item_id?: string;
    history?: { role: "user" | "assistant"; content: string }[];
  };

  if (!body.message?.trim()) {
    return c.json({ error: "Message required" }, 400);
  }

  // Build context from triage item if referenced
  let triageContext = "";
  if (body.triage_item_id) {
    const item = await c.env.DB.prepare(
      "SELECT source_type, summary, suggested_action, category, priority, urgency, classifier_json FROM triage_items WHERE id = ? AND user_id = ?"
    )
      .bind(body.triage_item_id, userId)
      .first<{
        source_type: string;
        summary: string | null;
        suggested_action: string | null;
        category: string | null;
        priority: number;
        urgency: number;
        classifier_json: string | null;
      }>();

    if (item) {
      triageContext = `\n\nThe user is asking about this triage item:
- Source: ${item.source_type}
- Category: ${item.category || "uncategorized"}
- Priority: ${item.priority}/5, Urgency: ${item.urgency}/5
- Summary: ${item.summary || "none"}
- Suggested action: ${item.suggested_action || "none"}`;
    }
  }

  // Get recent feedback to understand user preferences
  const { results: feedbackRows } = await c.env.DB.prepare(
    `SELECT f.kind, f.note, t.summary, t.category
     FROM feedback f
     JOIN triage_items t ON t.id = f.triage_item_id
     WHERE f.user_id = ?
     ORDER BY f.created_at DESC
     LIMIT 5`
  )
    .bind(userId)
    .all<{ kind: string; note: string | null; summary: string | null; category: string | null }>();

  let feedbackContext = "";
  if (feedbackRows.length > 0) {
    const lines = feedbackRows.map(
      (r) => `- ${r.kind} on "${r.summary || "item"}"${r.note ? `: ${r.note}` : ""}`
    );
    feedbackContext = `\n\nRecent user feedback on triage items:\n${lines.join("\n")}`;
  }

  const systemPrompt = `You are a helpful personal assistant for managing email, calendar, and tasks. You help the user triage, prioritize, and take action on their items. Be concise and actionable in your responses. When discussing triage items, reference the Eisenhower matrix: Hot (high importance + high urgency), Action (low importance + high urgency), Plan (high importance + low urgency), Noop (low importance + low urgency).${triageContext}${feedbackContext}`;

  // Build messages array with history if provided
  const messages: { role: "user" | "assistant"; content: string }[] = [];
  if (body.history) {
    for (const msg of body.history.slice(-20)) {
      messages.push({ role: msg.role, content: msg.content });
    }
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
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Chat Claude error:", res.status, err);
    return c.json({ error: "Assistant unavailable", detail: `${res.status}: ${err.slice(0, 200)}` }, 502);
  }

  const data = (await res.json()) as {
    content: { type: string; text?: string }[];
  };
  const textBlock = data.content.find((b) => b.type === "text");
  const reply = textBlock?.text || "Sorry, I couldn't generate a response.";

  return c.json({ reply });
});

export { chat };
