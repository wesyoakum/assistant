// Trail — family GPS tracker API. Backed by the TRAIL KV namespace.
//
// KV layout:
//   user:<key>     { username, alias, claimed, invitedBy, created }   meta { username, alias, claimed }
//   uname:<name>   <key>                                              (username uniqueness guard)
//   act:<id>       { id, username, start, end, dist, moving, max, points[] }
//                                                                    meta { username, start, dist, moving, max, n }
//
// The invite key *is* the identity: an unclaimed key is an invite; claiming it
// stores username + alias against it.

export interface TrailEnv {
  TRAIL: KVNamespace;
  ORS_API_KEY?: string; // openrouteservice.org key, set with `wrangler secret put ORS_API_KEY`
}

// Routes to follow: route:<id> { id, username, name, mode, dist, points[{lat,lon}], steps[], created }
//                   meta { username, name, mode, dist, n, created }
interface RouteMeta {
  username: string;
  name: string;
  mode: string;
  dist: number;
  n: number;
  created: number;
}

const ORS_PROFILES: Record<string, string> = {
  walk: "foot-walking",
  bike: "cycling-regular",
  drive: "driving-car",
};
const MAX_ROUTE_POINTS = 20000;

interface User {
  username?: string;
  alias?: string;
  claimed: boolean;
  invitedBy?: string;
  created: number;
}

interface ActMeta {
  username: string;
  start: number;
  dist: number;
  moving: number;
  max: number;
  n: number;
}

const USERNAME_RE = /^[a-z0-9_]{2,20}$/;
const MAX_POINTS = 50000;

const json = (data: unknown, status = 200) => Response.json(data, { status });
const err = (message: string, status: number) => json({ error: message }, status);

// Keys avoid look-alike characters (0/o, 1/l/i) so links survive being typed
// or read aloud. 20 chars from a 31-symbol alphabet is ~99 bits of entropy.
const KEY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
function newKey(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += KEY_ALPHABET[b % KEY_ALPHABET.length];
  return s;
}

// Tolerate whatever a messaging app or a hand-typed URL did to the key.
export function normalizeKey(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, "").toLowerCase();
}

function userMeta(u: User) {
  return { username: u.username, alias: u.alias, claimed: u.claimed };
}

async function putUser(env: TrailEnv, key: string, u: User) {
  await env.TRAIL.put(`user:${key}`, JSON.stringify(u), { metadata: userMeta(u) });
}

async function auth(request: Request, env: TrailEnv): Promise<{ key: string; user: User } | null> {
  const h = request.headers.get("Authorization") || "";
  const key = h.startsWith("Bearer ") ? normalizeKey(h.slice(7)) : "";
  if (!key || key.length > 64) return null;
  const raw = await env.TRAIL.get(`user:${key}`);
  if (!raw) return null;
  return { key, user: JSON.parse(raw) as User };
}

