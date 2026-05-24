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
  listMessages,
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

    // Pull enabled flags in one query.
    const { results: prefRows } = await c.env.DB.prepare(
      "SELECT group_id, enabled FROM groupme_group_prefs WHERE user_id = ?",
    )
      .bind(userId)
      .all<{ group_id: string; enabled: number }>();
    const enabledMap = new Map<string, boolean>();
    for (const r of prefRows) enabledMap.set(r.group_id, !!r.enabled);

    return c.json({
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        description: g.description ?? null,
        image_url: g.image_url ?? null,
        member_count: g.members?.length ?? null,
        last_message_at: g.messages?.last_message_created_at ?? null,
        enabled: enabledMap.get(g.id) ?? false,
      })),
    });
  } catch (err) {
    if (err instanceof GroupMeNotConnectedError) return c.json({ error: "not connected" }, 404);
    return c.json({ error: String(err) }, 502);
  }
});

// Toggle whether messages from a group should be fetched.
groupme.post("/groups/:id/toggle", async (c) => {
  const userId = c.get("userId");
  const groupId = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as { enabled?: boolean } | null;
  const enabled = body?.enabled ? 1 : 0;

  await c.env.DB.prepare(
    `INSERT INTO groupme_group_prefs (user_id, group_id, enabled)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id, group_id) DO UPDATE SET enabled = excluded.enabled`,
  )
    .bind(userId, groupId, enabled)
    .run();

  return c.json({ ok: true, enabled: !!enabled });
});

// Pull new messages from every enabled group, storing them in pending_emails
// with source_type='groupme' so chat picks them up alongside email + calendar.
groupme.post("/sync", async (c) => {
  const userId = c.get("userId");
  let token: string;
  try {
    token = await getToken(userId, c.env);
  } catch (err) {
    if (err instanceof GroupMeNotConnectedError) return c.json({ error: "not connected" }, 404);
    throw err;
  }

  const { results: prefs } = await c.env.DB.prepare(
    `SELECT group_id, last_message_id FROM groupme_group_prefs
      WHERE user_id = ? AND enabled = 1`,
  )
    .bind(userId)
    .all<{ group_id: string; last_message_id: string | null }>();

  if (prefs.length === 0) {
    return c.json({ ok: true, groups: 0, stored: 0 });
  }

  // Resolve group names for nicer storage. One round-trip; non-fatal if it fails.
  const nameById = new Map<string, string>();
  try {
    const groups = await listGroups(token);
    for (const g of groups) nameById.set(g.id, g.name);
  } catch {
    /* keep nameById empty — fall back to id */
  }

  let totalStored = 0;
  const errors: { group_id: string; error: string }[] = [];

  for (const pref of prefs) {
    try {
      // First sync: pull the last 20 messages. Subsequent: only since the
      // last id we stored.
      const messages = await listMessages(token, pref.group_id, {
        limit: pref.last_message_id ? 100 : 20,
        sinceId: pref.last_message_id ?? undefined,
      });

      if (messages.length === 0) continue;

      // GroupMe returns newest first. We want to store oldest first so the
      // "last_message_id we've seen" is the highest one (and to keep order
      // stable in pending_emails).
      const ordered = [...messages].reverse();
      const groupName = nameById.get(pref.group_id) || pref.group_id;
      let newestId: string = pref.last_message_id ?? "";

      for (const m of ordered) {
        const msgId = `groupme-${pref.group_id}-${m.id}`;
        // Skip if already stored (defensive — since_id should prevent it)
        const existing = await c.env.DB.prepare(
          "SELECT id FROM pending_emails WHERE user_id = ? AND message_id = ?",
        )
          .bind(userId, msgId)
          .first();
        if (existing) continue;

        await c.env.DB.prepare(
          `INSERT INTO pending_emails
             (id, user_id, message_id, subject, from_addr, email_date, snippet, body_text, source_type, collected_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'groupme', datetime('now'))`,
        )
          .bind(
            crypto.randomUUID(),
            userId,
            msgId,
            groupName,
            m.name || "GroupMe",
            new Date(m.created_at * 1000).toISOString(),
            (m.text || "").slice(0, 200),
            m.text || "",
          )
          .run();
        totalStored++;
        newestId = m.id;
      }

      await c.env.DB.prepare(
        `UPDATE groupme_group_prefs
            SET last_message_id = ?, last_synced_at = datetime('now')
          WHERE user_id = ? AND group_id = ?`,
      )
        .bind(newestId, userId, pref.group_id)
        .run();
    } catch (err) {
      errors.push({ group_id: pref.group_id, error: String(err) });
    }
  }

  return c.json({ ok: true, groups: prefs.length, stored: totalStored, errors });
});

// Disconnect — clears stored token.
groupme.delete("/", async (c) => {
  const userId = c.get("userId");
  await deleteToken(userId, c.env);
  return c.json({ ok: true });
});

export { groupme };
