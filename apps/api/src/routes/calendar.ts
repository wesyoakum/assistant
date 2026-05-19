import { Hono } from "hono";
import type { Env } from "../index";
import type { AuthVariables } from "../middleware/auth";
import { authMiddleware } from "../middleware/auth";
import {
  listCalendars,
  listUpcomingEvents,
  subscribeCalendar,
  createEvent,
} from "../services/google-calendar";
import { syncIcalFeed, listIcalEvents } from "../services/ical";

type CalendarApp = Hono<{ Bindings: Env; Variables: AuthVariables }>;

const calendar: CalendarApp = new Hono();

calendar.use("*", authMiddleware);

// List upcoming events from Google + iCal feeds, merged.
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

// List all Google calendars.
calendar.get("/calendars", async (c) => {
  const userId = c.get("userId");
  const calendars = await listCalendars(userId, c.env);
  return c.json({ calendars });
});

// Subscribe to a calendar by ID or ICS URL.
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

// Create an event directly.
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

calendar.post("/feeds", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json()) as { url: string; name?: string };
  const url = body.url?.trim();
  if (!url) return c.json({ error: "url is required" }, 400);

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

  try {
    await syncIcalFeed(id, c.env);
  } catch (err) {
    console.error(`Initial iCal sync failed for feed ${id}:`, err);
  }

  const feed = await c.env.DB.prepare(
    "SELECT * FROM ical_feeds WHERE id = ?"
  )
    .bind(id)
    .first();

  return c.json({ ok: true, feed });
});

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

calendar.post("/feeds/:id/sync", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

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
