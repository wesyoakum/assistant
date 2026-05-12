import { Hono } from "hono";
import type { Env } from "../index";
import type { AuthVariables } from "../middleware/auth";
import { authMiddleware } from "../middleware/auth";
import {
  listCalendars,
  listUpcomingEvents,
  setCalendarEnabled,
  subscribeCalendar,
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

export { calendar };
