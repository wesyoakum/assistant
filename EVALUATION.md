# whyapp — Approach Evaluation

**Scope of this audit:** classifier effectiveness, fact reliability, and the app's usefulness for preventing gaps in attention, execution, and follow-up. Also a hard look at whether the tech stack is helping or hurting those goals.

**TL;DR:** The classifier *design* is unusually thoughtful — better than most production triage systems I've seen. The *plumbing around it* (Gmail body extraction, chat tool-calling via regex, feedback-as-few-shot, file-classify code path) is where the system bleeds reliability today. None of this requires changing the tech stack. It requires (1) an eval harness, (2) fixing about a dozen concrete bugs, and (3) one or two targeted architecture moves (real tool use in chat, two-stage classification for facts). Recommendations are listed at the end with priority.

---

## 1. What's working well

### The classifier prompt is genuinely good design
`apps/api/src/prompts/triage-system.ts` does several things right:

- **Five-dimension scoring** (Impact, Meaning, Responsibility, Time-Sensitivity, Immediacy) synthesized into Importance + Urgency, with explicit caps (`Importance CANNOT be higher than the max of Impact, Meaning, and Responsibility`). This separates the things that actually matter and resists the common trap of letting urgency inflate importance.
- **Confidence + required clarification question** when confidence ≤ 2 (`triage.schema.ts` line 32–38 enforces it with a Zod `.refine`). This is the right way to handle ambiguity — surface the question instead of making up an answer.
- **Action-not-summary** framing in the system prompt: "Your job is to identify the ACTION required (if any), not to summarize the input." This is the right primitive for an assistant.
- **Quadrant model** (Hot / Action / Plan / Noop) flows consistently from prompt → DB → chat → mobile UI. The model is internalized end-to-end.
- **Per-user context entries** distinguish background facts (`kind != preference`) from explicit classification rules (`kind = preference`), and the latter are surfaced in the prompt as "MUST follow these." Good separation.
- **`updates_existing` merge** (`classify.ts` lines 88–129) lets the classifier roll a follow-up email into the existing triage item instead of creating a duplicate. Most triage systems don't do this.
- **Reasoning + 5-dim scores persisted** to `classifier_json` and shown in the detail screen (`apps/mobile/app/triage/[id].tsx` lines 374–402), so the user can see *why* an item was scored the way it was, and edit any dimension.

### Follow-up mechanics that work
- Overdue urgency bump in cron (`index.ts` line 315) — items past `due_at`/`event_at` get auto-bumped to urgency 5.
- Auto-archive stale low-priority items (>14 days, P≤2, U≤2).
- Event heads-up notification 30 min before, deduplicated against `notification_log`.
- Daily morning briefing + overdue digest at 13:00 UTC.
- Chat handler proactively prompts about past-due items ("did this happen, or reschedule?") via the system prompt instruction at `chat.ts` lines 276–283.
- Controlled mode is well-designed — single choke points (`isControlled` checks in `handleGmailPoll` and `handlePushSend`) plus a manual `/control/collect` and `/control/classify-next` flow.

### Solid foundations
- D1 schema is well-indexed for the read patterns the app actually uses.
- OAuth tokens are AES-GCM encrypted with envelope encryption.
- API usage logging (`api_usage` table) gives you a real cost view.
- The unified `buildFullContext` in `services/context.ts` means chat and the classifier share one source of truth.

---

## 2. Classification effectiveness — issues

### 2.1 Feedback-as-few-shot has structural problems
At `classify.ts` lines 28–38 and `index.ts` lines 749–757 you fetch the most recent 10 feedback rows and inject them into the system prompt. Three issues:

1. **No relevance matching.** A correction on a "newsletter" item gets used to score a "health" item. As the corpus grows, the few-shot becomes noise. You'd want to filter by category, or by embedding similarity to the current input.
2. **It invalidates the prompt cache every time.** The `cache_control: ephemeral` breakpoint in `claude.ts` line 215 wraps the *entire* system prompt, which includes the feedback section. Any new feedback row → cache miss → full re-write. The "prompt caching saves money" assumption is partially fictional with the current layout. Fix: split into two cache breakpoints — one for the static rubric (cached forever), one for the volatile context+feedback (cached briefly).
3. **The model isn't told what to *do* with the examples.** Each `<example>` describes "the user corrected this to X" but there's no instruction like "Use these to calibrate your scoring on similar items." It's left to in-context learning, which is unreliable for small N.

