/**
 * GroupMe API helpers.
 * Per-user encrypted token storage + read-only API wrappers.
 *
 * GroupMe API base: https://api.groupme.com/v3
 * Auth: pass `?token=<access_token>` on every request.
 */

import type { Env } from "../index";
import { encrypt, decrypt } from "./crypto";

const GROUPME_API = "https://api.groupme.com/v3";

export class GroupMeNotConnectedError extends Error {
  constructor() {
    super("GroupMe not connected");
    this.name = "GroupMeNotConnectedError";
  }
}

export interface GroupMeUser {
  id: string;
  name: string;
  email?: string;
  image_url?: string;
}

export interface GroupMeGroup {
  id: string;
  name: string;
  description?: string;
  image_url?: string;
  type?: string;
  members?: { user_id: string; nickname: string }[];
  messages?: { count: number; last_message_id?: string; last_message_created_at?: number };
}

export interface GroupMeMessage {
  id: string;
  created_at: number;
  user_id: string;
  group_id: string;
  name: string;
  text: string | null;
  system: boolean;
  favorited_by?: string[];
  attachments?: unknown[];
}

interface GroupMeEnvelope<T> {
  response: T;
  meta?: { code: number; errors?: string[] };
}

export async function storeToken(
  userId: string,
  accessToken: string,
  env: Env,
  groupmeUserId?: string,
  groupmeName?: string,
): Promise<void> {
  const enc = await encrypt(accessToken, env.OAUTH_ENCRYPTION_KEY);
  await env.DB.prepare("DELETE FROM groupme_tokens WHERE user_id = ?").bind(userId).run();
  await env.DB.prepare(
    `INSERT INTO groupme_tokens (id, user_id, access_token_encrypted, access_token_iv, groupme_user_id, groupme_name)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      userId,
      enc.ciphertext,
      enc.iv,
      groupmeUserId ?? null,
      groupmeName ?? null,
    )
    .run();
}

export async function getToken(userId: string, env: Env): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT access_token_encrypted, access_token_iv FROM groupme_tokens WHERE user_id = ?",
  )
    .bind(userId)
    .first<{ access_token_encrypted: string; access_token_iv: string }>();
  if (!row) throw new GroupMeNotConnectedError();
  return decrypt(
    { ciphertext: row.access_token_encrypted, iv: row.access_token_iv },
    env.OAUTH_ENCRYPTION_KEY,
  );
}

export async function deleteToken(userId: string, env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM groupme_tokens WHERE user_id = ?").bind(userId).run();
}

async function groupmeGet<T>(token: string, path: string, query?: Record<string, string>): Promise<T> {
  const params = new URLSearchParams({ token, ...(query || {}) });
  const url = `${GROUPME_API}${path}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GroupMe ${res.status}: ${body.slice(0, 200)}`);
  }
  const env = (await res.json()) as GroupMeEnvelope<T>;
  return env.response;
}

export function getMe(token: string): Promise<GroupMeUser> {
  return groupmeGet<GroupMeUser>(token, "/users/me");
}

export function listGroups(token: string): Promise<GroupMeGroup[]> {
  return groupmeGet<GroupMeGroup[]>(token, "/groups");
}

export async function listMessages(
  token: string,
  groupId: string,
  limit = 20,
): Promise<GroupMeMessage[]> {
  const data = await groupmeGet<{ count: number; messages: GroupMeMessage[] }>(
    token,
    `/groups/${encodeURIComponent(groupId)}/messages`,
    { limit: String(Math.min(Math.max(limit, 1), 100)) },
  );
  return data.messages;
}
