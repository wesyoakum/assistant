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
    timezone?: string;
  };

  if (!body.message?.trim()) {
    return c.json({ error: "Message required" }, 400);
  }

  const tz = body.timezone || "UTC";

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

  // Get recent feedback
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

  // Load open triage items
  const { results: triageItems } = await c.env.DB.prepare(
    `SELECT source_type, priority, urgency, category, summary, suggested_action, created_at
     FROM triage_items WHERE user_id = ? AND status = 'open'
     ORDER BY priority DESC, urgency DESC LIMIT 15`
  )
    .bind(userId)
    .all<{ source_type: string; priority: number; urgency: number; category: string | null; summary: string | null; suggested_action: string | null; created_at: string }>();

  let triageInbox = "";
  if (triageItems.length > 0) {
    const lines = triageItems.map(
      (t) => `- [P${t.priority}U${t.urgency}] ${t.source_type}: ${t.summary || "no summary"}${t.suggested_action ? ` → ${t.suggested_action}` : ""}`
    );
    triageInbox = `\n\nOpen triage items (${triageItems.length}):\n${lines.join("\n")}`;
  }

  // Load pending calendar suggestions
  const { results: calSuggestions } = await c.env.DB.prepare(
    `SELECT title, start_iso, end_iso, location
     FROM calendar_suggestions
     WHERE user_id = ? AND status = 'pending'
     ORDER BY start_iso LIMIT 10`
  )
    .bind(userId)
    .all<{ title: string; start_iso: string; end_iso: string; location: string | null }>();

  let suggestionsContext = "";
  if (calSuggestions.length > 0) {
    const lines = calSuggestions.map(
      (s) => `- "${s.title}" at ${s.start_iso}${s.location ? ` (${s.location})` : ""}`
    );
    suggestionsContext = `\n\nPending calendar suggestions:\n${lines.join("\n")}`;
  }

  // Load user context
  const { results: contextRows } = await c.env.DB.prepare(
    "SELECT kind, label, detail FROM user_context WHERE user_id = ?"
  )
    .bind(userId)
    .all<{ kind: string; label: string; detail: string | null }>();

  // Build known context map
  const knownKinds = new Set(contextRows.map((r) => r.kind + ":" + r.label.toLowerCase()));
  const knownLabels = contextRows.map((r) => r.label.toLowerCase());

  let userContext = "";
  if (contextRows.length > 0) {
    const lines = contextRows.map(
      (r) => `- ${r.kind}: ${r.label}${r.detail ? ` — ${r.detail}` : ""}`
    );
    userContext = `\n\nWhat I know about the user:\n${lines.join("\n")}`;
  }

  // Determine what context is missing
  const desiredContext = [
    { kind: "profile", key: "name", question: "what should I call you", label: "user's name" },
    { kind: "profile", key: "birthday", question: "when's your birthday", label: "birthday" },
    { kind: "profile", key: "location", question: "where are you based", label: "location or timezone" },
    { kind: "family", key: "relationship_status", question: "are you married or have a partner", label: "relationship status" },
    { kind: "family", key: "spouse", question: "what's your spouse/partner's name", label: "spouse/partner" },
    { kind: "family", key: "children", question: "do you have any kids", label: "children" },
    { kind: "work", key: "occupation", question: "what do you do for work", label: "occupation" },
    { kind: "dates", key: "anniversary", question: "any important dates like an anniversary I should know about", label: "important dates" },
    { kind: "activities", key: "activities", question: "any regular activities, sports teams, or classes I should know about", label: "activities or commitments" },
    { kind: "preferences", key: "schedule", question: "are you more of a morning person or night owl", label: "schedule preference" },
  ];

  const missing = desiredContext.filter((d) => {
    // Check if any context entry matches this desired item
    return !contextRows.some((r) =>
      r.kind === d.kind && r.label.toLowerCase().includes(d.key)
      || r.detail?.toLowerCase().includes(d.key)
      || r.label.toLowerCase().includes(d.label.split(" ")[0])
    );
  });

  // Pick at most one missing item to ask about
  let contextPromptHint = "";
  if (missing.length > 0) {
    const ask = missing[0];
    contextPromptHint = `\n\nGETTING TO KNOW THE USER: I'm still missing some context. If there's a natural moment in this conversation, casually ask: "${ask.question}?" — but ONLY if it fits the flow. Do NOT lead with it if the user is asking about something specific. Never ask more than one getting-to-know-you question per message. If the conversation is task-focused, skip it entirely.`;
  }

  const now = new Date();
  const currentDateTime = now.toLocaleString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
    timeZone: tz,
  });

  const systemPrompt = `You are a helpful personal assistant for managing email, calendar, and tasks. The current date and time is: ${currentDateTime}. You help the user triage, prioritize, and take action on their items. Be concise and actionable in your responses. When discussing triage items, reference the Eisenhower matrix: Hot (high importance + high urgency), Action (low importance + high urgency), Plan (high importance + low urgency), Noop (low importance + low urgency).

SAVING CONTEXT: When the user tells you about people in their life, relationships, activities, teams, classes, birthdays, important dates, or other recurring context, you MUST save it by including a JSON block in your response like this:
\`\`\`save_context
{"kind": "person", "label": "Coach Smith", "detail": "Jake's soccer coach, Wildcats team"}
\`\`\`

Valid kinds: profile, family, person, work, school, sports, health, dates, organization, preferences, other.
You can include multiple save_context blocks in one response. Save when the user provides new persistent context — names, birthdays, relationships, schedules, important dates, preferences. For profile info use kind "profile" with labels like "name", "birthday", "location". For family use kind "family" with labels like "spouse", "children", "relationship_status". For important dates use kind "dates".${userContext}${triageInbox}${suggestionsContext}${contextPromptHint}${triageContext}${feedbackContext}`;

  // Build messages array with history
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
  let reply = textBlock?.text || "Sorry, I couldn't generate a response.";

  // Extract and save any context blocks from the reply
  const contextPattern = /```save_context\s*([\s\S]*?)```/g;
  let match;
  const saved: string[] = [];
  while ((match = contextPattern.exec(reply)) !== null) {
    try {
      const entry = JSON.parse(match[1].trim());
      if (entry.kind && entry.label) {
        const id = crypto.randomUUID();
        await c.env.DB.prepare(
          "INSERT INTO user_context (id, user_id, kind, label, detail) VALUES (?, ?, ?, ?, ?)"
        )
          .bind(id, userId, entry.kind, entry.label, entry.detail || null)
          .run();
        saved.push(entry.label);
      }
    } catch {
      // ignore malformed blocks
    }
  }

  // Strip save_context blocks from the reply shown to user
  reply = reply.replace(/```save_context\s*[\s\S]*?```\n?/g, "").trim();

  return c.json({ reply, savedContext: saved.length > 0 ? saved : undefined });
});

