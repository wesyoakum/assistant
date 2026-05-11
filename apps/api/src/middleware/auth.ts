import { Context, Next } from "hono";
import { verifyJwt } from "../services/jwt";
import type { Env } from "../index";

export type AuthVariables = {
  userId: string;
  email: string;
};

export async function authMiddleware(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
  next: Next
) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing authorization" }, 401);
  }

  const token = authHeader.slice(7);
  const payload = await verifyJwt(token, c.env.SESSION_JWT_SECRET);
  if (!payload) {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  c.set("userId", payload.sub);
  c.set("email", payload.email);
  await next();
}