export async function handleTrail(request: Request, env: TrailEnv, url: URL): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  const a = await auth(request, env);
  if (!a) return err("Unknown or missing key", 401);
  const { key, user } = a;
  const path = url.pathname.replace(/^\/api\/trail/, "");
  const m = request.method;

  try {
    if (path === "/me" && m === "GET") {
      return json(user.claimed ? { claimed: true, username: user.username, alias: user.alias } : { claimed: false });
    }

    if (path === "/claim" && m === "POST") {
      if (user.claimed) return err("Already claimed", 409);
      const body = (await request.json()) as { username?: string; alias?: string };
      const username = String(body.username || "").trim().toLowerCase();
      const alias = String(body.alias || "").trim().slice(0, 30) || username;
      if (!USERNAME_RE.test(username)) return err("Username must be 2-20 characters: a-z, 0-9, _", 400);
      if (await env.TRAIL.get(`uname:${username}`)) return err("That username is taken", 409);
      await env.TRAIL.put(`uname:${username}`, key);
      const updated: User = { ...user, username, alias, claimed: true };
      await putUser(env, key, updated);
      return json({ claimed: true, username, alias });
    }

    // Everything below needs a claimed user.
    if (!user.claimed || !user.username) return err("Claim this invite first", 403);

    if (path === "/me" && m === "PATCH") {
      const body = (await request.json()) as { alias?: string };
      const alias = String(body.alias || "").trim().slice(0, 30);
      if (!alias) return err("Alias can't be empty", 400);
      const updated: User = { ...user, alias };
      await putUser(env, key, updated);
      return json({ claimed: true, username: user.username, alias });
    }

    if (path === "/invite" && m === "POST") {
      const k = newKey();
      await putUser(env, k, { claimed: false, invitedBy: user.username, created: Date.now() });
      const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
      const origin = local ? url.origin : `https://${url.host}`;
      return json({ key: k, url: `${origin}/trail/?k=${k}` });
    }

    if (path === "/activities" && m === "GET") {
      const [users, acts] = await Promise.all([listUsers(env), listActs(env)]);
      return json({ users, activities: acts });
    }

    if (path === "/activities" && m === "POST") {
      const body = (await request.json()) as Record<string, unknown>;
      const act = sanitizeActivity(body, user.username);
      if (!act) return err("Invalid activity", 400);
      const existing = await env.TRAIL.getWithMetadata<ActMeta>(`act:${act.id}`);
      if (existing.value && existing.metadata?.username !== user.username) return err("ID belongs to another user", 409);
      const meta: ActMeta = { username: user.username, start: act.start, dist: act.dist, moving: act.moving, max: act.max, n: act.points.length };
      await env.TRAIL.put(`act:${act.id}`, JSON.stringify(act), { metadata: meta });
      return json({ ok: true, id: act.id });
    }

    const actMatch = path.match(/^\/activities\/([A-Za-z0-9_-]{1,40})$/);
    if (actMatch && m === "GET") {
      const raw = await env.TRAIL.get(`act:${actMatch[1]}`);
      if (!raw) return err("Not found", 404);
      return new Response(raw, { headers: { "Content-Type": "application/json" } });
    }

    if (actMatch && m === "DELETE") {
      const k = `act:${actMatch[1]}`;
      const existing = await env.TRAIL.getWithMetadata<ActMeta>(k);
      if (!existing.value) return err("Not found", 404);
      if (existing.metadata?.username !== user.username) return err("Not your activity", 403);
      await env.TRAIL.delete(k);
      return json({ ok: true });
    }

    // ---- routes to follow ----
    if (path === "/routes" && m === "GET") {
      const [users, routes] = await Promise.all([listUsers(env), listRoutes(env)]);
      return json({ users, routes });
    }

    if (path === "/routes" && m === "POST") {
      const body = (await request.json()) as Record<string, unknown>;
      const route = sanitizeRoute(body, user.username);
      if (!route) return err("Invalid route", 400);
      const existing = await env.TRAIL.getWithMetadata<RouteMeta>(`route:${route.id}`);
      if (existing.value && existing.metadata?.username !== user.username) return err("ID belongs to another user", 409);
      const meta: RouteMeta = { username: user.username, name: route.name, mode: route.mode, dist: route.dist, n: route.points.length, created: route.created };
      await env.TRAIL.put(`route:${route.id}`, JSON.stringify(route), { metadata: meta });
      return json({ ok: true, id: route.id });
    }

    const routeMatch = path.match(/^\/routes\/([A-Za-z0-9_-]{1,40})$/);
    if (routeMatch && m === "GET") {
      const raw = await env.TRAIL.get(`route:${routeMatch[1]}`);
      if (!raw) return err("Not found", 404);
      return new Response(raw, { headers: { "Content-Type": "application/json" } });
    }

    if (routeMatch && m === "PATCH") {
      const k = `route:${routeMatch[1]}`;
      const existing = await env.TRAIL.getWithMetadata<RouteMeta>(k);
      if (!existing.value) return err("Not found", 404);
      if (existing.metadata?.username !== user.username) return err("Not your route", 403);
      const body = (await request.json()) as { name?: string };
      const name = String(body.name || "").trim().slice(0, 60);
      if (!name) return err("Name can't be empty", 400);
      const route = JSON.parse(existing.value);
      route.name = name;
      await env.TRAIL.put(k, JSON.stringify(route), { metadata: { ...existing.metadata!, name } });
      return json({ ok: true });
    }

    if (routeMatch && m === "DELETE") {
      const k = `route:${routeMatch[1]}`;
      const existing = await env.TRAIL.getWithMetadata<RouteMeta>(k);
      if (!existing.value) return err("Not found", 404);
      if (existing.metadata?.username !== user.username) return err("Not your route", 403);
      await env.TRAIL.delete(k);
      return json({ ok: true });
    }

    // ---- directions + geocoding (proxied so the ORS key never reaches the page) ----
    if (path === "/directions" && m === "POST") {
      if (!env.ORS_API_KEY) return err("Directions aren't set up yet (no routing key on the server)", 503);
      const body = (await request.json()) as { coords?: unknown; mode?: string };
      const profile = ORS_PROFILES[String(body.mode || "walk")];
      if (!profile) return err("mode must be walk, bike or drive", 400);
      const coords = Array.isArray(body.coords) ? body.coords : [];
      const pairs = coords
        .map((c: any) => [num(c?.lon, NaN), num(c?.lat, NaN)])
        .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (pairs.length < 2 || pairs.length > 50) return err("Need 2-50 coordinates", 400);
      return orsDirections(env.ORS_API_KEY, profile, pairs);
    }

    if (path === "/geocode" && m === "GET") {
      if (!env.ORS_API_KEY) return err("Address search isn't set up yet (no routing key on the server)", 503);
      const q = (url.searchParams.get("q") || "").trim().slice(0, 200);
      const lat = num(url.searchParams.get("lat"), NaN);
      const lon = num(url.searchParams.get("lon"), NaN);
      if (q) return orsGeocode(env.ORS_API_KEY, q, lat, lon);
      if (Number.isFinite(lat) && Number.isFinite(lon)) return orsReverse(env.ORS_API_KEY, lat, lon);
      return err("Pass q, or lat and lon", 400);
    }

    return err("Not found", 404);
  } catch (e: any) {
    return err(e?.message || "Server error", 500);
  }
}