### 2.2 The classifier does too much in one pass
A single call produces: action extraction, 5 dimension scores, 2 synthesized scores, confidence, category, summary, suggested_action, reasoning, optional `clarification_question`, optional `suggested_calendar_event`, optional `updates_existing` merge target. With `max_tokens: 1024` and verbose reasoning, JSON truncation is a real failure mode (see 2.3).

A two-pass design (extract structured facts → score against the rubric) gives you:
- Higher fact reliability (facts come out of an extraction pass without the model also having to reason about prioritization).
- Cheaper iteration on the rubric (you can change scoring logic without re-extracting).
- A natural place to enforce server-side guards (e.g., "Importance ≤ max(Impact, Meaning, Responsibility)" can be programmatically enforced after extraction).

### 2.3 The parse-failure fallback silently mislabels items
`claude.ts` lines 90–99: if both Claude calls return unparseable JSON, the fallback returns Importance=3, Urgency=3, confidence=1, summary=email subject, suggested_action="Review this email manually." This item is then inserted into the DB and looks normal in the inbox. The user has no way to know this was a fallback vs a real classification. At minimum, store a flag in `classifier_json` like `{"fallback": true}` and surface it in the UI.

### 2.4 The cap rules in the prompt aren't enforced
The system prompt says "Importance CANNOT be higher than the max of Impact, Meaning, and Responsibility" and analogous for Urgency. The model usually obeys but doesn't always. Nothing in `classify.ts` checks this after parsing. Add a server-side validator/clamp.

### 2.5 The `priority` vs `importance` naming drift causes one outright bug
The schema returns `importance`. The DB column is `priority`. `classifyAndStoreEmail` correctly maps `result.importance` → `priority` (line 113, 147). But **`handleFileClassify` in `index.ts` line 773 binds `result.priority` and `result.urgency`** — and `result.priority` is **undefined**. The CHECK constraint on `priority` will reject the row, so file/image/voice captures get stuck at `status='error'` silently. The console log on line 788 (`P${result.priority}/U${result.urgency}`) prints `Pundefined/U3` if you ever look. **Fix: rename `result.priority` → `result.importance` in `index.ts` line 773.**

### 2.6 Calendar classification is a duplicate, ad-hoc code path
`control.ts` lines 275–332 re-implements the classifier call inline for calendar events, with its own JSON parsing, its own model string, its own fallback (or lack thereof — a parse failure silently drops the item; the `try { ... } catch { /* fallback */ }` on line 331 falls through to nothing). Should be folded into a `classifyCalendarEvent` service (referenced as imported on line 9 but not visible in the path I read — confirm it exists, and route everything through it).

---

## 3. Fact reliability — issues

### 3.1 Email body extraction is the single biggest fact-reliability hole
`gmail.ts` lines 207–223:

```ts
if (data.payload.parts) {
  const textPart = data.payload.parts.find((p) => p.mimeType === "text/plain");
  if (textPart?.body?.data) {
    bodyText = decodeBase64Url(textPart.body.data);
  }
} else if (data.payload.body?.data) {
  bodyText = decodeBase64Url(data.payload.body.data);
}
```

This handles two cases and misses the common ones:
- **Nested multipart.** A typical Gmail message is `multipart/mixed { multipart/alternative { text/plain, text/html } }` or `multipart/alternative { text/plain, text/related { text/html, image/png } }`. `find()` only inspects top-level parts.
- **HTML-only emails.** Many marketing emails, calendar invites, newsletters have *no* text/plain part. `bodyText` ends up empty. The classifier then sees only the subject + sender and has to guess.

You'll want a recursive walk that prefers `text/plain` but falls back to converting `text/html` → text (a tiny tag-stripping function is fine for v1 — you don't need a full DOM parser).

