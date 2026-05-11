/**
 * HS256 JWT for session tokens. 30-day expiry.
 */

interface JwtPayload {
  sub: string; // user id
  email: string;
  iat: number;
  exp: number;
}

function base64url(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlEncode(str: string): string {
  return base64url(new TextEncoder().encode(str));
}

function base64urlDecode(str: string): string {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  return atob(padded);
}

async function getSigningKey(secret: string): Promise<CryptoKey> {
  const raw = new TextEncoder().encode(secret);
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function signJwt(
  userId: string,
  email: string,
  secret: string
): Promise<string> {
  const header = base64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload: JwtPayload = {
    sub: userId,
    email,
    iat: now,
    exp: now + 30 * 24 * 60 * 60, // 30 days
  };
  const payloadEncoded = base64urlEncode(JSON.stringify(payload));

  const signingInput = `${header}.${payloadEncoded}`;
  const key = await getSigningKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

export async function verifyJwt(
  token: string,
  secret: string
): Promise<JwtPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const header = parts[0]!;
  const payload = parts[1]!;
  const sig = parts[2]!;
  const key = await getSigningKey(secret);

  const sigBytes = Uint8Array.from(base64urlDecode(sig), (c) =>
    c.charCodeAt(0)
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes,
    new TextEncoder().encode(`${header}.${payload}`)
  );

  if (!valid) return null;

  const decoded: JwtPayload = JSON.parse(base64urlDecode(payload));
  if (decoded.exp < Math.floor(Date.now() / 1000)) return null;

  return decoded;
}
