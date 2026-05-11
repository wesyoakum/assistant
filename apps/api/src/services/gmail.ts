import { decrypt, encrypt } from "./crypto";
import { GOOGLE_CLIENT_ID, GOOGLE_TOKEN_URL } from "../config";
import type { Env } from "../index";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export class TokenExpiredError extends Error {
  constructor() {
    super("Google token revoked or expired — user must re-authenticate");
    this.name = "TokenExpiredError";
  }
}

interface TokenRow {
  id: string;
  access_token_encrypted: string;
  access_token_iv: string;
  refresh_token_encrypted: string;
  refresh_token_iv: string;
  expires_at: string;
}

/**
 * Get a valid Google access token for a user, refreshing if needed.
 */
export async function getValidAccessToken(
  userId: string,
  env: Env
): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT id, access_token_encrypted, access_token_iv, refresh_token_encrypted, refresh_token_iv, expires_at FROM oauth_tokens WHERE user_id = ?"
  )
    .bind(userId)
    .first<TokenRow>();

  if (!row) throw new TokenExpiredError();

  const expiresAt = new Date(row.expires_at).getTime();
  const bufferMs = 5 * 60 * 1000; // refresh if < 5 min remaining

  if (Date.now() < expiresAt - bufferMs) {
    // Token still valid
    return decrypt(
      { ciphertext: row.access_token_encrypted, iv: row.access_token_iv },
      env.OAUTH_ENCRYPTION_KEY
    );
  }

  // Need to refresh
  const refreshToken = await decrypt(
    { ciphertext: row.refresh_token_encrypted, iv: row.refresh_token_iv },
    env.OAUTH_ENCRYPTION_KEY
  );

  if (!refreshToken) throw new TokenExpiredError();

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    console.error("Token refresh failed:", await res.text());
    throw new TokenExpiredError();
  }

  const tokens = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };

  // Re-encrypt and store
  const encAccess = await encrypt(tokens.access_token, env.OAUTH_ENCRYPTION_KEY);
  const newExpiresAt = new Date(
    Date.now() + tokens.expires_in * 1000
  ).toISOString();

  await env.DB.prepare(
    "UPDATE oauth_tokens SET access_token_encrypted = ?, access_token_iv = ?, expires_at = ?, updated_at = datetime('now') WHERE id = ?"
  )
    .bind(encAccess.ciphertext, encAccess.iv, newExpiresAt, row.id)
    .run();

  return tokens.access_token;
}

export interface GmailMessage {
  messageId: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  bodyText: string;
}

/**
 * Get the user's Gmail profile (for initial historyId).
 */
export async function getGmailProfile(
  accessToken: string
): Promise<{ historyId: string; emailAddress: string }> {
  const res = await fetch(`${GMAIL_API}/profile`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Gmail profile failed: ${res.status}`);
  return res.json() as Promise<{ historyId: string; emailAddress: string }>;
}

/**
 * Fetch new messages since historyId, or recent unread if no historyId.
 */
export async function fetchNewMessages(
  accessToken: string,
  historyId?: string | null
): Promise<{ messages: GmailMessage[]; newHistoryId: string }> {
  const headers = { Authorization: `Bearer ${accessToken}` };

  if (!historyId) {
    // First sync: get recent unread
    const listRes = await fetch(
      `${GMAIL_API}/messages?q=is:unread&maxResults=20`,
      { headers }
    );
    if (!listRes.ok) throw new Error(`Gmail list failed: ${listRes.status}`);
    const listData = (await listRes.json()) as {
      messages?: { id: string }[];
    };

    const profile = await getGmailProfile(accessToken);
    const messageIds = listData.messages?.map((m) => m.id) || [];
    const messages = await Promise.all(
      messageIds.slice(0, 20).map((id) => getMessageDetail(accessToken, id))
    );

    return { messages, newHistoryId: profile.historyId };
  }

  // Incremental sync via history
  const histRes = await fetch(
    `${GMAIL_API}/history?startHistoryId=${historyId}&historyTypes=messageAdded&maxResults=20`,
    { headers }
  );

  if (histRes.status === 404) {
    // historyId too old, do full sync
    return fetchNewMessages(accessToken, null);
  }
  if (!histRes.ok) throw new Error(`Gmail history failed: ${histRes.status}`);

  const histData = (await histRes.json()) as {
    history?: { messagesAdded?: { message: { id: string } }[] }[];
    historyId: string;
  };

  const messageIds = new Set<string>();
  for (const h of histData.history || []) {
    for (const added of h.messagesAdded || []) {
      messageIds.add(added.message.id);
    }
  }

  const messages = await Promise.all(
    [...messageIds].slice(0, 20).map((id) => getMessageDetail(accessToken, id))
  );

  return { messages, newHistoryId: histData.historyId };
}

/**
 * Get full message detail.
 */
export async function getMessageDetail(
  accessToken: string,
  messageId: string
): Promise<GmailMessage> {
  const res = await fetch(`${GMAIL_API}/messages/${messageId}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Gmail message ${messageId} failed: ${res.status}`);

  const data = (await res.json()) as {
    id: string;
    threadId: string;
    snippet: string;
    payload: {
      headers: { name: string; value: string }[];
      body?: { data?: string };
      parts?: { mimeType: string; body?: { data?: string } }[];
    };
  };

  const getHeader = (name: string) =>
    data.payload.headers.find(
      (h) => h.name.toLowerCase() === name.toLowerCase()
    )?.value || "";

  // Extract body text
  let bodyText = "";
  if (data.payload.parts) {
    const textPart = data.payload.parts.find(
      (p) => p.mimeType === "text/plain"
    );
    if (textPart?.body?.data) {
      bodyText = decodeBase64Url(textPart.body.data);
    }
  } else if (data.payload.body?.data) {
    bodyText = decodeBase64Url(data.payload.body.data);
  }

  // Truncate to 10k chars for Claude
  if (bodyText.length > 10000) {
    bodyText = bodyText.slice(0, 10000) + "\n[truncated]";
  }

  return {
    messageId: data.id,
    threadId: data.threadId,
    subject: getHeader("Subject"),
    from: getHeader("From"),
    date: getHeader("Date"),
    snippet: data.snippet,
    bodyText,
  };
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return atob(base64);
}