### 3.2 Body truncation at 10k chars cuts off the part that matters most
Line 221–223: `bodyText.slice(0, 10000)`. For long email threads, the most recent reply (the actual action) is usually at the *top* in Gmail's plain-text representation, but if it's a quoted reply you may end up with 10k of quoted history and nothing else. A quote-line stripper (`/^>+ /` and "On <date>, X wrote:" patterns) before truncation would massively help.

### 3.3 `suggested_calendar_event` is pure hallucination risk
The classifier emits `{title, start_iso, end_iso, location}` based on email content. There is no:
- Verification that the date string appears in the email body.
- Constrained decoding for ISO dates.
- Sanity check that `end_iso > start_iso` and both are in the future.

For an "I'll prevent gaps in execution" assistant, an event that gets created for the wrong date is the worst possible outcome — the user trusts the system precisely *because* it's tracking things they might miss. Add a server-side validator that re-extracts dates from the email body and rejects/flags suggestions whose date doesn't appear in the source.

### 3.4 The chat handler's JSON-action-blocks are silently lossy
`routes/chat.ts` parses `save_context`, `save_triage`, `edit_triage`, `create_reminder`, `create_event`, `edit_event`, `delete_event`, `search_web` from the model's reply via regex. Every parse path is wrapped in `try { ... } catch { /* ignore */ }` (lines 484, 512, 559, 601, 617, 636, 649). If the model emits a malformed JSON block, the user gets a confirmation in the chat reply ("I created a reminder for Friday at 3") but **nothing was actually written**. This is the worst failure mode for an assistant — confident wrong execution.

The fix is structural: use Anthropic's tool_use API. Each action becomes a tool with a JSON schema. The model can't emit a malformed call (the SDK rejects it), and you get per-tool errors back into the model so it can retry. This is the single biggest reliability win available, and it's a 1–2 day refactor.

### 3.5 The reminder time parser is permissive in places it shouldn't be
`chat.ts` lines 575–594: an absolute `fire_at` must carry a timezone (good), and relative offsets use a regex. But if Claude emits `+0m` it's silently skipped (line 581) instead of warning the user that their reminder was dropped. The user gets the "Reminder set!" line in the reply and nothing fires. Either tighten the prompt (which is already long) or surface skipped reminders back to the user.

### 3.6 File captures: `extracted_content` is never written
Migration `0013_thread_and_content.sql` adds `extracted_content TEXT` to `triage_items` specifically so chat can answer questions about previously-captured documents (`context.ts` lines 138–143 reads it; chat.ts lines 217–222 surfaces it). But `handleFileClassify` in `index.ts` lines 768–775 never writes it. Every PDF/image/voice capture is OCR'd-by-Claude-once-and-thrown-away. The whole "document memory" feature is wired but disconnected.

The fix is to have `classifyFile` return both the extracted content (transcription, OCR text, image description) *and* the triage classification, then store both. Either two separate prompts/calls or a single prompt that returns both fields.

### 3.7 The model has no calculator and date math is left to it
The system prompt tells the model "When an email says 'tomorrow,' calculate from the email's sent date, not from now." The model is OK at this but not reliable. For high-stakes calculations (deadlines, "in 3 weeks"), pre-compute candidate dates in the user message: `Email sent: Tue Apr 14. Today: Wed May 18. "tomorrow" relative to email = Wed Apr 15.` This anchors the model.

---

## 4. Attention / follow-up usefulness — gaps

The thing you described wanting — "prevent gaps in attention, execution, or follow-up" — is partly built and partly not. Below is what's missing or weak.

### 4.1 The app surfaces items but doesn't track commitments
When the user says in chat "I'll call mom this weekend," the chat handler can save this as `user_context` (a person/relationship note). It will *not* automatically create a triage item or reminder unless the user explicitly asks. So the assistant knows the user said something but takes no action on it. This is the #1 "assistant doesn't actually help" failure pattern.

Fix: a "commitment detection" pass in the chat handler. Either an explicit instruction in the prompt ("If the user states an intention to do something at a future time, emit a `save_triage` block"), or — better — a post-reply classifier call that scans the conversation for commitments and asks the user to confirm.

