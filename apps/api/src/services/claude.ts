import { buildSystemPrompt } from "../prompts/triage-system";
import { triageResultSchema, type TriageResult } from "../prompts/triage.schema";
import type { EmailContent, FeedbackRow } from "@assistant/shared";

const CLAUDE_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-7";

interface ClaudeResponse {
  content: { type: string; text?: string }[];
}

export async function classifyEmail(
  email: EmailContent,
  feedbackHistory: FeedbackRow[],
  anthropicApiKey: string,
  contextEntries: { kind: string; label: string; detail: string | null }[] = []
): Promise<TriageResult> {
  const systemPrompt = buildSystemPrompt(feedbackHistory, contextEntries);

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

  // Fall back to a safe default — classifier failed, so confidence is minimal
  // and we ask the user to triage manually.
  return {
    priority: 3,
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
  contextEntries: { kind: string; label: string; detail: string | null }[] = []
): Promise<TriageResult> {
  const systemPrompt = buildSystemPrompt(feedbackHistory, contextEntries);
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
    // audio
    userContent = [
      {
        type: "text",
        text: "The user recorded a voice memo. The audio has been attached. Transcribe and classify it for triage. Extract any action items, dates, or important information. Return JSON matching the triage schema.",
      },
      // Audio is sent as base64 in a document block
      {
        type: "document",
        source: { type: "base64", media_type: contentType, data: base64 },
      },
    ];
  }

  const result = await callClaudeMultimodal(systemPrompt, userContent, anthropicApiKey);
  const parsed = tryParse(result);
  if (parsed) return parsed;

  return {
    priority: 3,
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

async function callClaude(
  system: string,
  userMessage: string,
  apiKey: string
): Promise<string> {
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
      messages: [{ role: "user", content: userContent }],
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
