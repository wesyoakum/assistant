import { Hono } from "hono";
import type { Env } from "../index";
import type { AuthVariables } from "../middleware/auth";
import { authMiddleware } from "../middleware/auth";
import {
  storeToken,
  getToken,
  deleteToken,
  getMe,
  listGroups,
  GroupMeNotConnectedError,
} from "../services/groupme";

type GroupMeApp = Hono<{ Bindings: Env; Variables: AuthVariables }>;

const groupme: GroupMeApp = new Hono();

groupme.use("*", authMiddleware);

// Paste-an-access-token path. Get one from https://dev.groupme.com (sign in,
// then "Access Token" in the header).
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

// "Am I connected?" — local-only, no GroupMe round trip.
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

// Disconnect — clears stored token.
groupme.delete("/", async (c) => {
  const userId = c.get("userId");
  await deleteToken(userId, c.env);
  return c.json({ ok: true });
});

export { groupme };