### 4.2 No snooze, no escalation
- Triage items have only three statuses: `open`, `done`, `dismissed`. There's no `snoozed_until`.
- Reminders fire exactly once. If the push fails or the user clears the notification, nothing re-fires.
- High-priority push has no escalation path — if the user doesn't open the app, the morning briefing is the only re-surfacing mechanism.

Adding `snoozed_until` to triage_items and an escalation tier (e.g., re-fire reminder push after 1 hour if `notification_log` shows no app open) would close real gaps.

### 4.3 The morning briefing is the same shape every day
`index.ts` lines 392–489 generates the briefing from raw counts. There's no personalization, no learned cadence (e.g., user mostly engages on weekday mornings), no skipping of weekends, no "you have a meeting in 2 hours and haven't prepared" reasoning. For a small-N assistant this is fine for v1, but it's not what a "prevent gaps" tool looks like a year in.

### 4.4 Email replies and event acknowledgments are user-side
Push notifications carry a `categoryId: "triage-email"` with a Reply action, but I don't see a `/triage/:id/reply` endpoint anywhere. The Reply button on the iOS push goes... where? Verify this works end-to-end. If it doesn't, that's the missing primitive that turns "triage list" into "assistant that actually does things."

Similarly there's no path to RSVP to a calendar invite from inside the app. Open-original deep-links into Gmail/Calendar are the only way out.

### 4.5 The classifier sees the inbox but doesn't see the calendar
`classify.ts` lines 47–67 passes "open triage items" but not "upcoming calendar events." Chat sees both (`context.ts` line 148). So when the classifier scores a new email about a Tuesday meeting, it doesn't know the user already has 4 meetings that day — which would substantially affect Time-Sensitivity. Add `fullCtx.calendarEvents` (filtered to the relevant window) into the classifier's context.

### 4.6 Threads aren't grouped in the inbox UI
Migration 0013 added `thread_id` to triage_items, and the classifier has the merge mechanism. But the inbox screen treats each item as standalone. A user who gets 4 emails on the same thread sees 4 items unless the classifier explicitly merged them. Even with merges, the *unmerged-but-related* case is common (e.g., a "Re: Re:" that semantically shifts the action). UI-side grouping by `thread_id` would reduce noise.

---

## 5. Tech stack fit — is the foundation right?

### 5.1 The stack itself is fine
Expo + EAS + Cloudflare Workers + D1 + R2 + Queues + Claude is a reasonable choice for a 1–2 tester app maintained by one person. The pieces fit. D1's lack of FTS will sting later but doesn't matter now. Workers' 30-second CPU budget is generous for this workload. Hono is idiomatic for Workers.

**You do not need to change the stack.** The reliability issues are in the application layer, not the platform layer.

### 5.2 Model choice is drifting and expensive
`claude.ts` line 6 and `chat.ts` line 10 both pin `claude-opus-4-7`. The original brief (`CLAUDE.md`) said `claude-sonnet-4-5`. Opus is roughly 5× the input cost and 5× the output cost of Sonnet. With the cron currently running every minute (see 5.3), Gmail polling per user every minute, and Opus on every classify call, your $7–20/mo budget assumption is wrong by a factor of 5–10 today.

I'd recommend: Sonnet for the classifier (Sonnet is more than capable on a well-scoped rubric task), Opus for chat (where reasoning depth matters), Haiku for the second pass on web-search summarization. Wire the model string per call-site rather than as a module constant.

### 5.3 The cron schedule doesn't match the comments
`wrangler.toml` line 38: `crons = ["* * * * *"]` — every minute.
`index.ts` line 224: `// Gmail poll only on the 10-minute cron (*/10)` — claims it polls every 10 minutes.

There's no `now.getUTCMinutes() % 10 === 0` gate before enqueueing `gmail.poll`. **Gmail is being polled every minute for every non-controlled user**, plus iCal feeds are being re-fetched every minute, plus the auto-dismiss/auto-archive sweeps run every minute. 1440 polls/day per user, costing Gmail API quota and Worker invocations for no benefit.

Two fixes, either works:
- Single cron line `* * * * *`; add minute-gated guards: gmail.poll on `% 10`, iCal sync on `% 10`, auto-archive on `% 60`, reminders + heads-up + briefing every minute (current cadence).
- Multiple cron lines in `triggers.crons`: `* * * * *` for reminders, `*/10 * * * *` for Gmail/iCal, `0 13 * * *` for daily briefing. Cloudflare supports multiple crons; the `scheduled()` handler can dispatch by cron pattern.

