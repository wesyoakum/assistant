import { Hono } from "hono";
import type { Env } from "../index";
import type { AuthVariables } from "../middleware/auth";
import { authMiddleware } from "../middleware/auth";
import {
  listCalendars,
  listUpcomingEvents,
  setCalendarEnabled,
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

export { calendar };
