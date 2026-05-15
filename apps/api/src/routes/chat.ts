import { Hono } from "hono";
import type { Env } from "../index";
import type { AuthVariables } from "../middleware/auth";
import { authMiddleware } from "../middleware/auth";
import { listUpcomingEvents, createEvent, updateEvent, deleteEvent } from "../services/google-calendar";

const CLAUDE_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-7";

function getQuadrant(priority: number, urgency: number): "Hot" | "Action" | "Plan" | "Noop" {
  const imp = priority >= 4 ? "high" : priority === 3 ? "medium" : "low";
  const urg = urgency >= 4 ? "high" : urgency === 3 ? "medium" : "low";
  if (imp === "high" && urg !== "low") return "Hot";
  if (imp === "high" && urg === "low") return "Plan";
  if (urg === "high" && imp !== "high") return "Action";
  if (imp === "medium" && urg === "medium") return "Plan";
  if (imp === "medium" && urg === "low") return "Noop";
  if (imp === "low" && urg === "medium") return "Action";
  return "Noop";
}

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
      "SELECT source_type, source_ref, summary, suggested_action, category, priority, urgency, classifier_json, source_title, source_url, created_at FROM triage_items WHERE id = ? AND user_id = ?"
    )
      .bind(body.triage_item_id, userId)
      .first<{
        source_type: string;
        source_ref: string | null;
        summary: string | null;
        suggested_action: string | null;
        category: string | null;
        priority: number;
        urgency: number;
        classifier_json: string | null;
        source_title: string | null;
        source_url: string | null;
        created_at: string;
      }>();

    if (item) {
      const q = getQuadrant(item.priority, item.urgency);
      triageContext = `\n\nThe user is asking about this triage item:
- Source: ${item.source_type}
- Category: ${item.category || "uncategorized"}
- Quadrant: ${q} (Priority: ${item.priority}/5, Urgency: ${item.urgency}/5)
- Summary: ${item.summary || "none"}
- Suggested action: ${item.suggested_action || "none"}
- Created: ${item.created_at}`;

      if (item.source_title) triageContext += `\n- Source title: ${item.source_title}`;
      if (item.source_url) triageContext += `\n- Source URL: ${item.source_url}`;

      // Include full classifier output for detailed context
      if (item.classifier_json) {
        try {
          const parsed = JSON.parse(item.classifier_json);
          if (parsed.details || parsed.extended_summary) {
            triageContext += `\n- Details: ${parsed.details || parsed.extended_summary}`;
          }
          if (parsed.clarification_question) {
            triageContext += `\n- Open question: ${parsed.clarification_question}`;
          }
        } catch { /* ignore */ }
      }

      // For emails, try to load the original message content from Gmail sync
      if (item.source_type === "email" && item.source_ref) {
        triageContext += `\n- Gmail message ID: ${item.source_ref}`;
      }
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

  // Load open triage items with full details
  const { results: triageItems } = await c.env.DB.prepare(
    `SELECT id, source_type, source_ref, priority, urgency, category, summary, suggested_action, classifier_json, source_title, source_url, event_at, due_at, event_created_at, event_updated_at, created_at
     FROM triage_items WHERE user_id = ? AND status = 'open'
     ORDER BY priority DESC, urgency DESC LIMIT 15`
  )
    .bind(userId)
    .all<{ id: string; source_type: string; source_ref: string | null; priority: number; urgency: number; category: string | null; summary: string | null; suggested_action: string | null; classifier_json: string | null; source_title: string | null; source_url: string | null; event_at: string | null; due_at: string | null; event_created_at: string | null; event_updated_at: string | null; created_at: string }>();

  let triageInbox = "";
  if (triageItems.length > 0) {
    const nowMs = Date.now();
    const lines = triageItems.map((t) => {
      const q = getQuadrant(t.priority, t.urgency);
      const parts = [`[id:${t.id}] [${q}] P${t.priority}U${t.urgency} ${t.source_type}`];
      parts.push(`summary: ${t.summary || "no summary"}`);
      if (t.category) parts.push(`category: ${t.category}`);
      if (t.source_title) parts.push(`from: ${t.source_title}`);
      if (t.source_url) parts.push(`url: ${t.source_url}`);
      if (t.source_ref) {
        parts.push(`ref: ${t.source_ref}`);
        if (t.source_type === "event") parts.push(`cal:primary|evt:${t.source_ref}`);
      }
      const eventTime = t.event_at || t.due_at;
      if (eventTime) {
        const isPast = new Date(eventTime).getTime() < nowMs;
        parts.push(`${isPast ? "PAST " : ""}event: ${eventTime}`);
      }
      if (t.event_created_at) parts.push(`created: ${t.event_created_at}`);
      if (t.suggested_action) parts.push(`action: ${t.suggested_action}`);
      // Include classifier details if available
      if (t.classifier_json) {
        try {
          const c = JSON.parse(t.classifier_json);
          if (c.details) parts.push(`details: ${c.details}`);
          if (c.clarification_question) parts.push(`question: ${c.clarification_question}`);
        } catch { /* ignore */ }
      }
      parts.push(`triaged: ${t.created_at}`);
      return `- ${parts.join(" | ")}`;
    });
    const counts = { Hot: 0, Action: 0, Plan: 0, Noop: 0 };
    for (const t of triageItems) counts[getQuadrant(t.priority, t.urgency)]++;
    const countStr = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(", ");
    triageInbox = `\n\nOpen triage items (${triageItems.length} total: ${countStr}):\n${lines.join("\n")}`;
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

  // Load upcoming calendar events
  let calendarContext = "";
  try {
    const events = await listUpcomingEvents(userId, c.env, 30, 75);
    if (events.length > 0) {
      const lines = events.map((e) => {
        const start = new Date(e.start).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz });
        let line = `- [cal:${e.calendarId}|evt:${e.id}] "${e.summary}" — ${start}`;
        if (e.location) line += ` @ ${e.location}`;
        if (e.calendarName) line += ` (${e.calendarName})`;
        return line;
      });
      calendarContext = `\n\nUpcoming calendar events (next 30 days, format [cal:calendarId|evt:eventId]):\n${lines.join("\n")}`;
    }
  } catch {
    // Calendar fetch may fail if token expired
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

  const regularContext = contextRows.filter((r) => r.kind !== "feature" && r.kind !== "preference");
  const preferences = contextRows.filter((r) => r.kind === "preference");
  const features = contextRows.filter((r) => r.kind === "feature");

  let userContext = "";
  if (regularContext.length > 0) {
    const lines = regularContext.map(
      (r) => `- ${r.kind}: ${r.label}${r.detail ? ` — ${r.detail}` : ""}`
    );
    userContext = `\n\nWhat I know about the user:\n${lines.join("\n")}`;
  }
  if (preferences.length > 0) {
    const lines = preferences.map(
      (r) => `- ${r.label}: ${r.detail || ""}`
    );
    userContext += `\n\nUser's behavior preferences (follow these):\n${lines.join("\n")}`;
  }
  if (features.length > 0) {
    const lines = features.map(
      (r) => `- ${r.label}: ${r.detail || ""}`
    );
    userContext += `\n\nFeature requests (acknowledged, in backlog):\n${lines.join("\n")}`;
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

PAST EVENTS: If any open triage items have a PAST date, proactively ask: did this happen, or reschedule? If it happened, dismiss it immediately. Each triage item is one instance; future occurrences create new items automatically. Only ask about 1-2 past items per message.

When discussing triage items from calendars, always mention which calendar they came from (shown in the source_title or ref fields).

NEVER assume relationships between people. If you see a name (e.g. "Jakob"), do not guess whether they are a spouse, child, sibling, coworker, etc. Instead, ask the user what their relationship is. Only state relationships you have explicitly been told about in the user context.

MISSING DEADLINES: If a triage item has no due_at or event_at date, it's missing an urgency reference. When discussing such items, ask the user if there's a deadline, due date, or timeframe. If they provide one, update the item using edit_triage with the appropriate fields.

CRITICAL: Trust your own conversation history. If you already asked about a specific item and the user responded, act on THAT item — do not re-evaluate or switch to a different item. Match the item you discussed to its ID in the triage list and execute. Never say "wait" or "actually I meant a different item." The user answered YOUR question — honor it.

SAVING CONTEXT: When the user tells you about people in their life, relationships, activities, teams, classes, birthdays, important dates, or other recurring context, you MUST save it by including a JSON block in your response like this:
\`\`\`save_context
{"kind": "person", "label": "Coach Smith", "detail": "Jake's soccer coach, Wildcats team"}
\`\`\`

Valid kinds: profile, family, person, work, school, sports, health, dates, organization, preference, feature, other.
- Use kind "preference" for assistant behavior preferences (e.g. "be more concise", "always suggest calendar events", "don't ask about my schedule"). Label should be a short name, detail should explain the preference.
- Use kind "feature" for feature requests the user wants added to the app (e.g. "dark mode", "snooze triage items"). Label should be a short title, detail should describe what they want.
You can include multiple save_context blocks in one response. Save when the user provides new persistent context — names, birthdays, relationships, schedules, important dates, preferences. For profile info use kind "profile" with labels like "name", "birthday", "location". For family use kind "family" with labels like "spouse", "children", "relationship_status". For important dates use kind "dates".

CREATING TRIAGE ITEMS: When the user asks you to create a triage item, reminder, task, or to-do, you MUST include a JSON block like this:
\`\`\`save_triage
{"summary": "Call dentist to schedule cleaning", "priority": 3, "urgency": 2, "category": "health", "suggested_action": "Call during business hours"}
\`\`\`
Priority and urgency are 1-5. Category can be: billing, scheduling, personal, work, newsletter, notification, social, shopping, travel, security, health, legal, other. Always confirm to the user that the item was created.

EDITING TRIAGE ITEMS: When the user asks you to dismiss, complete, update, reprioritize, rename, or change any triage item, you MUST include a JSON block using the item's id from the list above:
\`\`\`edit_triage
{"id": "the-item-uuid", "status": "dismissed"}
\`\`\`
Fields you can set: summary, priority (1-5), urgency (1-5), category, suggested_action, status ("open", "done", "dismissed").
Only include fields that are changing. Use the exact id from the triage list. When matching items from conversation context, use your best judgment — e.g. if you mentioned "the 3d group meeting" and the list has [id:abc] "3d group meetup", that's the same item, use id "abc". You can include multiple edit_triage blocks. Always confirm what was changed.

IMPORTANT: When editing a calendar event (changing its time, title, location, etc.), you MUST emit BOTH an edit_triage block (to update the triage item) AND an edit_event block (to update the actual Google Calendar event). Calendar-sourced triage items show "cal:primary|evt:eventId" — use those values for calendarId and eventId in the edit_event block. If you only emit edit_triage, the Google Calendar event will NOT be updated.

CALENDAR ACTIONS: You can create, edit, and delete Google Calendar events.

To create an event:
\`\`\`create_event
{"title": "Dentist appointment", "startIso": "2026-05-15T14:00:00-05:00", "endIso": "2026-05-15T15:00:00-05:00", "location": "123 Main St", "description": "Annual cleaning"}
\`\`\`

To edit an event (use calendarId and eventId from the events list above):
\`\`\`edit_event
{"calendarId": "primary", "eventId": "abc123", "summary": "Updated title", "startIso": "2026-05-15T15:00:00-05:00", "endIso": "2026-05-15T16:00:00-05:00"}
\`\`\`
Fields you can set: summary, startIso, endIso, location, description. Only include fields that are changing.

To delete an event:
\`\`\`delete_event
{"calendarId": "primary", "eventId": "abc123"}
\`\`\`

You have visibility into the next 30 days of events. When the user asks about events in that window, answer directly from the list above. Always confirm calendar actions to the user. Use ISO 8601 dates with the user's timezone offset.

WEB SEARCH: You can search the internet when needed. Use this when:
- The user explicitly asks you to search or look something up
- You need current/real-time information (news, prices, hours, weather, scores)
- You're not confident in your answer and want to verify
Do NOT search for things you already know well. To search, include:
\`\`\`search_web
{"query": "post office hours near me"}
\`\`\`
The search results will be appended and you'll generate a final response incorporating them. Only one search per message.

REMINDERS: When the user asks to be reminded about something at a specific time, create a reminder:
\`\`\`create_reminder
{"message": "Call the dentist", "fire_at": "2026-05-15T14:00:00-05:00"}
\`\`\`
The fire_at must be an ISO 8601 datetime with timezone offset. The reminder will trigger a push notification at that time. For relative times like "in 5 minutes" or "in an hour", calculate the absolute time based on the current date/time: ${currentDateTime}. Always confirm the reminder time with the user.${userContext}${triageInbox}${suggestionsContext}${calendarContext}${contextPromptHint}${triageContext}${feedbackContext}`;

  // Build messages array from persisted history
  const { results: historyRows } = await c.env.DB.prepare(
    "SELECT role, content FROM chat_messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 20"
  )
    .bind(userId)
    .all<{ role: "user" | "assistant"; content: string }>();

  const messages: { role: "user" | "assistant"; content: string }[] = [];
  // historyRows is newest-first, reverse for chronological order
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

  // Check for web search request — if found, execute search and re-call Claude
  const searchMatch = reply.match(/```search_web\s*([\s\S]*?)```/);
  if (searchMatch && c.env.BRAVE_SEARCH_API_KEY) {
    try {
      const searchReq = JSON.parse(searchMatch[1].trim());
      if (searchReq.query) {
        const searchRes = await fetch(
          `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(searchReq.query)}&count=5`,
          { headers: { "Accept": "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": c.env.BRAVE_SEARCH_API_KEY } }
        );

        let searchContext = "No results found.";
        if (searchRes.ok) {
          const searchData = (await searchRes.json()) as {
            web?: { results?: { title: string; url: string; description: string }[] };
          };
          const results = searchData.web?.results || [];
          if (results.length > 0) {
            searchContext = results.map(
              (r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`
            ).join("\n\n");
          }
        }

        // Re-call Claude with search results
        messages.push({ role: "assistant", content: reply });
        messages.push({ role: "user", content: `Here are the web search results for "${searchReq.query}":\n\n${searchContext}\n\nPlease provide a final answer incorporating these results. Do NOT include another search_web block.` });

        const res2 = await fetch(CLAUDE_API, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": c.env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: MODEL,
            max_tokens: 1024,
            system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
            messages,
          }),
        });

        if (res2.ok) {
          const data2 = (await res2.json()) as { content: { type: string; text?: string }[] };
          const text2 = data2.content.find((b) => b.type === "text");
          if (text2?.text) reply = text2.text;
        }
      }
    } catch {
      // Search failed — strip the block and use original reply
      reply = reply.replace(/```search_web\s*[\s\S]*?```\n?/g, "").trim();
    }
  }

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

  // Extract and create any triage items from the reply
  const triagePattern = /```save_triage\s*([\s\S]*?)```/g;
  const createdItems: string[] = [];
  let triageMatch;
  while ((triageMatch = triagePattern.exec(reply)) !== null) {
    try {
      const item = JSON.parse(triageMatch[1].trim());
      if (item.summary) {
        const itemId = crypto.randomUUID();
        await c.env.DB.prepare(
          `INSERT INTO triage_items (id, user_id, source_type, priority, urgency, category, summary, suggested_action, status)
           VALUES (?, ?, 'chat', ?, ?, ?, ?, ?, 'open')`
        )
          .bind(
            itemId, userId,
            item.priority || 3, item.urgency || 3,
            item.category || "other",
            item.summary,
            item.suggested_action || null
          )
          .run();
        createdItems.push(item.summary);
      }
    } catch {
      // ignore malformed blocks
    }
  }

  // Extract and apply triage edits
  const editPattern = /```edit_triage\s*([\s\S]*?)```/g;
  const editedItems: string[] = [];
  let editMatch;
  while ((editMatch = editPattern.exec(reply)) !== null) {
    try {
      const req = JSON.parse(editMatch[1].trim());
      if (!req.id) continue;

      const setClauses: string[] = [];
      const params: unknown[] = [];

      const allowedFields: Record<string, string> = {
        summary: "summary",
        priority: "priority",
        urgency: "urgency",
        category: "category",
        suggested_action: "suggested_action",
        status: "status",
      };

      for (const [key, col] of Object.entries(allowedFields)) {
        if (req[key] !== undefined) {
          setClauses.push(`${col} = ?`);
          params.push(req[key]);
        }
      }

      if (setClauses.length === 0) continue;

      setClauses.push("updated_at = datetime('now')");
      params.push(req.id, userId);

      const result = await c.env.DB.prepare(
        `UPDATE triage_items SET ${setClauses.join(", ")} WHERE id = ? AND user_id = ?`
      )
        .bind(...params)
        .run();

      if (result.meta.changes) {
        editedItems.push(req.id);
      }
    } catch {
      // ignore malformed blocks
    }
  }

  // Extract and create reminders
  const reminderPattern = /```create_reminder\s*([\s\S]*?)```/g;
  const createdReminders: string[] = [];
  let remMatch;
  while ((remMatch = reminderPattern.exec(reply)) !== null) {
    try {
      const rem = JSON.parse(remMatch[1].trim());
      if (rem.message && rem.fire_at) {
        // fire_at must carry a timezone (Z or ±HH:MM). Without one,
        // new Date() reads it as the Worker's local time (UTC), which
        // silently shifts reminders by the user's offset.
        const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(rem.fire_at);
        if (!hasTz) {
          console.warn(`Skipping reminder with naive fire_at: ${rem.fire_at}`);
          continue;
        }
        const fireAtUtc = new Date(rem.fire_at).toISOString();
        await c.env.DB.prepare(
          "INSERT INTO reminders (id, user_id, message, fire_at) VALUES (?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), userId, rem.message, fireAtUtc).run();
        createdReminders.push(rem.message);
      }
    } catch { /* ignore */ }
  }

  // Extract and execute calendar actions
  const calendarActions: string[] = [];

  // Create events
  const createEventPattern = /```create_event\s*([\s\S]*?)```/g;
  let ceMatch;
  while ((ceMatch = createEventPattern.exec(reply)) !== null) {
    try {
      const evt = JSON.parse(ceMatch[1].trim());
      if (evt.title && evt.startIso && evt.endIso) {
        const result = await createEvent(userId, evt, c.env);
        calendarActions.push(`Created "${evt.title}"`);
      }
    } catch { /* ignore */ }
  }

  // Edit events
  const editEventPattern = /```edit_event\s*([\s\S]*?)```/g;
  let eeMatch;
  while ((eeMatch = editEventPattern.exec(reply)) !== null) {
    try {
      const req = JSON.parse(eeMatch[1].trim());
      if (req.calendarId && req.eventId) {
        await updateEvent(userId, req.calendarId, req.eventId, {
          summary: req.summary,
          startIso: req.startIso,
          endIso: req.endIso,
          location: req.location,
          description: req.description,
        }, c.env);
        calendarActions.push(`Updated event ${req.eventId}`);
      }
    } catch { /* ignore */ }
  }

  // Delete events
  const deleteEventPattern = /```delete_event\s*([\s\S]*?)```/g;
  let deMatch;
  while ((deMatch = deleteEventPattern.exec(reply)) !== null) {
    try {
      const req = JSON.parse(deMatch[1].trim());
      if (req.calendarId && req.eventId) {
        await deleteEvent(userId, req.calendarId, req.eventId, c.env);
        calendarActions.push(`Deleted event ${req.eventId}`);
      }
    } catch { /* ignore */ }
  }

  // Strip all action blocks from the reply shown to user
  reply = reply.replace(/```save_context\s*[\s\S]*?```\n?/g, "").trim();
  reply = reply.replace(/```save_triage\s*[\s\S]*?```\n?/g, "").trim();
  reply = reply.replace(/```edit_triage\s*[\s\S]*?```\n?/g, "").trim();
  reply = reply.replace(/```search_web\s*[\s\S]*?```\n?/g, "").trim();
  reply = reply.replace(/```create_reminder\s*[\s\S]*?```\n?/g, "").trim();
  reply = reply.replace(/```create_event\s*[\s\S]*?```\n?/g, "").trim();
  reply = reply.replace(/```edit_event\s*[\s\S]*?```\n?/g, "").trim();
  reply = reply.replace(/```delete_event\s*[\s\S]*?```\n?/g, "").trim();

  // Persist user message and assistant reply to D1
  await c.env.DB.prepare(
    "INSERT INTO chat_messages (id, user_id, role, content) VALUES (?, ?, 'user', ?)"
  ).bind(crypto.randomUUID(), userId, body.message).run();

  await c.env.DB.prepare(
    "INSERT INTO chat_messages (id, user_id, role, content) VALUES (?, ?, 'assistant', ?)"
  ).bind(crypto.randomUUID(), userId, reply).run();

  return c.json({
    reply,
    savedContext: saved.length > 0 ? saved : undefined,
    createdItems: createdItems.length > 0 ? createdItems : undefined,
    editedItems: editedItems.length > 0 ? editedItems : undefined,
    calendarActions: calendarActions.length > 0 ? calendarActions : undefined,
  });
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

  // Check for past-due items
  const { results: pastDueItems } = await c.env.DB.prepare(
    `SELECT id, summary, due_at, event_at FROM triage_items
     WHERE user_id = ? AND status = 'open'
     AND (datetime(due_at) < datetime('now') OR datetime(event_at) < datetime('now'))
     LIMIT 3`
  )
    .bind(userId)
    .all<{ id: string; summary: string | null; due_at: string | null; event_at: string | null }>();

  let pastDueContext = "";
  if (pastDueItems.length > 0) {
    const lines = pastDueItems.map(
      (i) => `- [id:${i.id}] "${i.summary}" (was ${i.due_at || i.event_at})`
    );
    pastDueContext = `\nPast-due items that need follow-up:\n${lines.join("\n")}`;
  }

  const systemPrompt = `You are a personal assistant greeting the user when they open the app. Generate a brief, warm greeting (2-4 sentences max).

Include:
- A time-appropriate greeting${userName ? ` using their name "${userName}"` : ""}
- A quick status summary if there's anything notable${pastDueItems.length > 0 ? "\n- Ask about 1 past-due item: did it happen, or should we reschedule?" : ""}
- If context is missing (see below), you may ask ONE casual getting-to-know-you question

Current status:
- Open triage items: ${triageCount?.count || 0}
- High priority (Hot) items: ${hotCount?.count || 0}
- Pending calendar suggestions: ${pendingSuggestions}
- Current date/time: ${localTime}
- Time of day: ${timeOfDay}${pastDueContext}
${knownContext}

${contextRows.length === 0 ? "This appears to be a new user — introduce yourself briefly and ask their name." : ""}

Keep it concise and natural. Do NOT use save_context blocks in greetings.

IMPORTANT: When you ask about a past-due item, always mention its summary clearly so the user knows which item you mean. The conversation will continue in chat where the user can confirm — the chat handler has the IDs and can dismiss items. You do NOT need to include edit_triage blocks in greetings.`;

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

  // Persist greeting so follow-up chat has context
  await c.env.DB.prepare(
    "INSERT INTO chat_messages (id, user_id, role, content) VALUES (?, ?, 'assistant', ?)"
  ).bind(crypto.randomUUID(), userId, greeting).run();

  return c.json({ greeting });
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

  // Reverse so oldest first
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