### 5.4 Chat uses regex tool-calling instead of Anthropic's tool_use API
Already covered in 3.4. This is the largest reliability lever in the codebase. Replacing the JSON-block pattern with structured tool calls would eliminate an entire class of "the model said it did something but nothing happened" failures.

### 5.5 There are no tests
Zero unit tests, zero integration tests, zero classifier evals. For an LLM-driven product this is the largest single risk. A prompt change today can degrade your classifier silently — you'd only know because the user complains.

You need a tiny eval harness:
- 30–100 labeled inputs (you have real Gmail data, so this is cheap to build).
- Each input has expected category, expected priority bucket (1–2 / 3 / 4–5), expected urgency bucket, expected "creates a calendar event" yes/no.
- A script that runs all inputs through the current classifier and reports accuracy + cost.
- CI runs it on every PR.

This is one weekend of work and pays back forever. It's more important than any other recommendation in this document.

### 5.6 Prompt caching is partially fictional
Covered in 2.1. The cache breakpoint includes the per-user volatile context (feedback + user_context + open items). With 2 users and 10+ feedback rows per user, you're paying cache-write cost without hitting cache-read. Restructure to two breakpoints: (static rubric) | (volatile context). The first breakpoint will get real reuse.

### 5.7 Observability is thin
You have `api_usage` for cost. You don't have:
- A view of "what % of classifications had confidence ≤ 2."
- A view of "how often did the user's correction differ from the classifier."
- A view of "queue retry rate" (queue messages are `msg.retry()` on any throw — silent retries can mask real bugs).
- An alert when daily cost spikes.

A small `/admin/dashboard` endpoint that aggregates from `api_usage`, `feedback`, and `notification_log` would let you actually steer.

---

## 6. Concrete bugs found during this audit

These are independent of any larger redesign — fix them either way.

| # | File | Issue | Severity |
|---|---|---|---|
| 1 | ~~`apps/api/src/index.ts:773`~~ | ~~`result.priority` is undefined (schema returns `importance`).~~ **FIXED** — `handleFileClassify` now delegates to `classifyAndStore`; the `result.priority` / `result.importance` drift is gone. | ~~High~~ |
| 2 | `apps/api/wrangler.toml:38` | Cron is `* * * * *` (every minute), but Gmail poll enqueues unconditionally — running 6× more often than intended. | High (cost + Gmail quota) |
| 3 | `apps/api/src/services/gmail.ts:207–223` | Body extractor misses nested multipart and HTML-only emails. Classifier often sees only subject + from. | High |
| 4 | `apps/api/src/routes/chat.ts` (multiple `catch {}` blocks) | Malformed JSON action blocks are silently swallowed; the user sees confirmation text but the action never executed. | High |
| 5 | ~~`apps/api/src/index.ts:768–775`~~ | ~~`extracted_content` is never written.~~ **FIXED** — `classifyAndStore` writes `extracted_content` in the shared INSERT; file path now delegates to it. Column wired but content still needs two-pass classifier to populate. | ~~Medium~~ |
| 6 | `apps/api/src/services/claude.ts:90–99` | Parse-failure fallback creates a triage item that *looks* real but is a confidence-1 default. No flag in the row or UI. | Medium |
| 7 | `apps/api/src/prompts/triage-system.ts` (cache_control) | Volatile feedback rows are inside the same `ephemeral` cache breakpoint as the static rubric — cache rarely hits. | Medium (cost) |
| 8 | ~~`apps/api/src/routes/control.ts:275–332`~~ | ~~Calendar classification is an ad-hoc inline duplicate.~~ **FIXED** — calendar path now delegates to `classifyAndStore`. Inline Claude call and duplicate feedback/context queries deleted. | ~~Medium~~ |
| 9 | `apps/api/src/index.ts` (classifier context) | Classifier sees open triage items but not upcoming calendar events — scores miss the "user is already overcommitted that day" signal. | Medium |
| 10 | `apps/api/src/services/gmail.ts:221–223` | 10k-char truncation often slices off the most recent reply in a long thread. No quote-stripping. | Medium |
| 11 | `apps/api/src/routes/chat.ts:575–594` | Reminder parser silently skips zero/negative offsets — user gets a "set" confirmation, nothing fires. | Medium |
| 12 | `apps/api/src/db/schema.sql` vs `migrations/*.sql` | Drift: schema.sql is the original; many production columns (`source_json`, `thread_id`, `extracted_content`, `event_at`, `due_at`, `source_title`, `source_url`, `event_created_at`, etc.) exist only in migrations. Bootstrapping a new D1 from schema.sql gives a broken DB. | Low (until you spin up a new env) |
| 13 | `apps/api/src/services/claude.ts:5–6` | Model is `claude-opus-4-7`; brief said `claude-sonnet-4-5`. Pricing impact is 5×. | High (cost) |

