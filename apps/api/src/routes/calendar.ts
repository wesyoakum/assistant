import { Hono } from "hono";
import type { Env } from "../index";
import type { AuthVariables } from "../middleware/auth";
import { authMiddleware } from "../middleware/auth";
import {
  listCalendars,
  listUpcomingEvents,
  setCalendarEnabled,
  subscribeCalendar,
  createEvent,
} from "../services/google-calendar";

type CalendarApp = Hono<{ Bindings: Env; Variables: AuthVariables }>;

const calendar: CalendarApp = new Hono();

calendar.use("*", authMiddleware);

// List upcoming events from enabled calendars
calendar.get("/events", async (c) => {
  const userId = c.get("userId");
  const events = await listUpcomingEvents(userId, c.env);
  return c.json({ events });
});

// List all calendars with enabled/disabled state
calendar.get("/calendars", async (c) => {
  const userId = c.get("userId");
  const calendars = await listCalendars(userId, c.env);
  return c.json({ calendars });
});

// Toggle a calendar's enabled state
calendar.post("/calendars/:id/toggle", async (c) => {
  const userId = c.get("userId");
  const calendarId = c.req.param("id");
  const body = (await c.req.json()) as { enabled: boolean };
  await setCalendarEnabled(userId, calendarId, body.enabled, c.env);
  return c.json({ ok: true });
});

// Subscribe to a calendar by ID or ICS URL
calendar.post("/calendars/subscribe", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json()) as { url: string };
  const input = body.url?.trim();
  if (!input) return c.json({ error: "URL or calendar ID required" }, 400);

  try {
    const cal = await subscribeCalendar(userId, input, c.env);
    return c.json({ ok: true, calendar: cal });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Subscribe failed";
    return c.json({ error: msg }, 400);
  }
});

// Set a calendar alias/nickname
calendar.post("/calendars/:id/alias", async (c) => {
  const userId = c.get("userId");
  const calendarId = c.req.param("id");
  const body = (await c.req.json()) as { alias: string | null };
  const alias = body.alias?.trim() || null;

  await c.env.DB.prepare(
    `INSERT INTO user_calendar_prefs (user_id, calendar_id, enabled, alias, updated_at)
     VALUES (?, ?, 1, ?, datetime('now'))
     ON CONFLICT (user_id, calendar_id)
     DO UPDATE SET alias = excluded.alias, updated_at = datetime('now')`
  )
    .bind(userId, calendarId, alias)
    .run();

  return c.json({ ok: true });
});

// List pending calendar suggestions
calendar.get("/suggestions", async (c) => {
  const userId = c.get("userId");
  const { results } = await c.env.DB.prepare(
    `SELECT cs.*, ti.summary as triage_summary
     FROM calendar_suggestions cs
     LEFT JOIN triage_items ti ON ti.id = cs.triage_item_id
     WHERE cs.user_id = ? AND cs.status = 'pending'
     ORDER BY cs.created_at DESC`
  )
    .bind(userId)
    .all();
  return c.json({ suggestions: results });
});

// Accept a suggestion — creates a Google Calendar event
calendar.post("/suggestions/:id/accept", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  const suggestion = await c.env.DB.prepare(
    "SELECT * FROM calendar_suggestions WHERE id = ? AND user_id = ? AND status = 'pending'"
  )
    .bind(id, userId)
    .first<{
      id: string;
      title: string;
      start_iso: string;
      end_iso: string;
      location: string | null;
    }>();

  if (!suggestion) return c.json({ error: "Not found" }, 404);

  const event = await createEvent(userId, {
    title: suggestion.title,
    startIso: suggestion.start_iso,
    endIso: suggestion.end_iso,
    location: suggestion.location || undefined,
  }, c.env);

  await c.env.DB.prepare(
    "UPDATE calendar_suggestions SET status = 'accepted', google_event_id = ? WHERE id = ?"
  )
    .bind(event.id, id)
    .run();

  return c.json({ ok: true, googleEventId: event.id, htmlLink: event.htmlLink });
});

// Reject a suggestion
calendar.post("/suggestions/:id/reject", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  const result = await c.env.DB.prepare(
    "UPDATE calendar_suggestions SET status = 'rejected' WHERE id = ? AND user_id = ? AND status = 'pending'"
  )
    .bind(id, userId)
    .run();

  if (!result.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// Create an event directly
calendar.post("/events", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json()) as {
    title: string;
    startIso: string;
    endIso: string;
    location?: string;
    description?: string;
  };

  if (!body.title || !body.startIso || !body.endIso) {
    return c.json({ error: "title, startIso, endIso required" }, 400);
  }

  const event = await createEvent(userId, body, c.env);
  return c.json({ ok: true, googleEventId: event.id, htmlLink: event.htmlLink });
});

export { calendar };
