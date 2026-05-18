# Reframe — Source-Agnostic Action Items + Monitor Class

**Status:** implemented. All 11 steps landed.
**Sequence:** do this before the EVALUATION.md §6 bug sweep — several §6 bugs dissolve by construction once the four classify paths are consolidated.

## Goal

Stop treating email as the primary input. The unit of work is an **action item** with these attributes:

- A **quadrant** (Hot / Action / Plan / Monitor / Noop) — predicted directly by the classifier.
- Supplementary scores (5 dimensions + synthesized Importance + Urgency, kept from the current rubric).
- A **source** (email, calendar, capture, chat, ical) — metadata only, not the driver of a separate code path.
- For Monitor items, a **`next_check_at`** date so they re-surface instead of rotting.

Every input — email, calendar event, captured photo / PDF / voice memo, iCal feed item, chat-created item — flows through one classify path and produces one row shape.

## The five quadrants

The classifier predicts the quadrant directly. Importance and Urgency remain as supplementary scores used for ranking *within* a quadrant.

- **Hot** — act now. Both important and urgent. Examples: child stranded at school; production outage; critical deadline due today; medical emergency.
- **Action** — execute soon. Urgent but lower stakes, or moderately important with timing pressure. Examples: reply to dentist about appointment time; pay a bill due this week; respond to a meeting request.
- **Plan** — execute eventually. Important, not yet urgent. Examples: prep for child's graduation next month; long-term project planning; preventive health appointment to book.
- **Monitor** — *the action is vigilance, not execution*. Examples: a coworker's project that affects yours but isn't yours to drive; a thread where you're waiting for someone else's decision; a package shipment to track; an open question you asked someone, awaiting reply; a kid's grade trend.
- **Noop** — no action ever needed; stored for completeness so the user sees what was processed. Examples: newsletters, receipts, promotional emails, FYI notifications, confirmations of things already on the calendar.

### Monitor rules

- Every Monitor item must have a `next_check_at`. The classifier proposes one; default to **+7 days** if it doesn't specify.
- When `next_check_at` arrives, the item re-surfaces — either as a push (if the user opts in) or in the morning briefing's "Active monitors" section. After re-surface, the user either confirms still-monitoring (extends `next_check_at`), promotes to Action/Plan, or dismisses.
- Monitor items don't trigger high-priority push on creation. They get the daily re-surface mechanism instead.

## Schema migration (new `0016_quadrant_and_monitor.sql`)

```sql
ALTER TABLE triage_items ADD COLUMN quadrant TEXT
  CHECK(quadrant IN ('hot', 'action', 'plan', 'monitor', 'noop'));
ALTER TABLE triage_items ADD COLUMN next_check_at TEXT;
CREATE INDEX IF NOT EXISTS idx_triage_items_monitor
  ON triage_items(user_id, quadrant, next_check_at)
  WHERE quadrant = 'monitor' AND status = 'open';

-- Backfill existing rows from (priority, urgency) using the old derivation
UPDATE triage_items SET quadrant = CASE
  WHEN priority >= 4 AND urgency >= 3 THEN 'hot'
  WHEN priority >= 4 AND urgency < 3 THEN 'plan'
  WHEN urgency >= 4 AND priority < 4 THEN 'action'
  WHEN priority = 3 AND urgency = 3 THEN 'plan'
  WHEN priority = 3 AND urgency < 3 THEN 'noop'
  WHEN priority < 3 AND urgency = 3 THEN 'action'
  ELSE 'noop'
END WHERE quadrant IS NULL;
```

No existing row gets `quadrant = 'monitor'` from backfill — Monitor is new and only assigned by the classifier going forward.

## Zod schema changes (`apps/api/src/prompts/triage.schema.ts`)

Add a required `quadrant` field. Keep importance/urgency/dimensions. Add optional `next_check_at` validated only when `quadrant === 'monitor'`.

