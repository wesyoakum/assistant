import { Hono } from "hono";
import type { Env } from "../index";
import type { AuthVariables } from "../middleware/auth";
import { authMiddleware } from "../middleware/auth";
import { logUsage, CHAT_MODEL } from "../services/claude";

const CLAUDE_API = "https://api.anthropic.com/v1/messages";

type ChatApp = Hono<{ Bindings: Env; Variables: AuthVariables }>;

const chat: ChatApp = new Hono();

function summarizeToolActions(reminders: string[], contextSaves: string[]): string {
  const parts: string[] = [];
  if (reminders.length) parts.push(`Reminder set: ${reminders.join(", ")}`);
  if (contextSaves.length) parts.push(`Remembered: ${contextSaves.join(", ")}`);
  return parts.length ? parts.join(". ") : "Done.";
}

chat.use("*", authMiddleware);

chat.post("/", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json()) as {
    message: string;
    history?: { role: "user" | "assistant"; content: string }[];
  };

  if (!body.message?.trim()) {
    return c.json({ error: "Message required" }, 400);
  }

  // Load recent history from DB
  const { results: historyRows } = await c.env.DB.prepare(
    "SELECT role, content FROM chat_messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 10"
  )
    .bind(userId)
    .all<{ role: "user" | "assistant"; content: string }>();

  // Load stored emails and calendar events for context
  const { results: emailRows } = await c.env.DB.prepare(
    `SELECT subject, from_addr, email_date, snippet, body_text
     FROM pending_emails WHERE user_id = ? AND source_type = 'email'
     ORDER BY email_date DESC LIMIT 50`
  ).bind(userId).all<{ subject: string; from_addr: string; email_date: string; snippet: string; body_text: string }>();

  const { results: calRows } = await c.env.DB.prepare(
    `SELECT subject, body_text, email_date
     FROM pending_emails WHERE user_id = ? AND source_type = 'calendar'
     ORDER BY email_date ASC LIMIT 50`
  ).bind(userId).all<{ subject: string; body_text: string; email_date: string }>();

  let dataContext = "";

  if (emailRows.length > 0) {
    dataContext += "\n\n<emails>\n";
    for (const e of emailRows) {
      dataContext += `From: ${e.from_addr}\nDate: ${e.email_date}\nSubject: ${e.subject}\n${e.body_text ? e.body_text.slice(0, 500) : e.snippet}\n---\n`;
    }
    dataContext += "</emails>";
  }

  if (calRows.length > 0) {
    dataContext += "\n\n<calendar_events>\n";
    for (const ev of calRows) {
      try {
        const parsed = JSON.parse(ev.body_text);
        dataContext += `Event: ${parsed.summary || ev.subject}\nWhen: ${parsed.start || ev.email_date}${parsed.end ? " - " + parsed.end : ""}\nCalendar: ${parsed.calendarName || ""}\n${parsed.location ? "Location: " + parsed.location + "\n" : ""}${parsed.description ? "Details: " + parsed.description.slice(0, 300) + "\n" : ""}---\n`;
      } catch {
        dataContext += `Event: ${ev.subject}\nWhen: ${ev.email_date}\n---\n`;
      }
    }
    dataContext += "</calendar_events>";
  }

  // Load pending reminders for context
  const { results: reminderRows } = await c.env.DB.prepare(
    `SELECT message, fire_at, status FROM reminders
     WHERE user_id = ? AND status = 'pending'
     ORDER BY fire_at ASC LIMIT 20`
  ).bind(userId).all<{ message: string; fire_at: string; status: string }>();

  let remindersContext = "";
  if (reminderRows.length > 0) {
    remindersContext += "\n\n<pending_reminders>\n";
    for (const r of reminderRows) {
      remindersContext += `- "${r.message}" at ${r.fire_at}\n`;
    }
    remindersContext += "</pending_reminders>";
  }

  // Load remembered user context — both background facts and hard preferences.
  const { results: contextRows } = await c.env.DB.prepare(
    `SELECT kind, label, detail FROM user_context WHERE user_id = ? ORDER BY kind, label`
  ).bind(userId).all<{ kind: string; label: string; detail: string | null }>();

  let userContextBlock = "";
  if (contextRows.length > 0) {
    const preferences = contextRows.filter((r) => r.kind === "preference");
    const regular = contextRows.filter((r) => r.kind !== "preference" && r.kind !== "feature");
    if (regular.length > 0) {
      userContextBlock += "\n\n## Remembered Context\nThings the user has previously asked you to remember:\n";
      for (const r of regular) {
        userContextBlock += `- ${r.kind}: ${r.label}${r.detail ? ` — ${r.detail}` : ""}\n`;
      }
    }
    if (preferences.length > 0) {
      userContextBlock += "\n\n## User Preferences (follow these)\n";
      for (const p of preferences) {
        userContextBlock += `- **${p.label}**: ${p.detail || ""}\n`;
      }
    }
  }

  const now = new Date();
  const systemPrompt = `You are a helpful personal assistant. You have access to the user's synced emails, calendar events, and pending reminders below. Use this data to answer questions about their schedule, emails, priorities, and upcoming commitments.

Current date/time: ${now.toISOString()} (UTC). The user is in US Central Time.

You can create reminders that will be delivered as push notifications. When the user asks you to remind them about something, use the create_reminder tool. Parse relative times like "in 30 minutes", "tomorrow at 9am", "next Monday" into ISO 8601 UTC timestamps. When the user says a time without a timezone, assume US Central Time and convert to UTC.

When the user asks you to remember something about them, their preferences, or how you should behave (e.g. "remember that…", "from now on…", "I prefer…"), use the save_context tool to persist it. Use kind="preference" for behavioral rules you should follow (these become hard rules); use a descriptive kind like "person", "project", "fact", "habit", etc. for background information. Pick a short label and put the substance in detail.${userContextBlock}${dataContext}${remindersContext}`;

  const tools = [
    {
      name: "create_reminder",
      description: "Schedule a push notification reminder for the user at a specific time. Use this when the user asks to be reminded about something.",
      input_schema: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "The reminder message to show in the push notification",
          },
          fire_at: {
            type: "string",
            description: "ISO 8601 UTC timestamp for when to fire the reminder (e.g. 2026-05-20T15:00:00Z)",
          },
        },
        required: ["message", "fire_at"],
      },
    },
    {
      name: "save_context",
      description:
        "Persist a fact, preference, or instruction the user wants you to remember across conversations. Use kind='preference' for behavioral rules the assistant and classifier should follow; otherwise pick a descriptive kind such as 'person', 'project', 'fact', 'habit', 'goal'. Keep label short (a few words) and put the substance in detail.",
      input_schema: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            description: "Category, e.g. 'preference', 'person', 'project', 'fact', 'habit', 'goal'.",
          },
          label: {
            type: "string",
            description: "Short identifier — a few words. For preferences, phrase as a rule (e.g. 'No work emails on weekends').",
          },
          detail: {
            type: "string",
            description: "Full content of what to remember. Optional if the label is self-contained.",
          },
        },
        required: ["kind", "label"],
      },
    },
  ];

  const messages: { role: "user" | "assistant"; content: string | object[] }[] = [];
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
      model: CHAT_MODEL,
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages,
      tools,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Chat Claude error:", res.status, err);
    return c.json({ error: "Assistant unavailable", detail: `${res.status}: ${err.slice(0, 200)}` }, 502);
  }

  type ContentBlock =
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

  const data = (await res.json()) as {
    content: ContentBlock[];
    stop_reason: string;
    usage?: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
  };
  await logUsage(c.env.DB, userId, "chat", CHAT_MODEL, data.usage);

  // Process tool calls
  const toolResults: { type: "tool_result"; tool_use_id: string; content: string }[] = [];
  const createdReminders: string[] = [];
  const savedContext: string[] = [];

  for (const block of data.content) {
    if (block.type === "tool_use" && block.name === "create_reminder") {
      const input = block.input as { message: string; fire_at: string };
      const reminderId = crypto.randomUUID();

      await c.env.DB.prepare(
        "INSERT INTO reminders (id, user_id, message, fire_at) VALUES (?, ?, ?, ?)"
      ).bind(reminderId, userId, input.message, input.fire_at).run();

      createdReminders.push(`"${input.message}" at ${input.fire_at}`);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: `Reminder created: "${input.message}" scheduled for ${input.fire_at}`,
      });
    } else if (block.type === "tool_use" && block.name === "save_context") {
      const input = block.input as { kind: string; label: string; detail?: string };
      const kind = input.kind?.trim();
      const label = input.label?.trim();
      if (!kind || !label) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: "Error: kind and label are required.",
        });
        continue;
      }
      const detail = input.detail?.trim() || null;
      const contextId = crypto.randomUUID();
      await c.env.DB.prepare(
        "INSERT INTO user_context (id, user_id, kind, label, detail) VALUES (?, ?, ?, ?, ?)"
      ).bind(contextId, userId, kind, label, detail).run();

      savedContext.push(`${kind}: ${label}`);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: `Saved: ${kind} — ${label}${detail ? ` (${detail})` : ""}`,
      });
    }
  }

  let reply: string;

  if (toolResults.length > 0 && data.stop_reason === "tool_use") {
    // Send tool results back to get a natural language response
    const followUpMessages = [
      ...messages,
      { role: "assistant" as const, content: data.content },
      { role: "user" as const, content: toolResults },
    ];

    const followUpRes = await fetch(CLAUDE_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": c.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CHAT_MODEL,
        max_tokens: 1024,
        system: [
          {
            type: "text",
            text: systemPrompt,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: followUpMessages,
        tools,
      }),
    });

    if (followUpRes.ok) {
      const followUpData = (await followUpRes.json()) as {
        content: ContentBlock[];
        usage?: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
      };
      await logUsage(c.env.DB, userId, "chat", CHAT_MODEL, followUpData.usage);
      const textBlock = followUpData.content.find((b): b is { type: "text"; text: string } => b.type === "text");
      reply = textBlock?.text || summarizeToolActions(createdReminders, savedContext);
    } else {
      reply = summarizeToolActions(createdReminders, savedContext);
    }
  } else {
    // No tool calls — just extract text
    const textBlock = data.content.find((b): b is { type: "text"; text: string } => b.type === "text");
    reply = textBlock?.text || "Sorry, I couldn't generate a response.";
  }

  // Persist messages
  await c.env.DB.prepare(
    "INSERT INTO chat_messages (id, user_id, role, content) VALUES (?, ?, 'user', ?)"
  ).bind(crypto.randomUUID(), userId, body.message).run();

  await c.env.DB.prepare(
    "INSERT INTO chat_messages (id, user_id, role, content) VALUES (?, ?, 'assistant', ?)"
  ).bind(crypto.randomUUID(), userId, reply).run();

  return c.json({ reply });
});

// Static greeting — no AI call
chat.get("/greeting", async (c) => {
  return c.json({ greeting: "How can I help?" });
});

// Get chat history
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

// Clear chat history
chat.delete("/history", async (c) => {
  const userId = c.get("userId");
  await c.env.DB.prepare("DELETE FROM chat_messages WHERE user_id = ?")
    .bind(userId)
    .run();
  return c.json({ ok: true });
});

export { chat };
