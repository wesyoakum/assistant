# Product Directions — Post-Baseline-Eval Decisions

**Status:** approved direction, not implemented. Order is roughly cheapest + highest-leverage first.
**Origin:** these five changes came out of the May 18 baseline eval + labeling exercise (`apps/api/evals/results/BASELINE.md`). The labeling disagreements between Wes and the model surfaced product gaps, not bugs. This doc captures the resulting decisions.

---

## Sections at a glance

1. **Compound input splitting** — one input can produce N triage items.
2. **Quadrant transitions** — items travel through quadrants over their lifetime.
3. **Time-based urgency promotion** — Plan→Action at 7d out, Action→Hot at 24h.
4. **Manual quadrant movement** — UI/chat buttons to move items between quadrants.
5. **Spawned action items** — completing an item proposes follow-ups.
6. **Proactive probes (chat-driven)** — chat asks "did you book a hotel?" for events that imply adjacent logistics.
7. **Cross-source linking and lifecycle events** — confirmations, updates, cancellations, and conflicts across email/calendar/etc. for the same real-world thing.

---

## 1. Compound input splitting

**One input can produce N triage items, not one.**

Today the classifier returns one `TriageResult` per input. When an email or chat message contains multiple unrelated obligations, the classifier picks one and silently drops the others. The eval fixture `edge-chat-multi-action-01` ("call dentist, file taxes, book Phoenix flight") makes this concrete: the user expects three items, not one.

### Schema
- `triage_items` already supports multiple rows per source. No DB change.
- All N rows share `source_ref`, `source_json`, and a new optional `compound_idx` (0, 1, 2…) for ordering within a compound.

### Zod schema (`triage.schema.ts`)
- Change response shape from `TriageResult` to `{ items: TriageResult[] }`.
- For single-item inputs (the common case), the array has length 1.
- Each item carries its own quadrant, scores, summary, suggested_action, etc.

### Prompt (`triage-system.ts`)
- Replace: *"identify the ACTION required (if any)"*
- With: *"Identify each distinct action item in the input. For most inputs, this is exactly one. For inputs that explicitly contain multiple unrelated obligations (e.g., 'call the dentist, file taxes, and book a flight'), return one entry per obligation. Do not split a single complex action into pieces — a kitchen renovation thread is one action ('decide on quartz upgrade'), not three."*
- Add an example showing 2+ items extracted from a compound input.

### Service (`services/classify.ts`)
- `classifyAndStore` loops over `result.items` and writes one row per entry.
- All rows share the same `source_ref`. `source_json` is the same payload.
- High-priority push fires once per compound, on the highest-quadrant item.

### UI (mobile)
- Triage list already handles multiple rows; no change.
- Detail screen: show "X of Y from this input" badge when `compound_idx > 0` or sibling rows exist.

### Eval acceptance
- `edge-chat-multi-action-01` produces 3 items: dentist (Action M/M), taxes (Hot or Action H/H), Phoenix flight (Plan H/L).
- All single-input fixtures produce exactly 1 item.
- Harness: `tryParse` reads `items[0]` for backward-compat single-item checks; new harness flag `--multi` checks array length matches an `expected_count` field.

---

## 2. Quadrant transitions (data model + audit)

**Items travel through quadrants over their lifetime.** The classifier picks the initial quadrant; transitions thereafter are driven by time (cron), user action (manual buttons), or re-classification.

### Schema migration `0017_quadrant_transitions.sql`
```sql
ALTER TABLE triage_items ADD COLUMN quadrant_changed_at TEXT;
ALTER TABLE triage_items ADD COLUMN auto_promote_at TEXT; -- nullable
ALTER TABLE triage_items ADD COLUMN parent_id TEXT REFERENCES triage_items(id); -- for §5

CREATE TABLE IF NOT EXISTS triage_events (
  id TEXT PRIMARY KEY,
  triage_item_id TEXT NOT NULL REFERENCES triage_items(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL CHECK(event_type IN (
    'created', 'quadrant_changed', 'status_changed', 'next_check_at_set',
    'spawned_from_parent', 'auto_promoted'
  )),
  from_quadrant TEXT,
  to_quadrant TEXT,
  from_status TEXT,
  to_status TEXT,
  trigger TEXT, -- 'user', 'cron', 'classifier'
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_triage_events_item ON triage_events(triage_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_triage_items_auto_promote ON triage_items(auto_promote_at) WHERE auto_promote_at IS NOT NULL;
```