```ts
quadrant: z.enum(['hot', 'action', 'plan', 'monitor', 'noop']),
next_check_at: z.string().datetime({ offset: true }).optional(),
// ...existing fields stay...
```

Add a `.refine` requiring `next_check_at` when `quadrant === 'monitor'`. If the model omits it, fill in `+7 days` server-side rather than rejecting.

## Prompt rewrite (`apps/api/src/prompts/triage-system.ts`)

Three changes, kept surgical:

1. **Replace "What action does this require?"** opening with a source-agnostic framing: "You receive inputs from email, calendar, captures (photos, PDFs, voice memos), iCal feeds, and chat. For each input, identify what kind of response it requires from the user."
2. **Replace the "Quadrant Reference"** section with the five definitions above. Make it the *primary* classification target — the model picks the quadrant, then scores the dimensions consistent with that pick.
3. **Add a Monitor-specific subsection** explaining when to pick Monitor (the action is vigilance, not execution; user is not the primary actor, but cares about state changes). Include the `next_check_at` instruction: "If you choose Monitor, propose a `next_check_at` as ISO 8601 with timezone. Default to 7 days from now if you have no better signal."

Keep the 5-dimension rubric, the caps, the confidence + clarification-question rule, and `updates_existing`. Those are the strongest parts.

## Service consolidation

Collapse the four classify paths (`classifyAndStoreEmail`, `handleFileClassify`, the inline calendar classifier in `routes/control.ts`, the chat `save_triage` insert) into one service.

New signature in `services/classify.ts`:

```ts
type ClassifyInput =
  | { kind: 'email'; messageId: string; threadId: string; subject: string; from: string; date: string; bodyText: string }
  | { kind: 'calendar'; eventId: string; calendarId: string; calendarName: string; summary: string; start: string; end: string; location?: string; description?: string }
  | { kind: 'file'; fileId: string; fileKind: 'pdf' | 'image' | 'audio'; r2Key: string }
  | { kind: 'chat'; summary: string; userMessage: string };

export async function classifyAndStore(
  userId: string,
  input: ClassifyInput,
  env: Env
): Promise<{ itemId: string; result: TriageResult }>;
```

Internally it does the source-specific content prep (fetch email body, render calendar event as text, fetch file from R2 + use vision/audio blocks), then dispatches to a shared `callClassifier(systemPrompt, userContent)` helper, then writes the row with the same `triage_items` shape regardless of source.

This deletes:
- The inline Claude call in `routes/control.ts:275–332`.
- The duplicated feedback + context queries in `handleFileClassify`.
- The drift between `result.importance` (email path) and `result.priority` (file path bug).
- The drift in what gets stored in `extracted_content`, `source_json`, `source_title`.

## Mobile UI changes

- `apps/mobile/app/triage/[id].tsx` — read `item.quadrant` directly instead of calling `getQuadrant(priority, urgency)`. Add `monitor` to `QUADRANT_META` with a distinct color (suggest a desaturated blue like `#4a90a4` to signal "watching, not acting").
- `apps/mobile/app/(tabs)/triage.tsx` — add a Monitor section. Group order: Hot → Action → Plan → Monitor → Noop. Monitor items show their `next_check_at` ("Re-checking Fri").
- `apps/mobile/app/(tabs)/chat.tsx` — when a Monitor item comes up in chat, the assistant should ask "Still monitoring, or has this resolved?"
- `apps/api/src/routes/chat.ts:12–22` — delete the `getQuadrant` derivation; read `item.quadrant`. Update the system prompt's Eisenhower-matrix reference to the five-quadrant model.

## Cron changes (`apps/api/src/index.ts:scheduled()`)