async function listRoutes(env: TrailEnv) {
  const out: (RouteMeta & { id: string })[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.TRAIL.list<RouteMeta>({ prefix: "route:", cursor });
    for (const k of page.keys) {
      if (k.metadata) out.push({ id: k.name.slice(6), ...k.metadata });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  out.sort((x, y) => y.created - x.created);
  return out;
}

function sanitizeRoute(body: Record<string, unknown>, username: string) {
  const id = String(body.id ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return null;
  const name = String(body.name ?? "").trim().slice(0, 60) || "Route";
  const mode = ["walk", "bike", "drive", "draw", "track"].includes(String(body.mode)) ? String(body.mode) : "draw";
  const pts = Array.isArray(body.points) ? body.points : [];
  if (pts.length < 2 || pts.length > MAX_ROUTE_POINTS) return null;
  const points = pts
    .map((p: any) => ({ lat: num(p?.lat, NaN), lon: num(p?.lon, NaN) }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (points.length < 2) return null;
  const rawSteps = Array.isArray(body.steps) ? body.steps.slice(0, 500) : [];
  const steps = rawSteps
    .map((s: any) => ({ text: String(s?.text ?? "").slice(0, 200), dist: num(s?.dist), at: Math.max(0, Math.min(points.length - 1, Math.round(num(s?.at)))) }))
    .filter((s) => s.text);
  return { id, username, name, mode, dist: num(body.dist), points, steps, created: Date.now() };
}

async function orsDirections(key: string, profile: string, pairs: number[][]): Promise<Response> {
  const r = await fetch(`https://api.openrouteservice.org/v2/directions/${profile}/geojson`, {
    method: "POST",
    headers: { Authorization: key, "Content-Type": "application/json", Accept: "application/geo+json" },
    body: JSON.stringify({ coordinates: pairs, instructions: true, elevation: false }),
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) return err(orsError(data, r.status), 502);
  const f = data?.features?.[0];
  if (!f) return err("No route found", 502);
  const points = (f.geometry?.coordinates || []).map((c: number[]) => ({ lat: c[1], lon: c[0] }));
  const steps: { text: string; dist: number; at: number }[] = [];
  for (const seg of f.properties?.segments || []) {
    for (const s of seg.steps || []) steps.push({ text: s.instruction, dist: s.distance, at: s.way_points?.[0] ?? 0 });
  }
  return json({ points, dist: f.properties?.summary?.distance ?? 0, duration: f.properties?.summary?.duration ?? 0, steps });
}

async function orsGeocode(key: string, q: string, lat: number, lon: number): Promise<Response> {
  const p = new URLSearchParams({ api_key: key, text: q, size: "6" });
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    p.set("focus.point.lat", String(lat));
    p.set("focus.point.lon", String(lon));
  }
  const r = await fetch(`https://api.openrouteservice.org/geocode/search?${p}`);
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) return err(orsError(data, r.status), 502);
  return json({ results: geoFeatures(data) });
}

async function orsReverse(key: string, lat: number, lon: number): Promise<Response> {
  const p = new URLSearchParams({ api_key: key, "point.lat": String(lat), "point.lon": String(lon), size: "1" });
  const r = await fetch(`https://api.openrouteservice.org/geocode/reverse?${p}`);
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) return err(orsError(data, r.status), 502);
  return json({ results: geoFeatures(data) });
}

function geoFeatures(data: any) {
  return (data?.features || []).map((f: any) => ({
    label: String(f.properties?.label || f.properties?.name || ""),
    lat: f.geometry?.coordinates?.[1],
    lon: f.geometry?.coordinates?.[0],
  })).filter((x: any) => x.label && Number.isFinite(x.lat) && Number.isFinite(x.lon));
}

function orsError(data: any, status: number): string {
  const msg = data?.error?.message || data?.error || data?.message;
  if (status === 401 || status === 403) return "Routing key was rejected by openrouteservice";
  if (status === 429) return "Routing quota used up for today";
  if (typeof msg === "string" && /could not find routable point|Could not find point/i.test(msg)) return "No road or path near one of those points";
  return typeof msg === "string" ? msg : `Routing service error (${status})`;
}

async function listUsers(env: TrailEnv) {
  const out: { username: string; alias: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.TRAIL.list<{ username?: string; alias?: string; claimed?: boolean }>({ prefix: "user:", cursor });
    for (const k of page.keys) {
      const md = k.metadata;
      if (md?.claimed && md.username) out.push({ username: md.username, alias: md.alias || md.username });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  out.sort((x, y) => x.alias.localeCompare(y.alias));
  return out;
}

async function listActs(env: TrailEnv) {
  const out: (ActMeta & { id: string })[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.TRAIL.list<ActMeta>({ prefix: "act:", cursor });
    for (const k of page.keys) {
      if (k.metadata) out.push({ id: k.name.slice(4), ...k.metadata });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  out.sort((x, y) => y.start - x.start);
  return out;
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function sanitizeActivity(body: Record<string, unknown>, username: string) {
  const id = String(body.id ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return null;
  const pts = Array.isArray(body.points) ? body.points : [];
  if (pts.length > MAX_POINTS) return null;
  const points = pts
    .map((p: any) => ({
      lat: num(p?.lat, NaN),
      lon: num(p?.lon, NaN),
      t: num(p?.t, NaN),
      acc: p?.acc != null ? num(p.acc) : undefined,
      alt: p?.alt != null ? num(p.alt) : undefined,
      spd: p?.spd != null ? num(p.spd) : undefined,
    }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.t));
  const start = num(body.start, points[0]?.t ?? Date.now());
  const routeId = typeof body.routeId === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(body.routeId) ? body.routeId : undefined;
  return {
    id,
    username,
    routeId,
    start,
    end: num(body.end, points[points.length - 1]?.t ?? start),
    dist: num(body.dist),
    moving: num(body.moving),
    max: num(body.max),
    points,
  };
}