### API
- `POST /triage/:id/move` — body `{ to_quadrant, next_check_at?, note? }`.
- `POST /triage/:id/status` (existing) stays for `done`/`dismissed`.
- Every transition writes a row to `triage_events`.

### Mobile UI
Triage detail screen (`apps/mobile/app/triage/[id].tsx`) — replace the current single Dismiss button with a row of transition actions:

- **Promote to Action** (visible if quadrant ∈ {plan, monitor})
- **Plan** (visible if quadrant ∈ {hot, action})
- **Move to Monitor** (visible always; opens date picker for `next_check_at`)
- **Done** (existing)
- **Dismiss** (existing)

Quadrant badge animates when transitioned. Optional: small "Recently moved from Plan" caption that fades after a few seconds.

### Eval impact
None — eval tests initial classification only. Transitions are an in-app feature.

---

## 3. Time-based urgency promotion

**The system already bumps urgency to 5 when items go overdue (cron). Extend to actual quadrant promotion.**

### Cron additions (`apps/api/src/index.ts:scheduled()`)
- Plan items with `event_at` or `due_at` within 7 days → promote to Action. Write `triage_events` row with `trigger='cron'`, `event_type='auto_promoted'`.
- Action items with `event_at` or `due_at` within 24 hours → promote to Hot. Same audit row.
- Items with `auto_promote_at` past → promote to the target quadrant set by the classifier (the classifier can predict trajectories — see Prompt below).
- Monitor items with `next_check_at` past → already re-surfaced in morning briefing. Keep that.

### Prompt addition
- Classifier may return optional `auto_promote_at: { date, to_quadrant }` to declare an intended transition trigger.
- Example: a Plan item for a graduation 4 days out might emit `auto_promote_at: { date: "2026-05-21T00:00:00-05:00", to_quadrant: "hot" }` to escalate the day-of.

### Push impact
Items auto-promoted to Hot fire the existing high-priority push. Auto-promotion to Action is silent (shows up in morning briefing only).

---

## 4. Manual quadrant movement (UI)

Covered in §2 — bundled with quadrant transitions because they share schema/API.

### Additional consideration: chat-driven movement
The chat handler should accept "move that to monitor" / "promote the dentist thing to action" / "demote that, I have time" via the same `POST /triage/:id/move` endpoint. This works whether chat is tool-calling (target state) or regex JSON blocks (current).

---

## 5. Spawned action items

**Completing an action can produce follow-on actions.** When the user marks "decide on vacation dates" Done, the completion likely spawns "book hotel," "book flights," "tell family."

Two complementary flavors:

### A. At-completion prompting (primary)

When user taps Done, a Claude call analyzes the completed item + any captured details and proposes follow-ups.

**Flow:**
1. User taps Done on item X.
2. Mobile sends `POST /triage/:id/complete` (new endpoint, distinct from `/status`).
3. Worker calls Claude with the completed item + recent chat about it + suggested_action: *"Based on this completion, what follow-up actions might be needed? Return 0–5 proposed items with summaries and suggested quadrants."*
4. Server returns proposed items to mobile.
5. Mobile shows a confirmation sheet: "Generated follow-ups: ☐ Book hotel, ☐ Tell family. [Add all] [Skip]"
6. User confirms which to create. Confirmed items get `parent_id = X` and `event_type='spawned_from_parent'`.

### B. Pre-planned chains (secondary)

Classifier may return optional `next_actions_hint: string[]` at creation time for items that have predictable follow-ups (e.g., booking a trip → predict "confirm with travel companions").

- Stored on the original item, not yet materialized.
- Shown in the detail screen as "Possible follow-ups: …"
- User can promote any hint to a real triage item with one tap.

