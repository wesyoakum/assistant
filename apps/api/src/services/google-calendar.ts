import { getValidAccessToken, TokenExpiredError } from "./gmail";
import type { Env } from "../index";

const CAL_API = "https://www.googleapis.com/calendar/v3";

export interface CalendarSummary {
  id: string;
  summary: string;
  alias: string | null;
  displayName: string;
  primary: boolean;
  backgroundColor: string;
  enabled: boolean;
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  summary: string;
  description: string | null;
  location: string | null;
  start: string; // ISO
  end: string;   // ISO
  allDay: boolean;
  htmlLink: string;
  status: string;
  organizer: string | null;
  responseStatus: string | null;
  calendarName: string;
  created: string | null;
  updated: string | null;
}

// --- Google API response types ---

interface GCalListEntry {
  id: string;
  summary: string;
  primary?: boolean;
  backgroundColor?: string;
}

interface GCalEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  htmlLink?: string;
  status?: string;
  created?: string;
  updated?: string;
  organizer?: { email?: string; displayName?: string };
  attendees?: { email?: string; self?: boolean; responseStatus?: string }[];
}

// --- Public functions ---

export async function listCalendars(
  userId: string,
  env: Env
): Promise<CalendarSummary[]> {
  const accessToken = await getValidAccessToken(userId, env);

  const res = await fetch(`${CAL_API}/users/me/calendarList`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Calendar list failed: ${res.status}`);

  const data = (await res.json()) as { items?: GCalListEntry[] };
  const calendars = data.items || [];

  return calendars.map((cal) => ({
    id: cal.id,
    summary: cal.summary,
    alias: null,
    displayName: cal.summary,
    primary: !!cal.primary,
    backgroundColor: cal.backgroundColor || "#4285F4",
    enabled: true,
  }));
}

/**
 * Subscribe to a calendar by Google Calendar ID or ICS URL.
 * Google treats ICS URLs as calendar IDs when inserted via calendarList.
 */
export async function subscribeCalendar(
  userId: string,
  input: string,
  env: Env
): Promise<CalendarSummary> {
  const accessToken = await getValidAccessToken(userId, env);

  // Normalize webcal:// to https://
  let calendarId = input;
  if (input.startsWith("webcal://")) {
    calendarId = input.replace("webcal://", "https://");
  }

  const res = await fetch(`${CAL_API}/users/me/calendarList`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: calendarId }),
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 409) {
      throw new Error("Calendar already added");
    }
    if ((input.includes(".ics") || input.startsWith("http")) && res.status === 404) {
      throw new Error("Could not subscribe. Make sure it's a valid iCal/ICS feed URL or a Google Calendar ID.");
    }
    throw new Error(`Google API error ${res.status}: ${body}`);
  }

  const cal = (await res.json()) as GCalListEntry;

  return {
    id: cal.id,
    summary: cal.summary,
    alias: null,
    displayName: cal.summary,
    primary: !!cal.primary,
    backgroundColor: cal.backgroundColor || "#4285F4",
    enabled: true,
  };
}

export async function listUpcomingEvents(
  userId: string,
  env: Env,
  daysAhead = 14,
  maxPerCalendar = 25
): Promise<CalendarEvent[]> {
  const accessToken = await getValidAccessToken(userId, env);
  const calendars = await listCalendars(userId, env);
  const enabled = calendars.filter((c) => c.enabled);

  const timeMin = new Date().toISOString();
  const timeMax = new Date(
    Date.now() + daysAhead * 24 * 60 * 60 * 1000
  ).toISOString();

  const results = await Promise.allSettled(
    enabled.map(async (cal) => {
      const params = new URLSearchParams({
        timeMin,
        timeMax,
        maxResults: String(maxPerCalendar),
        singleEvents: "true",
        orderBy: "startTime",
      });

      const res = await fetch(
        `${CAL_API}/calendars/${encodeURIComponent(cal.id)}/events?${params}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!res.ok) return [];

      const data = (await res.json()) as { items?: GCalEvent[] };
      return (data.items || []).map((evt) =>
        toCalendarEvent(evt, cal.id, cal.displayName)
      );
    })
  );

  const events: CalendarEvent[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") events.push(...r.value);
  }

  events.sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
  );

  return events;
}

/**
 * Create an event on the user's primary calendar.
 */
export async function createEvent(
  userId: string,
  event: { title: string; startIso: string; endIso: string; location?: string; description?: string },
  env: Env
): Promise<{ id: string; htmlLink: string }> {
  const accessToken = await getValidAccessToken(userId, env);

  const body: Record<string, unknown> = {
    summary: event.title,
    start: { dateTime: event.startIso },
    end: { dateTime: event.endIso },
  };
  if (event.location) body.location = event.location;
  if (event.description) body.description = event.description;

  const res = await fetch(
    `${CAL_API}/calendars/primary/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Create event failed ${res.status}: ${err}`);
  }

  const data = (await res.json()) as { id: string; htmlLink: string };
  return { id: data.id, htmlLink: data.htmlLink };
}

function toCalendarEvent(evt: GCalEvent, calendarId: string, calendarName: string): CalendarEvent {
  const allDay = !evt.start?.dateTime;
  return {
    id: evt.id,
    calendarId,
    summary: evt.summary || "(No title)",
    description: evt.description || null,
    location: evt.location || null,
    start: evt.start?.dateTime || evt.start?.date || "",
    end: evt.end?.dateTime || evt.end?.date || "",
    allDay,
    htmlLink: evt.htmlLink || "",
    status: evt.status || "confirmed",
    organizer: evt.organizer?.displayName || evt.organizer?.email || null,
    responseStatus:
      evt.attendees?.find((a) => a.self)?.responseStatus || null,
    calendarName,
    created: evt.created || null,
    updated: evt.updated || null,
  };
}
