#!/usr/bin/env npx tsx
/**
 * Classifier eval harness.
 *
 * Runs all fixtures in evals/fixtures/ through the classifier and reports
 * accuracy + cost. Primary metric: quadrant accuracy.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npx tsx apps/api/evals/run.ts
 *   ANTHROPIC_API_KEY=sk-... npx tsx apps/api/evals/run.ts --model claude-sonnet-4-6
 *   ANTHROPIC_API_KEY=sk-... npx tsx apps/api/evals/run.ts --fixture noop-email-promo-01
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildSystemPrompt } from "../src/prompts/triage-system";
import { triageResultSchema, triageItemSchema } from "../src/prompts/triage.schema";
import type { EvalFixture, EvalResult, EvalSummary, Quadrant } from "./types";
import { toBucket } from "./types";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    model: { type: "string", default: "claude-sonnet-4-6" },
    fixture: { type: "string" },             // run a single fixture by id
    output: { type: "string", default: "" },  // write JSON report to path
    verbose: { type: "boolean", default: false },
    concurrency: { type: "string", default: "3" },
  },
  strict: true,
});

const MODEL = args.model!;
const FIXTURE_FILTER = args.fixture;
const VERBOSE = args.verbose!;
const CONCURRENCY = parseInt(args.concurrency!, 10);

// ---------------------------------------------------------------------------
// Load fixtures
// ---------------------------------------------------------------------------

const FIXTURES_DIR = resolve(import.meta.dirname!, "fixtures");

async function loadFixtures(): Promise<EvalFixture[]> {
  const files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith(".json"));
  const fixtures: EvalFixture[] = [];
  for (const file of files) {
    const raw = await readFile(join(FIXTURES_DIR, file), "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      fixtures.push(...parsed);
    } else {
      fixtures.push(parsed);
    }
  }
  return FIXTURE_FILTER
    ? fixtures.filter((f) => f.id === FIXTURE_FILTER)
    : fixtures;
}

// ---------------------------------------------------------------------------
// Claude API call (standalone, no Worker env needed)
// ---------------------------------------------------------------------------

const CLAUDE_API = "https://api.anthropic.com/v1/messages";

interface ClaudeResponse {
  content: { type: string; text?: string }[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-4-7": { input: 1500, output: 7500, cacheRead: 150, cacheWrite: 1875 },
  "claude-sonnet-4-6": { input: 300, output: 1500, cacheRead: 30, cacheWrite: 375 },
  "claude-haiku-4-5-20251001": { input: 80, output: 400, cacheRead: 8, cacheWrite: 100 },
};

function computeCost(usage: ClaudeResponse["usage"]): number {
  if (!usage) return 0;
  const p = PRICING[MODEL] || PRICING["claude-sonnet-4-6"];
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const regularInput = Math.max(0, input - cacheRead - cacheWrite);
  return (regularInput * p.input + output * p.output + cacheRead * p.cacheRead + cacheWrite * p.cacheWrite) / 1_000_000;
}

async function classify(
  apiKey: string,
  systemPrompt: string,
  userMessage: string
): Promise<{ text: string; usage: ClaudeResponse["usage"] }> {
  const res = await fetch(CLAUDE_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      system: [{ type: "text", text: systemPrompt }],
      messages: [{ role: "user", content: userMessage }],
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

/** Parse classifier output. Returns array of items (handles both { items: [...] } and legacy single-object). */
function tryParse(text: string): Record<string, unknown>[] | null {
  try {
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ||
                      text.match(/(\{[\s\S]*\})/);
    const jsonStr = jsonMatch ? jsonMatch[1]! : text;
    const obj = JSON.parse(jsonStr);

    // New format: { items: [...] }
    if (obj.items && Array.isArray(obj.items)) {
      const parsed = triageResultSchema.parse(obj);
      return parsed.items as unknown as Record<string, unknown>[];
    }

    // Legacy single-object format
    triageItemSchema.parse(obj);
    return [obj as Record<string, unknown>];
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Run one fixture
// ---------------------------------------------------------------------------

async function runFixture(
  fixture: EvalFixture,
  apiKey: string,
  systemPrompt: string
): Promise<EvalResult> {
  const userMessage = `From: ${fixture.input.from}
Subject: ${fixture.input.subject}
Date: ${fixture.input.date}

${fixture.input.bodyText}`;

  const start = Date.now();
  const { text, usage } = await classify(apiKey, systemPrompt, userMessage);
  const latencyMs = Date.now() - start;

  const allItems = tryParse(text);
  if (!allItems) {
    return {
      fixtureId: fixture.id,
      pass: false,
      checks: {
        quadrant: { expected: fixture.expected.quadrant, actual: "PARSE_FAIL", pass: false },
        category: { expected: fixture.expected.category, actual: "PARSE_FAIL", pass: false },
        importanceBucket: { expected: fixture.expected.importanceBucket, actual: "low", pass: false },
        urgencyBucket: { expected: fixture.expected.urgencyBucket, actual: "low", pass: false },
        calendarEvent: { expected: fixture.expected.createsCalendarEvent, actual: false, pass: false },
      },
      raw: { parseError: true, rawText: text },
      costCents: computeCost(usage),
      latencyMs,
    };
  }

  // For compound fixtures (expectedCount > 1), find the best-matching item by
  // quadrant (then category as tiebreaker) since ordering is non-deterministic.
  // For single-item fixtures, use items[0].
  const expectedCount = fixture.expected.expectedCount ?? 1;
  let parsed: Record<string, unknown>;
  let matchedIndex = 0;
  if (expectedCount > 1 && allItems.length > 1) {
    // Score each item: 2 points for quadrant match, 1 for category match
    let bestScore = -1;
    for (let i = 0; i < allItems.length; i++) {
      let score = 0;
      if (allItems[i]!.quadrant === fixture.expected.quadrant) score += 2;
      if (allItems[i]!.category === fixture.expected.category) score += 1;
      if (score > bestScore) { bestScore = score; matchedIndex = i; }
    }
    parsed = allItems[matchedIndex]!;
  } else {
    parsed = allItems[0]!;
  }
  const actualQuadrant = parsed.quadrant as string;
  const actualCategory = parsed.category as string;
  const actualImportance = toBucket(parsed.importance as number);
  const actualUrgency = toBucket(parsed.urgency as number);
  const actualCalendar = parsed.suggested_calendar_event != null;
  const actualMerge = parsed.updates_existing != null;

  const checks: EvalResult["checks"] = {
    quadrant: {
      expected: fixture.expected.quadrant,
      actual: actualQuadrant,
      pass: actualQuadrant === fixture.expected.quadrant,
    },
    category: {
      expected: fixture.expected.category,
      actual: actualCategory,
      pass: actualCategory === fixture.expected.category,
    },
    importanceBucket: {
      expected: fixture.expected.importanceBucket,
      actual: actualImportance,
      pass: actualImportance === fixture.expected.importanceBucket,
    },
    urgencyBucket: {
      expected: fixture.expected.urgencyBucket,
      actual: actualUrgency,
      pass: actualUrgency === fixture.expected.urgencyBucket,
    },
    calendarEvent: {
      expected: fixture.expected.createsCalendarEvent,
      actual: actualCalendar,
      pass: actualCalendar === fixture.expected.createsCalendarEvent,
    },
  };

  if (fixture.expected.shouldMerge != null) {
    checks.merge = {
      expected: fixture.expected.shouldMerge,
      actual: actualMerge,
      pass: actualMerge === fixture.expected.shouldMerge,
    };
  }

  // Check item count for compound fixtures
  if (expectedCount > 1 || allItems.length > 1) {
    checks.itemCount = {
      expected: expectedCount,
      actual: allItems.length,
      pass: allItems.length === expectedCount,
    };
  }

  const pass = Object.values(checks).every((c) => c.pass);

  return {
    fixtureId: fixture.id,
    pass,
    checks,
    raw: { ...parsed, ...(matchedIndex > 0 ? { _matchedIndex: matchedIndex } : {}) },
    allItems: allItems.length > 1 ? allItems : undefined,
    costCents: computeCost(usage),
    latencyMs,
  };
}

// ---------------------------------------------------------------------------
// Confusion matrix
// ---------------------------------------------------------------------------

const ALL_QUADRANTS: Quadrant[] = ["hot", "action", "plan", "monitor", "noop"];

function buildConfusionMatrix(results: EvalResult[], fixtures: EvalFixture[]): Record<Quadrant, Record<string, number>> {
  const matrix: Record<Quadrant, Record<string, number>> = {} as Record<Quadrant, Record<string, number>>;
  for (const q of ALL_QUADRANTS) {
    matrix[q] = {};
    for (const q2 of ALL_QUADRANTS) matrix[q][q2] = 0;
  }

  for (const r of results) {
    const fixture = fixtures.find((f) => f.id === r.fixtureId);
    if (!fixture) continue;
    const expected = fixture.expected.quadrant;
    const actual = r.checks.quadrant.actual;
    if (matrix[expected]) {
      matrix[expected][actual] = (matrix[expected][actual] || 0) + 1;
    }
  }
  return matrix;
}

function printConfusionMatrix(matrix: Record<Quadrant, Record<string, number>>) {
  const labels = ALL_QUADRANTS;
  const colW = 9;
  const rowW = 9;

  let header = " ".repeat(rowW) + "  ";
  for (const l of labels) header += l.padStart(colW);
  console.log(header);

  for (const expected of labels) {
    let row = expected.padEnd(rowW) + "  ";
    for (const predicted of labels) {
      const val = matrix[expected]?.[predicted] || 0;
      row += String(val).padStart(colW);
    }
    console.log(row);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Error: ANTHROPIC_API_KEY environment variable is required.");
    process.exit(1);
  }

  const fixtures = await loadFixtures();
  if (fixtures.length === 0) {
    console.error("No fixtures found in", FIXTURES_DIR);
    process.exit(1);
  }

  console.log(`\n  Classifier Eval Harness`);
  console.log(`  Model: ${MODEL}`);
  console.log(`  Fixtures: ${fixtures.length}`);
  console.log(`  Concurrency: ${CONCURRENCY}`);
  console.log();

  const systemPrompt = buildSystemPrompt([], [], new Date().toLocaleString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
    timeZone: "America/Chicago",
  }));

  // Run fixtures with bounded concurrency
  const results: EvalResult[] = [];
  const queue = [...fixtures];

  async function worker() {
    while (queue.length > 0) {
      const fixture = queue.shift()!;
      const tag = `[${results.length + 1}/${fixtures.length}]`;
      try {
        const result = await runFixture(fixture, apiKey, systemPrompt);
        results.push(result);
        const icon = result.pass ? "PASS" : "FAIL";
        const line = `  ${tag} ${icon}  ${fixture.id}`;
        console.log(line);
        if (!result.pass && VERBOSE) {
          for (const [name, check] of Object.entries(result.checks)) {
            if (!check.pass) {
              console.log(`         ${name}: expected=${check.expected} actual=${check.actual}`);
            }
          }
        }
      } catch (err) {
        console.error(`  ${tag} ERROR ${fixture.id}: ${err}`);
        results.push({
          fixtureId: fixture.id,
          pass: false,
          checks: {
            quadrant: { expected: fixture.expected.quadrant, actual: "ERROR", pass: false },
            category: { expected: fixture.expected.category, actual: "ERROR", pass: false },
            importanceBucket: { expected: fixture.expected.importanceBucket, actual: "low", pass: false },
            urgencyBucket: { expected: fixture.expected.urgencyBucket, actual: "low", pass: false },
            calendarEvent: { expected: fixture.expected.createsCalendarEvent, actual: false, pass: false },
          },
          raw: { error: String(err) },
          costCents: 0,
          latencyMs: 0,
        });
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, fixtures.length) }, () => worker());
  await Promise.all(workers);

  // Compute summary
  const passed = results.filter((r) => r.pass).length;
  const quadPass = results.filter((r) => r.checks.quadrant.pass).length;
  const catPass = results.filter((r) => r.checks.category.pass).length;
  const impPass = results.filter((r) => r.checks.importanceBucket.pass).length;
  const urgPass = results.filter((r) => r.checks.urgencyBucket.pass).length;
  const calPass = results.filter((r) => r.checks.calendarEvent.pass).length;
  const totalCost = results.reduce((s, r) => s + r.costCents, 0);
  const avgLatency = results.reduce((s, r) => s + r.latencyMs, 0) / results.length;

  const confusionMatrix = buildConfusionMatrix(results, fixtures);

  const summary: EvalSummary = {
    timestamp: new Date().toISOString(),
    model: MODEL,
    totalFixtures: fixtures.length,
    passed,
    failed: fixtures.length - passed,
    accuracy: passed / fixtures.length,
    quadrantAccuracy: quadPass / results.length,
    categoryAccuracy: catPass / results.length,
    importanceAccuracy: impPass / results.length,
    urgencyAccuracy: urgPass / results.length,
    calendarAccuracy: calPass / results.length,
    confusionMatrix,
    totalCostCents: totalCost,
    avgLatencyMs: Math.round(avgLatency),
    results,
  };

  // Print summary
  console.log(`\n  ─── Results ───`);
  console.log(`  Overall:    ${passed}/${fixtures.length} (${(summary.accuracy * 100).toFixed(1)}%)`);
  console.log(`  Quadrant:   ${(summary.quadrantAccuracy * 100).toFixed(1)}%`);
  console.log(`  Category:   ${(summary.categoryAccuracy * 100).toFixed(1)}%`);
  console.log(`  Importance: ${(summary.importanceAccuracy * 100).toFixed(1)}%`);
  console.log(`  Urgency:    ${(summary.urgencyAccuracy * 100).toFixed(1)}%`);
  console.log(`  Calendar:   ${(summary.calendarAccuracy * 100).toFixed(1)}%`);
  console.log(`  Cost:       ${totalCost.toFixed(3)}c`);
  console.log(`  Avg latency: ${summary.avgLatencyMs}ms`);

  console.log(`\n  ─── Confusion Matrix (rows=expected, cols=predicted) ───`);
  printConfusionMatrix(confusionMatrix);

  if (summary.failed > 0) {
    console.log(`\n  Failed fixtures:`);
    for (const r of results.filter((r) => !r.pass)) {
      console.log(`    - ${r.fixtureId}`);
      for (const [name, check] of Object.entries(r.checks)) {
        if (!check.pass) {
          console.log(`      ${name}: expected=${check.expected} actual=${check.actual}`);
        }
      }
    }
  }

  // Write report
  const outputPath = args.output || join(import.meta.dirname!, "results", `${MODEL}_${Date.now()}.json`);
  await mkdir(join(import.meta.dirname!, "results"), { recursive: true });
  await writeFile(outputPath, JSON.stringify(summary, null, 2));
  console.log(`\n  Report: ${outputPath}\n`);

  process.exit(summary.failed > 0 ? 1 : 0);
}

main();