### Schema (already covered by §2)
- `parent_id` column on `triage_items` references the completed item that spawned this one.
- `triage_events` records `spawned_from_parent` events.
- `next_actions_hint` stored in `classifier_json` (no new column).

### UI
- Triage detail: "Spawned from: [parent summary]" link when `parent_id` is set.
- Triage list: optional nesting/grouping by `parent_id` (defer to v2).
- Done flow: spawn modal as described above.

### Eval
- New fixture type `completion-event` — represents a completion + context, asks the classifier what follow-ups should fire.
- Add 3–5 fixtures of this type once the feature lands. Don't block §1–4 on this.

---

## 6. Proactive probes (chat-driven)

**Some items imply adjacent considerations the user may not have thought through.** Waco tournament in 2 weeks → do you have a hotel? Wedding invitation → did you get a gift? New baby announcement → meal train? Conference accepted → flight, hotel, talk prep, expense report?

These aren't classifications. They're **conversational probes** that fire after classification, surface through chat (not the classifier), and only spawn triage items when the user confirms the topic is unresolved.

**Key design decision:** the classifier identifies *which topics* are probe-worthy but does NOT compose the questions. The chat handler — which has full user context via `buildFullContext` — composes the actual question, checks whether the topic is already resolved (e.g., a hotel may already be on the calendar), and asks 1–2 probes per chat session. If more are pending, chat offers the user a choice: ask the rest now, or save them for later.

### Classifier side (minimal)

Add optional output field:

```ts
probe_topics: z.array(z.string()).max(5).optional()
// e.g. ["hotel", "travel", "time_off", "gift"]
```

The classifier emits topic *strings*, not formulated questions. Topics should be emitted only when the input is event-shaped (out-of-town, multi-day, first-time, novel commitment) AND common adjacent logistics aren't obviously already in flight. Do NOT emit for routine recurring events or pure Noop items.

The prompt teaches the topic vocabulary with examples:
- Out-of-town tournament → `["hotel", "travel", "time_off"]`
- Wedding invitation → `["gift", "rsvp", "attire", "travel"]`
- Baby announcement from a friend → `["meal_train", "visit", "gift"]`
- Conference acceptance → `["flight", "hotel", "talk_prep", "expense_report"]`

### Schema

```sql
-- New table tracking probe state per (item, topic)
CREATE TABLE IF NOT EXISTS probes (
  id TEXT PRIMARY KEY,
  triage_item_id TEXT NOT NULL REFERENCES triage_items(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  topic TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
    'pending', 'asked', 'answered_yes', 'answered_no', 'dismissed', 'skipped_already_handled'
  )),
  asked_at TEXT,
  answered_at TEXT,
  spawned_item_id TEXT REFERENCES triage_items(id), -- if answered_yes, the spawned item
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_probes_pending ON probes(user_id, status) WHERE status = 'pending';
CREATE UNIQUE INDEX idx_probes_unique ON probes(triage_item_id, topic);
```

When the classifier emits `probe_topics`, `classifyAndStore` writes one `probes` row per topic with `status='pending'`.

### Morning briefing flow

The existing daily briefing (`scheduled()` at 13:00 UTC) gains a probe-asking step:

1. Pull pending probes for the user, joined to their parent triage items.
2. Sort by parent item's importance + recency.
3. For the top 1–2 probes, call Claude with full context (`buildFullContext`) asking: *"Given everything you know about the user, formulate the right way to ask about TOPIC for this item. If the topic is already resolved (e.g., calendar shows a hotel booked), return `skip: true` instead."*
4. If Claude returns `skip: true`, mark the probe `status='skipped_already_handled'` and move on. The user is never bothered.
5. Otherwise, the formulated question goes into the morning briefing push + a chat-injected message: *"Coming up: Waco tournament in 11 days. Have you booked a hotel?"*
6. If more than 2 probes remain after the picks, append a single line: *"I have N more questions about upcoming items — want to handle them now or wait?"* User can say "more" / "later" / nothing.

### Chat handling

The chat handler recognizes responses to probes (use Anthropic tool_use once §6 of EVALUATION.md is fixed; for now, regex matching against the last probe topic asked):

