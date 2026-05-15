// @ts-ignore — ical.js has no bundled types
import ICAL from "ical.js";
import type { Env } from "../index";
import type { CalendarEvent } from "./google-calendar";

interface IcalFeedRow {
  id: string;
  user_id: string;
  url: string;
  name: string | null;
  color: string;
  enabled: number;
  last_etag: string | null;
}

interface IcalEventRow {
  id: string;
  feed_id: string;
  uid: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  start_iso: string;
  end_iso: string;
  all_day: number;
}

/**
 * Fetch and parse an ICS feed, upserting events into ical_events.
 * Removes events that are no longer present in the feed.
 */
export async function syncIcalFeed(feedId: string, env: Env): Promise<void> {
  const feed = await env.DB.prepare(
    "SELECT id, user_id, url, name, color, enabled, last_etag FROM ical_feeds WHERE id = ?"
  )
    .bind(feedId)
    .first<IcalFeedRow>();

  if (!feed) throw new Error(`iCal feed not found: ${feedId}`);

  // Build request with conditional fetch
  const headers: Record<string, string> = {};
  if (feed.last_etag) {
    headers["If-None-Match"] = feed.last_etag;
  }

  let res: Response;
  try {
    res = await fetch(feed.url, { headers });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Fetch failed";
    await env.DB.prepare(
      "UPDATE ical_feeds SET error_message = ?, updated_at = datetime('now') WHERE id = ?"
    )
      .bind(msg, feedId)
      .run();
    return;
  }

  // 304 Not Modified — nothing to do
  if (res.status === 304) {
    await env.DB.prepare(
      "UPDATE ical_feeds SET last_synced_at = datetime('now'), error_message = NULL, updated_at = datetime('now') WHERE id = ?"
    )
      .bind(feedId)
      .run();
    return;
  }

  if (!res.ok) {
    const msg = `HTTP ${res.status}: ${res.statusText}`;
    await env.DB.prepare(
      "UPDATE ical_feeds SET error_message = ?, updated_at = datetime('now') WHERE id = ?"
    )
      .bind(msg, feedId)
      .run();
    return;
  }

  const etag = res.headers.get("etag") || null;
  const text = await res.text();

  let parsedUids: Set<string>;
  try {
    const jcal = ICAL.parse(text);
    const comp = new ICAL.Component(jcal);
    const vevents = comp.getAllSubcomponents("vevent");

    parsedUids = new Set<string>();

    for (const vevent of vevents) {
      const event = new ICAL.Event(vevent);
      const uid = event.uid;
      if (!uid) continue;

      parsedUids.add(uid);

      const startDate = event.startDate?.toJSDate();
      const endDate = event.endDate?.toJSDate();
      if (!startDate || !endDate) continue;

      const allDay = event.startDate?.isDate ? 1 : 0;
      const summary = event.summary || null;
      const description = vevent.getFirstPropertyValue("description") || null;
      const location = vevent.getFirstPropertyValue("location") || null;

      const startIso = startDate.toISOString();
      const endIso = endDate.toISOString();

      // Upsert: insert or update by (feed_id, uid) unique constraint
      await env.DB.prepare(
        `INSERT INTO ical_events (id, feed_id, user_id, uid, summary, description, location, start_iso, end_iso, all_day, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT (feed_id, uid)
         DO UPDATE SET summary = excluded.summary, description = excluded.description,
           location = excluded.location, start_iso = excluded.start_iso, end_iso = excluded.end_iso,
           all_day = excluded.all_day, updated_at = datetime('now')`
      )
        .bind(
          crypto.randomUUID(),
          feedId,
          feed.user_id,
          uid,
          summary,
          description,
          location,
          startIso,
          endIso,
          allDay
        )
        .run();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Parse failed";
    await env.DB.prepare(
      "UPDATE ical_feeds SET error_message = ?, updated_at = datetime('now') WHERE id = ?"
    )
      .bind(`Parse error: ${msg}`, feedId)
      .run();
    return;
  }

  // Remove events no longer in the feed
  const { results: existing } = await env.DB.prepare(
    "SELECT id, uid FROM ical_events WHERE feed_id = ?"
  )
    .bind(feedId)
    .all<{ id: string; uid: string }>();

  for (const row of existing) {
    if (!parsedUids.has(row.uid)) {
      await env.DB.prepare("DELETE FROM ical_events WHERE id = ?")
        .bind(row.id)
        .run();
    }
  }

  // Update feed metadata
  await env.DB.prepare(
    `UPDATE ical_feeds SET last_synced_at = datetime('now'), last_etag = ?,
     error_message = NULL, updated_at = datetime('now') WHERE id = ?`
  )
    .bind(etag, feedId)
    .run();
}

/**
 * List upcoming iCal events for a user as CalendarEvent objects.
 */
export async function listIcalEvents(
  userId: string,
  env: Env,
  days = 14
): Promise<CalendarEvent[]> {
  const now = new Date().toISOString();
  const future = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  const { results } = await env.DB.prepare(
    `SELECT e.id, e.feed_id, e.summary, e.description, e.location,
            e.start_iso, e.end_iso, e.all_day, e.created_at, e.updated_at,
            f.name AS feed_name, f.color AS feed_color
     FROM ical_events e
     JOIN ical_feeds f ON f.id = e.feed_id
     WHERE e.user_id = ? AND f.enabled = 1
       AND e.end_iso >= ? AND e.start_iso <= ?
     ORDER BY e.start_iso ASC`
  )
    .bind(userId, now, future)
    .all<{
      id: string;
      feed_id: string;
      summary: string | null;
      description: string | null;
      location: string | null;
      start_iso: string;
      end_iso: string;
      all_day: number;
      created_at: string | null;
      updated_at: string | null;
      feed_name: string | null;
      feed_color: string | null;
    }>();

  return results.map((row) => ({
    id: `ical_${row.id}`,
    calendarId: `ical_${row.feed_id}`,
    summary: row.summary || "(No title)",
    description: row.description || null,
    location: row.location || null,
    start: row.start_iso,
    end: row.end_iso,
    allDay: row.all_day === 1,
    htmlLink: "",
    status: "confirmed",
    organizer: null,
    responseStatus: null,
    calendarName: row.feed_name || "iCal Feed",
    created: row.created_at || null,
    updated: row.updated_at || null,
  }));
}
