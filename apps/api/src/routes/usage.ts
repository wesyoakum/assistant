import { Hono } from "hono";
import type { Env } from "../index";
import type { AuthVariables } from "../middleware/auth";
import { authMiddleware } from "../middleware/auth";

type UsageApp = Hono<{ Bindings: Env; Variables: AuthVariables }>;

const usage: UsageApp = new Hono();

usage.use("*", authMiddleware);

// Summary: total spend, today, last 7 days, last 30 days
usage.get("/summary", async (c) => {
  const userId = c.get("userId");

  const [today, week, month, allTime] = await Promise.all([
    c.env.DB.prepare(
      `SELECT COUNT(*) as calls, SUM(input_tokens) as input, SUM(output_tokens) as output,
              SUM(cache_read_tokens) as cache_read, SUM(cost_cents) as cost
       FROM api_usage WHERE user_id = ? AND created_at >= datetime('now', '-1 day')`
    ).bind(userId).first<{ calls: number; input: number; output: number; cache_read: number; cost: number }>(),

    c.env.DB.prepare(
      `SELECT COUNT(*) as calls, SUM(input_tokens) as input, SUM(output_tokens) as output,
              SUM(cache_read_tokens) as cache_read, SUM(cost_cents) as cost
       FROM api_usage WHERE user_id = ? AND created_at >= datetime('now', '-7 days')`
    ).bind(userId).first<{ calls: number; input: number; output: number; cache_read: number; cost: number }>(),

    c.env.DB.prepare(
      `SELECT COUNT(*) as calls, SUM(input_tokens) as input, SUM(output_tokens) as output,
              SUM(cache_read_tokens) as cache_read, SUM(cost_cents) as cost
       FROM api_usage WHERE user_id = ? AND created_at >= datetime('now', '-30 days')`
    ).bind(userId).first<{ calls: number; input: number; output: number; cache_read: number; cost: number }>(),

    c.env.DB.prepare(
      `SELECT COUNT(*) as calls, SUM(input_tokens) as input, SUM(output_tokens) as output,
              SUM(cache_read_tokens) as cache_read, SUM(cost_cents) as cost
       FROM api_usage WHERE user_id = ?`
    ).bind(userId).first<{ calls: number; input: number; output: number; cache_read: number; cost: number }>(),
  ]);

  return c.json({
    today: { calls: today?.calls || 0, inputTokens: today?.input || 0, outputTokens: today?.output || 0, cacheReadTokens: today?.cache_read || 0, costCents: Math.round((today?.cost || 0) * 100) / 100 },
    week: { calls: week?.calls || 0, inputTokens: week?.input || 0, outputTokens: week?.output || 0, cacheReadTokens: week?.cache_read || 0, costCents: Math.round((week?.cost || 0) * 100) / 100 },
    month: { calls: month?.calls || 0, inputTokens: month?.input || 0, outputTokens: month?.output || 0, cacheReadTokens: month?.cache_read || 0, costCents: Math.round((month?.cost || 0) * 100) / 100 },
    allTime: { calls: allTime?.calls || 0, inputTokens: allTime?.input || 0, outputTokens: allTime?.output || 0, cacheReadTokens: allTime?.cache_read || 0, costCents: Math.round((allTime?.cost || 0) * 100) / 100 },
  });
});

// Daily breakdown for the last 30 days
usage.get("/daily", async (c) => {
  const userId = c.get("userId");

  const { results } = await c.env.DB.prepare(
    `SELECT date(created_at) as day, purpose,
            COUNT(*) as calls, SUM(input_tokens) as input, SUM(output_tokens) as output,
            SUM(cache_read_tokens) as cache_read, SUM(cost_cents) as cost
     FROM api_usage WHERE user_id = ? AND created_at >= datetime('now', '-30 days')
     GROUP BY day, purpose
     ORDER BY day DESC, purpose`
  ).bind(userId).all<{ day: string; purpose: string; calls: number; input: number; output: number; cache_read: number; cost: number }>();

  return c.json({ daily: results });
});

// Hourly breakdown for the last 48 hours
usage.get("/hourly", async (c) => {
  const userId = c.get("userId");

  const { results } = await c.env.DB.prepare(
    `SELECT strftime('%Y-%m-%dT%H:00:00', created_at) as hour, purpose,
            COUNT(*) as calls, SUM(cost_cents) as cost
     FROM api_usage WHERE user_id = ? AND created_at >= datetime('now', '-2 days')
     GROUP BY hour, purpose
     ORDER BY hour`
  ).bind(userId).all<{ hour: string; purpose: string; calls: number; cost: number }>();

  return c.json({ hourly: results });
});

// Minute breakdown for the last 48 hours
usage.get("/minutes48", async (c) => {
  const userId = c.get("userId");

  const { results } = await c.env.DB.prepare(
    `SELECT strftime('%Y-%m-%dT%H:%M:00', created_at) as minute, purpose,
            COUNT(*) as calls, SUM(cost_cents) as cost
     FROM api_usage WHERE user_id = ? AND created_at >= datetime('now', '-2 days')
     GROUP BY minute, purpose
     ORDER BY minute`
  ).bind(userId).all<{ minute: string; purpose: string; calls: number; cost: number }>();

  return c.json({ minutes: results });
});

// Minute breakdown for the last 2 hours
usage.get("/minutes", async (c) => {
  const userId = c.get("userId");

  const { results } = await c.env.DB.prepare(
    `SELECT strftime('%Y-%m-%dT%H:%M:00', created_at) as minute, purpose,
            COUNT(*) as calls, SUM(cost_cents) as cost
     FROM api_usage WHERE user_id = ? AND created_at >= datetime('now', '-2 hours')
     GROUP BY minute, purpose
     ORDER BY minute`
  ).bind(userId).all<{ minute: string; purpose: string; calls: number; cost: number }>();

  return c.json({ minutes: results });
});

// Cumulative spend over time (all data, bucketed by day)
usage.get("/cumulative", async (c) => {
  const userId = c.get("userId");

  const { results } = await c.env.DB.prepare(
    `SELECT date(created_at) as day, SUM(cost_cents) as cost
     FROM api_usage WHERE user_id = ?
     GROUP BY day ORDER BY day`
  ).bind(userId).all<{ day: string; cost: number }>();

  // Build cumulative
  let running = 0;
  const cumulative = results.map((r) => {
    running += r.cost;
    return { day: r.day, dailyCost: Math.round(r.cost * 100) / 100, cumulativeCost: Math.round(running * 100) / 100 };
  });

  return c.json({ cumulative });
});

// Recent calls (last 50)
usage.get("/recent", async (c) => {
  const userId = c.get("userId");

  const { results } = await c.env.DB.prepare(
    `SELECT model, purpose, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_cents, created_at
     FROM api_usage WHERE user_id = ?
     ORDER BY created_at DESC LIMIT 50`
  ).bind(userId).all<{
    model: string; purpose: string; input_tokens: number; output_tokens: number;
    cache_read_tokens: number; cache_write_tokens: number; cost_cents: number; created_at: string;
  }>();

  return c.json({ calls: results });
});

export { usage };