- **"Yes, need a hotel"** → spawn a triage item with `parent_id` and `topic` baked in (e.g., "Book hotel for Waco tournament May 30"). Mark probe `answered_yes` with `spawned_item_id`.
- **"No, staying with the Reeds"** → mark probe `answered_no`, optionally save to user_context (`kind='dates'`, `label='Waco tournament lodging'`, `detail='staying with Reeds'`).
- **"More"** → trigger another probe pass with the next 1–2 pending probes.
- **"Later"** / "skip" → mark current probes `status='asked'` (won't reappear today, will re-surface next briefing if still pending after N days).
- **"Stop asking me about gifts"** → save a preference (`kind='preference'`, `label='no_gift_probes'`). Future `gift` topics get auto-skipped.

### Mobile UI

**Triage detail screen** — under the suggested action, show a subtle line when probes exist:

> **Probes:** hotel ⏳ · travel ✓ booked · time_off ✗ (handled by Stacy)

Tap any probe → routes to chat with that probe pre-loaded for discussion. ⏳ = pending, ✓ = answered yes/already handled, ✗ = answered no/dismissed.

**No checklist on the detail screen.** All probe answering happens in chat. The detail screen just shows current state.

### Cron throttling

Don't ask the same probe twice in 7 days. If a probe was `status='asked'` (user said "later"), wait 7 days before re-surfacing. If the parent item is dismissed or done, its pending probes are auto-marked `dismissed`.

### Eval

New fixture type `probe-event` — represents an event input + expected probe topics. Test:
- Waco tournament input → `probe_topics: ["hotel", "travel"]` (at least)
- Wedding invite → `probe_topics: ["gift", "rsvp"]` (at least)
- Routine recurring lesson → `probe_topics` not emitted or empty
- Self-created travel reservation with `Response: Yes, I'm going` → `probe_topics` empty (already handled)

Add 4–6 of these once §6 is being built. Eval check is *topic coverage* (did the model name the right topic at all), not exact string match.

### Acceptance criteria

- A Waco tournament event 2 weeks out classifies as Plan, emits `probe_topics: ["hotel", "travel", "time_off"]`.
- The next morning briefing asks 1–2 of those probes in chat, omitting any that are already resolved (e.g., if calendar has a hotel for that weekend).
- User answers "yes" → new triage item appears with `parent_id` set.
- User answers "no, staying with friends" → answer is captured (in user_context or probe row), no new item.
- Same probe is never asked twice within 7 days.

---

## 7. Cross-source linking and lifecycle events

**Multiple inputs often describe the same real-world thing.** A Hilton booking confirmation email AND a calendar event for the same stay. A doctor's appointment reschedule email AND the original calendar invite. A subscription cancellation AND the recurring billing reminder it terminates. Today the classifier creates separate triage items for each input; the user ends up with duplicates that drift out of sync.

This section covers four related but distinct cases — all of them are "how does this new input relate to an existing item in the user's world?"

### The four intents

| Intent | Example | What happens to the existing item |
|---|---|---|
| **append** | Confirmation email for an event already on the calendar | Source list grows; no state change. |
| **update** | "Your appointment time changed to 3pm" | Fields on the existing item updated; prior values kept in source_json. |
| **resolve** | "Your reservation has been cancelled" / "Refund processed" | Existing item moves to `status='dismissed'` (or `'done'`) with a reason. Often spawns a follow-up. |
| **contradicts** | Calendar shows May 22, email confirms May 23 | No silent fix; classifier flags the conflict and routes to chat for user disambiguation. |

### Schema — `updates_existing` becomes structured

Replace the current string field (item ID) with an object on the classifier output:

```ts
updates_existing?: z.object({
  id: z.string(),                          // existing triage_item id
  intent: z.enum(['append', 'update', 'resolve', 'contradicts']),
  // For resolve:
  resolve_status: z.enum(['cancelled', 'completed', 'expired', 'failed']).optional(),
  reason: z.string().max(280).optional(),
  // For update:
  field_updates: z.record(z.string(), z.any()).optional(),  // e.g. { event_at: "2026-05-23T..." }
  // For all intents — optional follow-ups (esp. common for resolve):
  spawned_followups: z.array(triageResultSchema).max(3).optional(),
}).optional()
```

Note: this composes with §1 (compound splitting). One classifier response can contain `items[]` for new things AND `updates_existing` for an existing thing — they're not mutually exclusive. A cancellation email might also contain new information worth a separate item.

### Matching mechanism — hybrid

Two-stage match before/during classification, ordered cheapest first:

**Stage 1 — Deterministic fingerprint (cheap pre-pass):**
- Extract from the input: `confirmation_number`, `ical_uid` (from `text/calendar` MIME parts), `vendor`, `date_range`.
- Compute a fingerprint hash.
- Query `triage_items.fingerprint` (new indexed column, populated at write time).
- If exact match found → set `updates_existing.id` before the classify call; classifier fills in `intent` based on input semantics.

**Stage 2 — Classifier semantic match (fallback):**
- The classifier already sees up to 50 open triage items (`classify.ts` lines 47–67).
- Prompt expansion: *"If this input describes the same real-world commitment as an existing triage item — including across sources, including resolutions (cancellations, refunds), and including reschedules — set `updates_existing` with the appropriate `intent`. Use `contradicts` when the input conflicts with the existing item rather than resolving or updating it."*

### Schema migration `0018_cross_source_linking.sql`

```sql
ALTER TABLE triage_items ADD COLUMN fingerprint TEXT;
ALTER TABLE triage_items ADD COLUMN resolved_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_triage_items_fingerprint
  ON triage_items(user_id, fingerprint) WHERE fingerprint IS NOT NULL;
```

Fingerprint format: a stable string like `hilton:97431926` or `ical:abc123@google.com` or `vendor:vendor-name:2026-05-29`. Populated by a small `extractFingerprints(input)` helper in `services/fingerprint.ts` that runs deterministic regex/parser logic — no LLM call.

### Service handling per intent

In `classifyAndStore`, after parse but before insert:

- **append:** Append to `source_json` array, optionally re-score (the new input may shift importance/urgency), no status change. Already roughly what today's merge does.
- **update:** Apply `field_updates` to the existing row. Log a `triage_events` row with `event_type='content_updated'`, store the prior values.
- **resolve:** Move existing item to `status='dismissed'` (or `'done'` if `resolve_status='completed'`). Set `resolved_reason`. Log a `triage_events` row. If `spawned_followups` is non-empty, create those items with `parent_id` pointing to the resolved one.
- **contradicts:** Do NOT modify the existing item. Create a new low-confidence triage item with a `clarification_question` like *"The dental office confirmed May 23, but the calendar shows May 22. Which is correct?"* Mark both items with a `conflicts_with` cross-link (or store conflict pair in `triage_events`).

### Prompt additions

Three teaching examples in the prompt:

1. **Append example:** Same Hilton confirmation email + existing Hilton calendar event for May 29-31 → `updates_existing: { id: "...", intent: "append" }`.
2. **Resolve example:** Hilton cancellation email + existing stay item → `updates_existing: { id: "...", intent: "resolve", resolve_status: "cancelled", reason: "Customer cancelled, refund processed", spawned_followups: [{ summary: "Track $X refund from Hilton", quadrant: "monitor", next_check_at: "<+7d>" }] }`.
3. **Contradict example:** Email confirms May 23 appointment, calendar shows May 22 → `updates_existing: { id: "...", intent: "contradicts" }`, with the new item carrying confidence=2 and a clarification question.

### Mobile UI implications

- **Append:** Triage detail screen renders both source blocks in date order (email content + calendar event details, side by side or stacked). Already implied by §1's multi-source rendering work.
- **Update:** Show a small "Updated: <field> from X to Y on <date>" caption under the relevant field. Audit trail accessible via the existing `triage_events` table.
- **Resolve:** Item disappears from the main list (it's dismissed/done). Spawned follow-ups appear, each with a "Spawned from: [cancelled Hilton stay]" link. Optional: a "Recently resolved" section in the daily briefing surfaces these the day they happen.
- **Contradicts:** Conflict items appear with a distinct visual treatment (yellow warning border?) and surface their `clarification_question` prominently. Chat handler proactively asks about them in the next briefing.

### Cron / chat implications

- The morning briefing's existing past-due check (`chat.ts` line 740) extends to also surface unresolved conflicts: *"I noticed a scheduling conflict on your dental appointment — May 22 vs May 23. Which is correct?"*
- The probe-skip logic from §6 shares the same `findRelatedItems(content, env)` helper used for cross-source matching.

### Eval

New fixture type `linked-input` — pairs an existing-item snapshot with a new input, tests that the classifier emits the right `updates_existing` intent. Tests:

- **Append:** Hilton confirmation email + existing Hilton calendar event → `intent='append'`.
- **Resolve with spawn:** Hilton cancellation email + existing Hilton stay → `intent='resolve'`, status `'cancelled'`, spawned refund-tracker.
- **Update:** Doctor's office reschedule email + existing appointment → `intent='update'`, field_updates contains new date.
- **Contradicts:** Conflicting appointment times between two sources → `intent='contradicts'`, new item has confidence=2 + clarification_question.

Add 4–6 of these once §7 is being built.

### Acceptance criteria

- Hilton confirmation email arrives after the calendar event is already on file → no new triage item; existing one absorbs the email as a source.
- Hilton cancellation email arrives → existing Hilton stay item moves to dismissed with reason; a new Monitor item for "track refund" appears with `parent_id` linking back.
- Doctor's office reschedule email arrives → existing appointment item's `event_at` updates to the new time; audit row captures the change.
- Two inputs disagree on appointment date → classifier flags `contradicts`, neither input silently overwrites the other; chat proactively asks for disambiguation.

---

## Order of operations

These can land in roughly seven sessions, in this order:

1. **§1 Compound input splitting.** Pure classifier change. Re-run eval; `edge-chat-multi-action-01` should now produce 3 items. Cheapest big win.
2. **§2 Quadrant transitions schema + audit + API.** Foundation for everything else. No UI yet — can be tested via curl against `POST /triage/:id/move`.
3. **§4 Manual transition UI.** Exposes the new capability. The triage detail screen grows transition buttons.
4. **§3 Time-based auto-promotion.** Extends existing cron logic. Requires §2 to log transitions.
5. **§5 Spawned action items.** At-completion follow-ups (5A first, 5B later). Adds `parent_id` linkage that §6 and §7 both reuse.
6. **§7 Cross-source linking and lifecycle events.** Builds on §5's `parent_id`. Append/update/resolve covers ~90% of the value; `contradicts` can ship as a stretch goal.
7. **§6 Proactive probes.** Largest UX lift; depends on §5's `parent_id`, §7's `findRelatedItems` helper, and the chat-tool-use migration from EVALUATION.md §5.4. Do last.

---

## What this does NOT change

- The five-quadrant model itself (Hot / Action / Plan / Monitor / Noop). No new quadrants.
- The 5-dimension rubric (Impact, Meaning, Responsibility, Time-Sensitivity, Immediacy).
- The confidence + clarification mechanism.
- Anthropic as sole provider.
- The eval harness format — fixtures still test single-input classification per row; compound output is tested by checking the new `items[]` array length.
- The reframe in `REFRAME.md` — this builds on that foundation, doesn't replace it.

## Open product questions to revisit after §1 ships

These came up in the labeling exercise and aren't resolved by the changes above. Capture them now; decide later:

1. **Should the classifier elevate Importance for family/personal items by default?** Currently it doesn't. Wes's scoring suggests yes. Could be a user-context preference ("Family items are high-importance to me") rather than a prompt default.
2. **Hot calibration — "drop everything right now" vs "high-importance + closing window"?** The §3 auto-promotion to Hot codifies the latter — items become Hot as their deadline closes. That may resolve this naturally without changing the initial-classification calibration.
3. **`createsCalendarEvent` semantics.** A few of Wes's notes captured the right nuance: "the action might *produce* a calendar event later, but the triage item itself shouldn't trigger one now." Consider splitting into `creates_calendar_event_on_completion` vs `is_already_a_calendar_event`.
