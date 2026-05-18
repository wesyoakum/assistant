import { buildSystemPrompt } from "../prompts/triage-system";
import { triageResultSchema, type TriageResult } from "../prompts/triage.schema";
import type { EmailContent, FeedbackRow } from "@assistant/shared";

const CLAUDE_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-7";

interface ClaudeResponse {
  content: { type: string; text?: string }[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

// Pricing per million tokens (cents)
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
  usage: ClaudeResponse["usage"]
) {
  if (!usage) return;
  const p = PRICING[MODEL] || PRICING["claude-opus-4-7"];
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  // Non-cached input = total input - cacheRead - cacheWrite
  const regularInput = Math.max(0, inputTokens - cacheRead - cacheWrite);
  const costCents = (regularInput * p.input + outputTokens * p.output + cacheRead * p.cacheRead + cacheWrite * p.cacheWrite) / 1_000_000;

  try {
    await db.prepare(
      `INSERT INTO api_usage (user_id, model, purpose, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(userId, MODEL, purpose, inputTokens, outputTokens, cacheRead, cacheWrite, costCents).run();
  } catch { /* don't let logging failures break functionality */ }
}

export async function classifyEmail(
  email: EmailContent,
  feedbackHistory: FeedbackRow[],
  anthropicApiKey: string,
  contextEntries: { kind: string; label: string; detail: string | null }[] = [],
  db?: D1Database,
  userId?: string
): Promise<TriageResult> {
  const now = new Date();
  const currentDateTime = now.toLocaleString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
    timeZone: "America/Chicago",
  });
  const systemPrompt = buildSystemPrompt(feedbackHistory, contextEntries, currentDateTime);

  const userMessage = `From: ${email.from}
Subject: ${email.subject}
Date: ${email.date}

${email.bodyText}`;

  const result = await callClaude(systemPrompt, userMessage, anthropicApiKey);
  if (db && userId) await logUsage(db, userId, "classify-email", result.usage);
  const parsed = tryParse(result.text);
  if (parsed) return parsed;

  // Retry once with error feedback
  const retryMessage = `${userMessage}

Your previous response was not valid JSON. The parsing error was:
${getParseError(result.text)}

Please return ONLY valid JSON matching the schema.`;

  const retryResult = await callClaude(systemPrompt, retryMessage, anthropicApiKey);
  if (db && userId) await logUsage(db, userId, "classify-email-retry", retryResult.usage);
  const retryParsed = tryParse(retryResult.text);
  if (retryParsed) return retryParsed;

  return {
    impact: 3, meaning: 3, responsibility: 3, time_sensitivity: 3, immediacy: 3,
    importance: 3,
    urgency: 3,
    confidence: 1,
    category: "other",
    summary: email.subject || "Unable to classify",
    suggested_action: "Review this email manually",
    clarification_question: "How would you like to prioritize this email?",
  };
}

/**
 * Classify a file (image, PDF, or audio) using Claude vision/audio.
 */
export async function classifyFile(
  kind: "image" | "pdf" | "audio",
  fileBytes: ArrayBuffer,
  contentType: string,
  feedbackHistory: FeedbackRow[],
  anthropicApiKey: string,
  contextEntries: { kind: string; label: string; detail: string | null }[] = [],
  db?: D1Database,
  userId?: string
): Promise<TriageResult> {
  const now = new Date();
  const currentDateTime = now.toLocaleString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
    timeZone: "America/Chicago",
  });
  const systemPrompt = buildSystemPrompt(feedbackHistory, contextEntries, currentDateTime);
  const base64 = arrayBufferToBase64(fileBytes);

  let userContent: unknown[];
  if (kind === "image") {
    userContent = [
      {
        type: "image",
        source: { type: "base64", media_type: contentType, data: base64 },
      },
      { type: "text", text: "Analyze this image and classify it for triage. Extract any text, dates, action items, or important information. Return JSON matching the triage schema." },
    ];
  } else if (kind === "pdf") {
    userContent = [
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: base64 },
      },
      { type: "text", text: "Analyze this PDF document and classify it for triage. Extract key information, dates, action items, and deadlines. Return JSON matching the triage schema." },
    ];
  } else {
    userContent = [
      {
        type: "text",
        text: "The user recorded a voice memo. The audio has been attached. Transcribe and classify it for triage. Extract any action items, dates, or important information. Return JSON matching the triage schema.",
      },
      {
        type: "document",
        source: { type: "base64", media_type: contentType, data: base64 },
      },
    ];
  }

  const result = await callClaudeMultimodal(systemPrompt, userContent, anthropicApiKey);
  if (db && userId) await logUsage(db, userId, `classify-${kind}`, result.usage);
  const parsed = tryParse(result.text);
  if (parsed) return parsed;

  return {
    impact: 3, meaning: 3, responsibility: 3, time_sensitivity: 3, immediacy: 3,
    importance: 3,
    urgency: 3,
    confidence: 1,
    category: "capture",
    summary: `${kind} capture — unable to fully classify`,
    suggested_action: "Review this capture manually",
  };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

interface ClaudeCallResult {
  text: string;
  usage: ClaudeResponse["usage"];
}

async function callClaude(
  system: string,
  userMessage: string,
  apiKey: string
): Promise<ClaudeCallResult> {
  return callClaudeMultimodal(
    system,
    [{ type: "text", text: userMessage }],
    apiKey
  );
}

async function callClaudeMultimodal(
  system: string,
  userContent: unknown[],
  apiKey: string
): Promise<ClaudeCallResult> {
  const res = await fetch(CLAUDE_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: system,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err}`);
  }

  const data = (await res.json()) as ClaudeResponse;
  const textBlock = data.content.find((b) => b.type === "text");
  return { text: textBlock?.text || "", usage: data.usage };
}

function tryParse(text: string): TriageResult | null {
  try {
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ||
                      text.match(/(\{[\s\S]*\})/);
    const jsonStr = jsonMatch ? jsonMatch[1]! : text;
    const obj = JSON.parse(jsonStr);
    return triageResultSchema.parse(obj);
  } catch {
    return null;
  }
}

function getParseError(text: string): string {
  try {
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ||
                      text.match(/(\{[\s\S]*\})/);
    const jsonStr = jsonMatch ? jsonMatch[1]! : text;
    const obj = JSON.parse(jsonStr);
    triageResultSchema.parse(obj);
    return "Unknown error";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
