/**
 * Anthropic API helpers used by chat. The classifier pipeline that used to
 * live here has been removed.
 */

// Model strings — wired per call-site, not as a module constant.
export const CHAT_MODEL = "claude-opus-4-7";

interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// Pricing per million tokens (cents).
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-4-7": { input: 1500, output: 7500, cacheRead: 150, cacheWrite: 1875 },
  "claude-sonnet-4-6": { input: 300, output: 1500, cacheRead: 30, cacheWrite: 375 },
  "claude-haiku-4-5-20251001": { input: 80, output: 400, cacheRead: 8, cacheWrite: 100 },
};

/** Log API usage to D1. Call after each Claude API response. */
export async function logUsage(
  db: D1Database,
  userId: string,
  purpose: string,
  model: string,
  usage: ClaudeUsage | undefined,
) {
  if (!usage) return;
  const p = PRICING[model] ?? PRICING["claude-sonnet-4-6"]!;
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const regularInput = Math.max(0, inputTokens - cacheRead - cacheWrite);
  const costCents =
    (regularInput * p.input +
      outputTokens * p.output +
      cacheRead * p.cacheRead +
      cacheWrite * p.cacheWrite) /
    1_000_000;

  try {
    await db
      .prepare(
        `INSERT INTO api_usage
           (user_id, model, purpose, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_cents)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(userId, model, purpose, inputTokens, outputTokens, cacheRead, cacheWrite, costCents)
      .run();
  } catch {
    // logging failures must not break requests
  }
}