// Generate a greeting when the app opens
chat.get("/greeting", async (c) => {
  const userId = c.get("userId");
  const tz = c.req.query("tz") || "UTC";

  // Load user context
  const { results: contextRows } = await c.env.DB.prepare(
    "SELECT kind, label, detail FROM user_context WHERE user_id = ?"
  )
    .bind(userId)
    .all<{ kind: string; label: string; detail: string | null }>();

  // Count open triage items
  const triageCount = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM triage_items WHERE user_id = ? AND status = 'open'"
  )
    .bind(userId)
    .first<{ count: number }>();

  // Count high priority items
  const hotCount = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM triage_items WHERE user_id = ? AND status = 'open' AND priority >= 4"
  )
    .bind(userId)
    .first<{ count: number }>();

  // Upcoming events in next 24h
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const { results: suggestions } = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM calendar_suggestions WHERE user_id = ? AND status = 'pending'"
  )
    .bind(userId)
    .all<{ count: number }>();

  const pendingSuggestions = suggestions[0]?.count || 0;

  // Build context for greeting
  let knownContext = "";
  if (contextRows.length > 0) {
    const lines = contextRows.map(
      (r) => `- ${r.kind}: ${r.label}${r.detail ? ` — ${r.detail}` : ""}`
    );
    knownContext = `\nWhat I know about the user:\n${lines.join("\n")}`;
  }

  const userName = contextRows.find(
    (r) => r.kind === "profile" && r.label.toLowerCase().includes("name")
  )?.detail;

  const now = new Date();
  const localTime = now.toLocaleString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
    timeZone: tz,
  });
  const hour = parseInt(now.toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: tz }));
  const timeOfDay = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";

  const systemPrompt = `You are a personal assistant greeting the user when they open the app. Generate a brief, warm greeting (2-4 sentences max).

Include:
- A time-appropriate greeting${userName ? ` using their name "${userName}"` : ""}
- A quick status summary if there's anything notable
- If context is missing (see below), you may ask ONE casual getting-to-know-you question

Current status:
- Open triage items: ${triageCount?.count || 0}
- High priority (Hot) items: ${hotCount?.count || 0}
- Pending calendar suggestions: ${pendingSuggestions}
- Current date/time: ${localTime}
- Time of day: ${timeOfDay}
${knownContext}

${contextRows.length === 0 ? "This appears to be a new user — introduce yourself briefly and ask their name." : ""}

Keep it concise and natural. Do NOT use save_context blocks in greetings.`;

  const res = await fetch(CLAUDE_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": c.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 256,
      system: systemPrompt,
      messages: [{ role: "user", content: "Generate a greeting for when I open the app." }],
    }),
  });

  if (!res.ok) {
    // Fallback greeting
    const name = userName ? `, ${userName}` : "";
    return c.json({ greeting: `Good ${timeOfDay}${name}! You have ${triageCount?.count || 0} items to triage.` });
  }

  const data = (await res.json()) as {
    content: { type: string; text?: string }[];
  };
  const textBlock = data.content.find((b) => b.type === "text");
  const greeting = textBlock?.text || `Good ${timeOfDay}! How can I help?`;

  return c.json({ greeting });
});

export { chat };