- High-priority push trigger: change from `result.importance >= 4 || result.urgency >= 4` to `result.quadrant === 'hot'`. (Action items get queued for the morning briefing, not push.)
- Add a new scan: Monitor items whose `next_check_at <= now` get re-surfaced. First pass: include them in the morning briefing's "Active monitors" section. Push escalation can come later.
- Auto-archive sweep: keep at 14 days, but only for `quadrant = 'noop'`. Don't auto-archive Plan or Monitor items just because they're stale — those are explicitly long-lived.
- Auto-dismiss past calendar items: only when `quadrant = 'noop'`.

## Eval harness changes (`apps/api/evals/`)

- **`types.ts`** — add `Quadrant` type, change `EvalFixture` to include `expected_quadrant: Quadrant` and a `source: 'email' | 'calendar' | 'capture' | 'chat' | 'ical'` field. Keep `expected_importance_bucket` / `expected_urgency_bucket` as supplementary checks.
- **Fixtures** — rename by quadrant + source: `fixtures/noop-email.json`, `fixtures/action-email.json`, `fixtures/monitor-email.json`, etc. Add fresh Monitor fixtures (waiting on someone's reply; tracking a shipment; CC'd on a project status thread). Add at least 2 calendar-source fixtures and 1 capture-source fixture so the harness covers more than email.
- **`run.ts`** — primary correctness metric becomes quadrant accuracy. Keep dimension-bucket checks as secondary metrics. Report a confusion matrix (predicted × expected quadrant) so we can see which quadrants the model confuses.
- Run baseline with current Opus prompt before the prompt rewrite. Then re-run after each prompt change to confirm direction.

## CLAUDE.md / EVALUATION.md updates

After this lands:

- **CLAUDE.md** — replace references to four quadrants with five. Update "Triage loop" to describe `classifyAndStore` instead of four paths. Update D1 tables list to include `quadrant` and `next_check_at`.
- **EVALUATION.md** — strike §6 bugs #1, #5, #8 (they're gone after consolidation). Note that §3.4 (chat tool_use) is unaffected. §5.4 still the next big lever.

## Order of operations

Treat this as a single feature branch:

1. Write migration `0016_quadrant_and_monitor.sql`. Apply locally. Verify backfill.
2. Update Zod schema. Update the prompt. Make these two consistent before touching anything else.
3. Run the eval harness on a few fixtures to confirm the model emits the new field cleanly. If output is rocky, iterate the prompt.
4. Implement `classifyAndStore`. Migrate `classifyAndStoreEmail` to call it. Get one source type working end-to-end.
5. Migrate the file path. Verify the §6 bug #1 is dead (it should be unreachable).
6. Migrate the calendar path. Delete the inline classifier in `routes/control.ts`.
7. Migrate the chat `save_triage` path.
8. Re-label eval fixtures with `expected_quadrant`. Add Monitor fixtures and non-email fixtures. Run the harness; record baseline numbers.
9. Mobile UI: add Monitor to the quadrant meta, render the new section, surface `next_check_at`.
10. Cron updates: push trigger, Monitor re-surface, auto-archive scope.
11. Update CLAUDE.md and EVALUATION.md.

## Open decisions (default if not chosen)

- **Monitor re-surface channel** — default: morning briefing only, no push. Add push as an opt-in setting later.
- **Default `next_check_at` cadence** — +7 days when the classifier doesn't propose one.
- **Confidence ≤ 2 + Monitor** — should the clarification-question rule fire on Monitor items? Default: yes, same rule.
- **Re-classifying old items** — `/triage/reclassify-all` should pass everything through `classifyAndStore` and let the new prompt assign quadrants. Worth running once after the prompt is stable.

## What this does NOT change

- The 5-dimension rubric (Impact, Meaning, Responsibility, Time-Sensitivity, Immediacy). It's the strongest part of the codebase; keep it as supplementary scoring.
- The confidence + `clarification_question` mechanism.
- The `updates_existing` merge logic.
- Anthropic as the sole provider. Tool use migration (EVALUATION.md §5.4) is still a separate, later piece of work.
- The tech stack.
