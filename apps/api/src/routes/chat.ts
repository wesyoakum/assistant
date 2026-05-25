import { Hono } from "hono";
import type { Env } from "../index";
import type { AuthVariables } from "../middleware/auth";
import { authMiddleware } from "../middleware/auth";
import { logUsage, CHAT_MODEL, CLASSIFIER_MODEL } from "../services/claude";
import { createEvent } from "../services/google-calendar";

const CLAUDE_API = "https://api.anthropic.com/v1/messages";

type ChatApp = Hono<{ Bindings: Env; Variables: AuthVariables }>;

const chat: ChatApp = new Hono();

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

  const { results: groupmeRows } = await c.env.DB.prepare(
    `SELECT subject, from_addr, email_date, body_text
     FROM pending_emails WHERE user_id = ? AND source_type = 'groupme'
     ORDER BY email_date DESC LIMIT 50`
  ).bind(userId).all<{ subject: string; from_addr: string; email_date: string; body_text: string }>();

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

  if (groupmeRows.length > 0) {
    dataContext += "\n\n<groupme_messages>\n";
    for (const m of groupmeRows) {
      dataContext += `Group: ${m.subject}\nFrom: ${m.from_addr}\nWhen: ${m.email_date}\n${(m.body_text || "").slice(0, 300)}\n---\n`;
    }
    dataContext += "</groupme_messages>";
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

  const now = new Date();
  const centralFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  const centralStr = centralFmt.format(now);
  const systemPrompt = `You are a helpful personal assistant. You have access to the user's synced emails, calendar events, and pending reminders below. Use this data to answer questions about their schedule, emails, priorities, and upcoming commitments.

CURRENT DATE AND TIME (use this — do not guess or rely on chat history):
  ${centralStr}
  UTC: ${now.toISOString()}

When the user asks what time/day/date it is, answer from the line above. When parsing relative times like "in 30 minutes", "tomorrow at 9am", "next Monday", anchor to the line above and convert to UTC for the create_reminder tool. Assume US Central Time when a timezone is not specified.

You can create reminders that will be delivered as push notifications (create_reminder tool) and add events to the user's Google Calendar (create_event tool). For create_event, convert local times to ISO 8601 with a timezone offset (Central Time is -05:00 in summer/CDT, -06:00 in winter/CST — derive from the CURRENT DATE AND TIME above). If the user doesn't specify a duration, default to 1 hour. Always confirm what you scheduled in your reply.

You also have web_search available for current information (news, weather, sports scores, recent events, anything time-sensitive or outside your training cutoff). Search when asked about something current, when you're uncertain, or when the user explicitly asks you to look something up. Cite sources when you do.${dataContext}${remindersContext}`;

  const tools = [
    {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 5,
    },
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
      name: "create_event",
      description: "Add an event to the user's Google Calendar (primary calendar). Use this when the user asks to schedule, book, add, or put something on their calendar.",
      input_schema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Event title (what shows up in the calendar)",
          },
          start: {
            type: "string",
            description: "ISO 8601 start time with timezone offset, e.g. 2026-05-24T14:00:00-05:00 for 2pm Central in summer.",
          },
          end: {
            type: "string",
            description: "ISO 8601 end time with timezone offset. If user didn't specify, default to 1 hour after start.",
          },
          location: {
            type: "string",
            description: "Optional event location (address, room name, or meeting link).",
          },
          description: {
            type: "string",
            description: "Optional event notes / agenda.",
          },
          recurrence: {
            type: "array",
            items: { type: "string" },
            description: "Optional RFC 5545 RRULE strings for recurring events, each prefixed with 'RRULE:'. Examples: 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR' (every Mon/Wed/Fri), 'RRULE:FREQ=DAILY;COUNT=10' (next 10 days), 'RRULE:FREQ=MONTHLY;BYMONTHDAY=15;UNTIL=20261231T000000Z' (15th of every month until Dec 31 2026), 'RRULE:FREQ=YEARLY' (annually). Use UNTIL or COUNT to bound — never create unbounded recurrence unless the user explicitly asks for it.",
          },
        },
        required: ["title", "start", "end"],
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
    } else if (block.type === "tool_use" && block.name === "create_event") {
      const input = block.input as {
        title: string;
        start: string;
        end: string;
        location?: string;
        description?: string;
        recurrence?: string[];
      };

      try {
        const evt = await createEvent(
          userId,
          {
            title: input.title,
            startIso: input.start,
            endIso: input.end,
            location: input.location,
            description: input.description,
            recurrence: input.recurrence,
          },
          c.env
        );
        const recurNote = input.recurrence && input.recurrence.length > 0 ? ` (recurring: ${input.recurrence.join("; ")})` : "";
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Event "${input.title}" added to Google Calendar from ${input.start} to ${input.end}${recurNote}. Link: ${evt.htmlLink}`,
        });
      } catch (err) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Failed to create event: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
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
      reply = textBlock?.text || `Reminder set: ${createdReminders.join(", ")}`;
    } else {
      reply = `Reminder set: ${createdReminders.join(", ")}`;
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

// Insert an assistant message (used for client-driven announcements like
// release notes). Dedup is the client's responsibility.
chat.post("/announce", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => null)) as { text?: string } | null;
  const text = body?.text?.trim();
  if (!text) return c.json({ error: "text required" }, 400);

  await c.env.DB.prepare(
    "INSERT INTO chat_messages (id, user_id, role, content) VALUES (?, ?, 'assistant', ?)"
  ).bind(crypto.randomUUID(), userId, text).run();

  return c.json({ ok: true });
});

// Clear chat history
chat.delete("/history", async (c) => {
  const userId = c.get("userId");
  await c.env.DB.prepare("DELETE FROM chat_messages WHERE user_id = ?")
    .bind(userId)
    .run();
  return c.json({ ok: true });
});

// Auto-briefing — generates a summary of new emails + upcoming week.
// Throttled to once every 3 hours per user. Stores the result as an
// assistant message in chat_messages so it shows up next time the user
// opens chat.
const BRIEFING_THROTTLE_MS = 3 * 60 * 60 * 1000;

chat.post("/briefing", async (c) => {
  const userId = c.get("userId");

  // Throttle check
  const settings = await c.env.DB.prepare(
    "SELECT last_briefing_at FROM user_settings WHERE user_id = ?"
  ).bind(userId).first<{ last_briefing_at: string | null }>();

  const last = settings?.last_briefing_at ? new Date(settings.last_briefing_at).getTime() : 0;
  const now = Date.now();
  if (last && now - last < BRIEFING_THROTTLE_MS) {
    return c.json({ skipped: true, reason: "throttled", next_at: new Date(last + BRIEFING_THROTTLE_MS).toISOString() });
  }

  // Pull emails received since last briefing (or last 24h if first time)
  const since = last ? new Date(last).toISOString() : new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const { results: newEmails } = await c.env.DB.prepare(
    `SELECT subject, from_addr, email_date, snippet, body_text
       FROM pending_emails
      WHERE user_id = ? AND source_type = 'email' AND email_date >= ?
      ORDER BY email_date DESC LIMIT 50`
  ).bind(userId, since).all<{ subject: string; from_addr: string; email_date: string; snippet: string; body_text: string }>();

  // Pull next 7 days of calendar events
  const weekFromNow = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();
  const { results: events } = await c.env.DB.prepare(
    `SELECT subject, body_text, email_date
       FROM pending_emails
      WHERE user_id = ? AND source_type = 'calendar' AND email_date <= ?
      ORDER BY email_date ASC LIMIT 50`
  ).bind(userId, weekFromNow).all<{ subject: string; body_text: string; email_date: string }>();

  // New GroupMe messages since last briefing
  const { results: newGroupme } = await c.env.DB.prepare(
    `SELECT subject, from_addr, email_date, body_text
       FROM pending_emails
      WHERE user_id = ? AND source_type = 'groupme' AND email_date >= ?
      ORDER BY email_date DESC LIMIT 50`
  ).bind(userId, since).all<{ subject: string; from_addr: string; email_date: string; body_text: string }>();

  // If there's literally nothing new, skip (don't spam the chat)
  if (newEmails.length === 0 && events.length === 0 && newGroupme.length === 0) {
    await c.env.DB.prepare(
      `INSERT INTO user_settings (user_id, last_briefing_at) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET last_briefing_at = excluded.last_briefing_at`
    ).bind(userId, new Date(now).toISOString()).run();
    return c.json({ skipped: true, reason: "empty" });
  }

  // Build briefing prompt
  const centralFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  const nowStr = centralFmt.format(new Date(now));

  let dataBlock = `\n\nCURRENT TIME: ${nowStr}\n`;
  if (newEmails.length > 0) {
    dataBlock += `\n<new_emails since="${since}">\n`;
    for (const e of newEmails) {
      dataBlock += `From: ${e.from_addr}\nDate: ${e.email_date}\nSubject: ${e.subject}\n${(e.body_text || e.snippet || "").slice(0, 400)}\n---\n`;
    }
    dataBlock += `</new_emails>\n`;
  }
  if (events.length > 0) {
    dataBlock += `\n<upcoming_events>\n`;
    for (const ev of events) {
      try {
        const parsed = JSON.parse(ev.body_text);
        dataBlock += `Event: ${parsed.summary || ev.subject}\nWhen: ${parsed.start || ev.email_date}${parsed.end ? " - " + parsed.end : ""}\n${parsed.location ? "Location: " + parsed.location + "\n" : ""}---\n`;
      } catch {
        dataBlock += `Event: ${ev.subject}\nWhen: ${ev.email_date}\n---\n`;
      }
    }
    dataBlock += `</upcoming_events>\n`;
  }
  if (newGroupme.length > 0) {
    dataBlock += `\n<new_groupme_messages since="${since}">\n`;
    for (const m of newGroupme) {
      dataBlock += `Group: ${m.subject}\nFrom: ${m.from_addr}\nWhen: ${m.email_date}\n${(m.body_text || "").slice(0, 300)}\n---\n`;
    }
    dataBlock += `</new_groupme_messages>\n`;
  }

  const systemPrompt = `You write a brief morning-briefing-style update for a personal-assistant app user. The user just opened the app — emails, calendar, and GroupMe were just synced. Your job: give a friendly, scannable summary of:
1. New emails (call out anything that looks important or time-sensitive; group routine stuff)
2. The coming week's calendar (highlight today and tomorrow, then briefly note the rest)
3. New GroupMe messages (which groups, what's the gist, anything that's asking for a response)

Keep it conversational and tight — under 200 words. No greeting like "Good morning" (the time of day varies). Skip sections that are empty. Use plain markdown for structure (## headings, bullet lists). End with a short prompt like "Anything you want me to dig into?".`;

  const res = await fetch(CLAUDE_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": c.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLASSIFIER_MODEL,
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: "user", content: dataBlock }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Briefing Claude error:", res.status, err);
    return c.json({ error: "Briefing unavailable", detail: `${res.status}: ${err.slice(0, 200)}` }, 502);
  }

  const data = (await res.json()) as {
    content: { type: string; text?: string }[];
    usage?: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
  };
  await logUsage(c.env.DB, userId, "briefing", CLASSIFIER_MODEL, data.usage);

  const text = data.content.find((b) => b.type === "text")?.text?.trim();
  if (!text) {
    return c.json({ error: "Empty briefing" }, 502);
  }

  // Persist as assistant chat message
  await c.env.DB.prepare(
    "INSERT INTO chat_messages (id, user_id, role, content) VALUES (?, ?, 'assistant', ?)"
  ).bind(crypto.randomUUID(), userId, text).run();

  // Update throttle timestamp
  await c.env.DB.prepare(
    `INSERT INTO user_settings (user_id, last_briefing_at) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET last_briefing_at = excluded.last_briefing_at`
  ).bind(userId, new Date(now).toISOString()).run();

  return c.json({ skipped: false, message: text, emails: newEmails.length, events: events.length });
});

export { chat };
