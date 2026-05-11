import { buildSystemPrompt } from "../prompts/triage-system";
import { triageResultSchema, type TriageResult } from "../prompts/triage.schema";
import type { EmailContent, FeedbackRow } from "@assistant/shared";

const CLAUDE_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-7-20250415";

interface ClaudeResponse {
  content: { type: string; text?: string }[];
}

export async function classifyEmail(
  email: EmailContent,
  feedbackHistory: FeedbackRow[],
  anthropicApiKey: string
): Promise<TriageResult> {
  const systemPrompt = buildSystemPrompt(feedbackHistory);

  const userMessage = `From: ${email.from}
Subject: ${email.subject}
Date: ${email.date}

${email.bodyText}`;

  const result = await callClaude(systemPrompt, userMessage, anthropicApiKey);

  // Try to parse
  const parsed = tryParse(result);
  if (parsed) return parsed;

  // Retry once with error feedback
  const retryMessage = `${userMessage}

Your previous response was not valid JSON. The parsing error was:
${getParseError(result)}

Please return ONLY valid JSON matching the schema.`;

  const retryResult = await callClaude(systemPrompt, retryMessage, anthropicApiKey);
  const retryParsed = tryParse(retryResult);
  if (retryParsed) return retryParsed;

  // Fall back to a safe default
  return {
    priority: 3,
    urgency: 3,
    category: "other",
    summary: email.subject || "Unable to classify",
    suggested_action: "Review this email manually",
  };
}

async function callClaude(
  system: string,
  userMessage: string,
  apiKey: string
): Promise<string> {
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
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err}`);
  }

  const data = (await res.json()) as ClaudeResponse;
  const textBlock = data.content.find((b) => b.type === "text");
  return textBlock?.text || "";
}

function tryParse(text: string): TriageResult | null {
  try {
    // Extract JSON from potential markdown code blocks
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
