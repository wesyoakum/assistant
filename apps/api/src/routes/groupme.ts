import { Hono } from "hono";
import type { Env } from "../index";
import type { AuthVariables } from "../middleware/auth";
import { authMiddleware } from "../middleware/auth";
import { verifyJwt } from "../services/jwt";
import {
  storeToken,
  getToken,
  deleteToken,
  getMe,
  listGroups,
  listMessages,
  GroupMeNotConnectedError,
} from "../services/groupme";

const GROUPME_AUTH_URL = "https://oauth.groupme.com/oauth/authorize";
const GROUPME_REDIRECT_URI = "https://api.whyapp.us/groupme/callback";

type GroupMeApp = Hono<{ Bindings: Env; Variables: AuthVariables }>;

const groupme: GroupMeApp = new Hono();

// ---- OAuth start ---------------------------------------------------------
// Browser flow: open in a WebBrowser session with ?token=<session_jwt>.
// We embed the JWT into `state` so the callback can identify the user, since
// GroupMe round-trips the `state` query param to the redirect URI.
groupme.get("/connect", async (c) => {
  const token = c.req.query("token");
  if (!token) return c.json({ error: "missing token" }, 400);
  const payload = await verifyJwt(token, c.env.SESSION_JWT_SECRET);
  if (!payload) return c.json({ error: "invalid token" }, 401);
  if (!c.env.GROUPME_CLIENT_ID) {
    return c.json({ error: "GROUPME_CLIENT_ID not configured" }, 500);
  }

  const returnUrl = c.req.query("return_url") || "whyapp://groupme";
  const state = btoa(JSON.stringify({ jwt: token, return_url: returnUrl }));

  const params = new URLSearchParams({
    client_id: c.env.GROUPME_CLIENT_ID,
    state,
  });
  return c.redirect(`${GROUPME_AUTH_URL}?${params.toString()}`);
});

// ---- OAuth callback ------------------------------------------------------
// GroupMe redirects here with ?access_token=...&state=...
groupme.get("/callback", async (c) => {
  const accessToken = c.req.query("access_token");
  const stateParam = c.req.query("state");
  const error = c.req.query("error");

  let returnUrl = "whyapp://groupme";
  let jwt: string | null = null;
  if (stateParam) {
    try {
      const decoded = JSON.parse(atob(stateParam)) as { jwt?: string; return_url?: string };
      if (decoded.return_url) returnUrl = decoded.return_url;
      if (decoded.jwt) jwt = decoded.jwt;
    } catch {
      // fall through
    }
  }

  const redirect = (params: string) => {
    const sep = returnUrl.includes("?") ? "&" : "?";
    return c.redirect(`${returnUrl}${sep}${params}`);
  };

  if (error || !accessToken) {
    return redirect(`error=${error || "no_token"}`);
  }
  if (!jwt) {
    return redirect("error=missing_state");
  }

  const payload = await verifyJwt(jwt, c.env.SESSION_JWT_SECRET);
  if (!payload) return redirect("error=invalid_state");

  // Look up the GroupMe identity for nice display, but don't fail if it errors.
  let groupmeUserId: string | undefined;
  let groupmeName: string | undefined;
  try {
    const me = await getMe(accessToken);
    groupmeUserId = me.id;
    groupmeName = me.name;
  } catch {
    // continue
  }

  await storeToken(payload.sub, accessToken, c.env, groupmeUserId, groupmeName);
  return redirect(`groupme=connected${groupmeName ? `&name=${encodeURIComponent(groupmeName)}` : ""}`);
});

// ---- Everything below requires an app session ----------------------------
groupme.use("/token", authMiddleware);
groupme.use("/status", authMiddleware);
groupme.use("/me", authMiddleware);
groupme.use("/groups", authMiddleware);
groupme.use("/groups/*", authMiddleware);
groupme.use("/", authMiddleware);

// Paste-an-access-token path — for the dev token shown on dev.groupme.com.
groupme.post("/token", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => null)) as { access_token?: string } | null;
  const accessToken = body?.access_token?.trim();
  if (!accessToken) return c.json({ error: "access_token required" }, 400);

  let groupmeUserId: string | undefined;
  let groupmeName: string | undefined;
  try {
    const me = await getMe(accessToken);
    groupmeUserId = me.id;
    groupmeName = me.name;
  } catch (err) {
    return c.json({ error: "token rejected by GroupMe", detail: String(err) }, 400);
  }

  await storeToken(userId, accessToken, c.env, groupmeUserId, groupmeName);
  return c.json({ ok: true, groupme_user_id: groupmeUserId, groupme_name: groupmeName });
});

// Quick "am I connected?" probe — doesn't hit GroupMe.
groupme.get("/status", async (c) => {
  const userId = c.get("userId");
  const row = await c.env.DB.prepare(
    "SELECT groupme_user_id, groupme_name, created_at FROM groupme_tokens WHERE user_id = ?",
  )
    .bind(userId)
    .first<{ groupme_user_id: string | null; groupme_name: string | null; created_at: string }>();
  if (!row) return c.json({ connected: false });
  return c.json({
    connected: true,
    groupme_user_id: row.groupme_user_id,
    groupme_name: row.groupme_name,
    connected_at: row.created_at,
  });
});

groupme.get("/me", async (c) => {
  const userId = c.get("userId");
  try {
    const token = await getToken(userId, c.env);
    const me = await getMe(token);
    return c.json(me);
  } catch (err) {
    if (err instanceof GroupMeNotConnectedError) return c.json({ error: "not connected" }, 404);
    return c.json({ error: String(err) }, 502);
  }
});

groupme.get("/groups", async (c) => {
  const userId = c.get("userId");
  try {
    const token = await getToken(userId, c.env);
    const groups = await listGroups(token);
    return c.json({
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        description: g.description ?? null,
        image_url: g.image_url ?? null,
        member_count: g.members?.length ?? null,
        last_message_at: g.messages?.last_message_created_at ?? null,
      })),
    });
  } catch (err) {
    if (err instanceof GroupMeNotConnectedError) return c.json({ error: "not connected" }, 404);
    return c.json({ error: String(err) }, 502);
  }
});

groupme.get("/groups/:id/messages", async (c) => {
  const userId = c.get("userId");
  const groupId = c.req.param("id");
  const limit = parseInt(c.req.query("limit") || "20", 10);
  try {
    const token = await getToken(userId, c.env);
    const messages = await listMessages(token, groupId, limit);
    return c.json({
      messages: messages.map((m) => ({
        id: m.id,
        created_at: m.created_at,
        user_id: m.user_id,
        name: m.name,
        text: m.text,
        system: m.system,
        attachments: m.attachments ?? [],
      })),
    });
  } catch (err) {
    if (err instanceof GroupMeNotConnectedError) return c.json({ error: "not connected" }, 404);
    return c.json({ error: String(err) }, 502);
  }
});

// Disconnect — clears stored token.
groupme.delete("/", async (c) => {
  const userId = c.get("userId");
  await deleteToken(userId, c.env);
  return c.json({ ok: true });
});

export { groupme };