---

## 7. Recommendations, in priority order

These are the moves I'd make. Each one is bounded — you don't have to commit to all of them.

1. **Build a 50-input classifier eval harness.** Weekend of work. Pays for itself the first time you change a prompt. Without this, every other change is a guess.
2. **Fix the 13 bugs in §6.** They're independent of any redesign. Most are 1–10 line changes.
3. **Switch chat to Anthropic tool_use.** Replaces the regex-JSON pattern in `routes/chat.ts`. Eliminates the silent-drop failure mode and gives you per-tool retries. 1–2 days.
4. **Improve Gmail body extraction.** Recursive multipart walk; HTML-to-text fallback; quote stripping before truncation. Half a day.
5. **Move classifier to two passes.** Pass 1 extracts structured facts (sender, dates mentioned, asks, deadlines). Pass 2 scores against the rubric using those facts. This is the biggest fact-reliability lever and a natural place to enforce server-side guards.
6. **Drop classifier model to Sonnet, keep Opus for chat.** Wire model per call-site. Re-run your eval harness to confirm no regression on classification.
7. **Add server-side validators after parsing.** Cap Importance ≤ max(Impact, Meaning, Responsibility). Verify suggested_calendar_event dates appear in the source. Reject ISO dates in the past.
8. **Add a `fallback: true` flag to `classifier_json`** and a UI hint when fallback fired, so the user knows the classifier punted.
9. **Add commitment detection in chat.** When the user expresses intent ("I'll call her Friday"), surface a "want me to set a reminder?" follow-up.
10. **Add snooze + reminder escalation.** `snoozed_until` column; re-fire reminder push if not acknowledged within X hours.
11. **Write `extracted_content` on file classify.** Either two passes (extract → classify) or have the classifier return both fields in one call.
12. **Re-structure prompt cache breakpoints.** Static rubric in one breakpoint, volatile context in another.
13. **Fix the cron schedule.** Either minute-gate inside `scheduled()`, or use multiple cron triggers.
14. **Reconcile `db/schema.sql` with migrations** (or delete schema.sql entirely and have migrations be the source of truth).

---

## 8. What I'd *not* change

- **Don't switch the tech stack.** Workers + D1 + R2 + Queues is fine. Moving to a different platform would burn weeks and solve no real problem.
- **Don't ditch the 5-dimension rubric.** It's the best thing in the codebase. The fix is to enforce it server-side, not replace it.
- **Don't add more features before fixing reliability.** Every new feature multiplies the surface area of the silent-drop bugs in chat tool-calling and Gmail body extraction. Reliability first.
- **Don't replace Claude with another provider.** Anthropic tool_use + prompt caching + vision + audio in one provider is exactly what this app needs. Multi-provider would 2× the surface area for one-person maintenance.

---

## 9. Frame check

If the question is "is the *approach* right" — yes, the approach is right. A small, fast, single-provider, single-platform assistant that triages your inbox and tracks commitments is a real product, and the bones are in place.

The work ahead isn't "try something different." It's "tighten the existing thing until it earns trust." An assistant that even occasionally tells you it did something it didn't do is worse than no assistant. Closing that gap — primarily by replacing the regex tool-calling and the chat `catch {}` swallows with structured tool use, plus building an eval harness — is the single highest-leverage path forward.
