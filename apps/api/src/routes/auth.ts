import { Hono } from "hono";
import type { Env } from "../index";
import type { AuthVariables } from "../middleware/auth";
import { authMiddleware } from "../middleware/auth";
import { encrypt } from "../services/crypto";
import { signJwt } from "../services/jwt";

import { GOOGLE_CLIENT_ID, GOOGLE_TOKEN_URL, GOOGLE_REDIRECT_URI } from "../config";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const CLIENT_ID = GOOGLE_CLIENT_ID;
const REDIRECT_URI = GOOGLE_REDIRECT_URI;
const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
].join(" ");

type AuthApp = Hono<{ Bindings: Env; Variables: AuthVariables }>;

const auth: AuthApp = new Hono();

// Step 1: Redirect user to Google OAuth
auth.get("/google/start", (c) => {
  const returnUrl = c.req.query("return_url") || "whyapp://auth";

  // Pass return_url through Google's state param so we get it back in the callback
  const state = btoa(JSON.stringify({ return_url: returnUrl }));

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return c.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
});

// Step 2: Handle Google callback, store tokens, issue session JWT
auth.get("/google/callback", async (c) => {
  try {
  const code = c.req.query("code");
  const error = c.req.query("error");
  const stateParam = c.req.query("state");

  // Recover the app return URL from state
  let returnUrl = "whyapp://auth";
  if (stateParam) {
    try {
      const state = JSON.parse(atob(stateParam));
      if (state.return_url) returnUrl = state.return_url;
    } catch {
      // Fall back to default
    }
  }

  // Append query params with the right separator
  const redirect = (params: string) => {
    const sep = returnUrl.includes("?") ? "&" : "?";
    return c.redirect(`${returnUrl}${sep}${params}`);
  };

  if (error || !code) {
    return redirect(`error=${error || "no_code"}`);
  }

  // Exchange code for tokens
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    console.error("Token exchange failed:", err);
    return redirect("error=token_exchange_failed");
  }

  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
  };

  // Get user info
  const userRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!userRes.ok) {
    return redirect("error=userinfo_failed");
  }

  const userInfo = (await userRes.json()) as {
    sub: string;
    email: string;
    name: string;
    picture: string;
  };

  // Upsert user
  const userId = crypto.randomUUID();
  const existingUser = await c.env.DB.prepare(
    "SELECT id FROM users WHERE google_sub = ?"
  )
    .bind(userInfo.sub)
    .first<{ id: string }>();

  const finalUserId = existingUser?.id || userId;

  if (!existingUser) {
    await c.env.DB.prepare(
      "INSERT INTO users (id, google_sub, email, name, picture_url) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(userId, userInfo.sub, userInfo.email, userInfo.name, userInfo.picture)
      .run();
  } else {
    await c.env.DB.prepare(
      "UPDATE users SET email = ?, name = ?, picture_url = ?, updated_at = datetime('now') WHERE id = ?"
    )
      .bind(userInfo.email, userInfo.name, userInfo.picture, finalUserId)
      .run();
  }

  // Encrypt and store tokens
  const encAccessToken = await encrypt(
    tokens.access_token,
    c.env.OAUTH_ENCRYPTION_KEY
  );
  const encRefreshToken = await encrypt(
    tokens.refresh_token || "",
    c.env.OAUTH_ENCRYPTION_KEY
  );

  const expiresAt = new Date(
    Date.now() + tokens.expires_in * 1000
  ).toISOString();

  // Upsert oauth_tokens
  await c.env.DB.prepare("DELETE FROM oauth_tokens WHERE user_id = ?")
    .bind(finalUserId)
    .run();

  await c.env.DB.prepare(
    `INSERT INTO oauth_tokens (id, user_id, access_token_encrypted, access_token_iv, refresh_token_encrypted, refresh_token_iv, scope, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      finalUserId,
      encAccessToken.ciphertext,
      encAccessToken.iv,
      encRefreshToken.ciphertext,
      encRefreshToken.iv,
      tokens.scope,
      expiresAt
    )
    .run();

  // Issue session JWT
  const jwt = await signJwt(finalUserId, userInfo.email, c.env.SESSION_JWT_SECRET);

  return redirect(`token=${jwt}`);
  } catch (err) {
    console.error("OAuth callback error:", err);
    return c.json(
      { error: "auth_failed", detail: err instanceof Error ? err.message : String(err) },
      500
    );
  }
});

// Logout — client discards token; server-side is stateless JWT
auth.post("/logout", authMiddleware, async (c) => {
  // Optionally delete oauth tokens to revoke access
  const userId = c.get("userId");
  await c.env.DB.prepare("DELETE FROM oauth_tokens WHERE user_id = ?")
    .bind(userId)
    .run();
  return c.json({ ok: true });
});

export { auth };
