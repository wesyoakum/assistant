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
import { syncIcalFeed, listIcalEvents } from "../services/ical";

type CalendarApp = Hono<{ Bindings: Env; Variables: AuthVariables }>;

const calendar: CalendarApp = new Hono();

calendar.use("*", authMiddleware);

// List upcoming events from enabled calendars (Google + iCal merged)
calendar.get("/events", async (c) => {
  const userId = c.get("userId");

  const [googleEvents, icalEvents] = await Promise.allSettled([
    listUpcomingEvents(userId, c.env),
    listIcalEvents(userId, c.env),
  ]);

  const events = [
    ...(googleEvents.status === "fulfilled" ? googleEvents.value : []),
    ...(icalEvents.status === "fulfilled" ? icalEvents.value : []),
  ];

  events.sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
  );

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
// Suggestions disabled — classification pipeline paused
calendar.get("/suggestions", async (c) => {
  return c.json({ suggestions: [] });
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

// --- iCal feed management ---

// Add a new ICS feed
calendar.post("/feeds", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json()) as { url: string; name?: string };
  const url = body.url?.trim();
  if (!url) return c.json({ error: "url is required" }, 400);

  // Normalize webcal:// to https://
  const normalizedUrl = url.startsWith("webcal://")
    ? url.replace("webcal://", "https://")
    : url;

  const id = crypto.randomUUID();
  const name = body.name?.trim() || null;

  await c.env.DB.prepare(
    `INSERT INTO ical_feeds (id, user_id, url, name) VALUES (?, ?, ?, ?)`
  )
    .bind(id, userId, normalizedUrl, name)
    .run();

  // Immediately sync
  try {
    await syncIcalFeed(id, c.env);
  } catch (err) {
    // Feed is created but sync failed — that's okay, error_message is stored on the row
    console.error(`Initial iCal sync failed for feed ${id}:`, err);
  }

  const feed = await c.env.DB.prepare(
    "SELECT * FROM ical_feeds WHERE id = ?"
  )
    .bind(id)
    .first();

  return c.json({ ok: true, feed });
});

// List user's ICS feeds
calendar.get("/feeds", async (c) => {
  const userId = c.get("userId");
  const { results } = await c.env.DB.prepare(
    `SELECT id, url, name, color, enabled, last_synced_at, error_message, created_at
     FROM ical_feeds WHERE user_id = ? ORDER BY created_at DESC`
  )
    .bind(userId)
    .all();

  return c.json({ feeds: results });
});

// Remove an ICS feed (cascade deletes events via D1 FK)
calendar.delete("/feeds/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  const result = await c.env.DB.prepare(
    "DELETE FROM ical_feeds WHERE id = ? AND user_id = ?"
  )
    .bind(id, userId)
    .run();

  if (!result.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// Manual sync trigger for a specific feed
calendar.post("/feeds/:id/sync", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  // Verify ownership
  const feed = await c.env.DB.prepare(
    "SELECT id FROM ical_feeds WHERE id = ? AND user_id = ?"
  )
    .bind(id, userId)
    .first();

  if (!feed) return c.json({ error: "Not found" }, 404);

  try {
    await syncIcalFeed(id, c.env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Sync failed";
    return c.json({ error: msg }, 500);
  }

  return c.json({ ok: true });
});

export { calendar };
