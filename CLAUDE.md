# Personal Assistant iOS App ("whyapp") — Project Brief

## What we are building
A simplified personal-assistant iOS app for solo distribution to 1–2 testers via TestFlight. v1 features:
- Gmail triage (read + classify + suggested actions)
- Google Calendar read + write (with suggestion-from-content workflow)
- Document / image ingestion (Claude vision OCR)
- Voice capture + transcription (Claude audio)
- Trainable priority/urgency that learns from per-item feedback
- Push notifications for high-priority items
- Conversational chat, reminders, and external iCal feed subscriptions
- **Controlled mode** (spend control): per-user toggle that pauses all
  automatic polling/classification and instead does it one manual,
  batch-sized step at a time, with high-priority push disabled.

Goal: ~6–8 weeks at ~10–15 hrs/week. Operating cost target ~$20–35/mo.

> Note: the codebase has progressed well past the original week-by-week
> plan. Auth, Gmail triage, calendar, capture, push, chat, reminders, and
> iCal feeds are all implemented. There is also an `apps/web` Worker.
> Treat the milestones below as historical context, not current TODOs.

## Active priorities

The current focus is reliability, not new features. See **`EVALUATION.md`** in
the repo root for the full audit and prioritized recommendations. Where this
file and `EVALUATION.md` disagree, `EVALUATION.md` is more recent and wins.

Top-of-stack work, in order:

1. **Build a classifier eval harness** (`apps/api/evals/`) — **DONE**.
2. **Run baseline eval against Sonnet and Opus** — **DONE**. See
   `apps/api/evals/results/BASELINE.md`. Outcome: Sonnet beats Opus on quadrant
   accuracy (80.4% vs 76.1%) at 6.4× lower cost. Switch the classifier to
   Sonnet (`claude-sonnet-4-6`).
3. **Reframe to source-agnostic action items + Monitor class** — **DONE**. See
   `REFRAME.md`.
4. **Execute `PRODUCT_DIRECTIONS.md`.** Five product changes that came out of the
   baseline eval + labeling exercise, in order: (1) compound input splitting,
   (2) quadrant transitions data model + audit, (3) manual quadrant movement UI,
   (4) time-based auto-promotion, (5) spawned action items. Each is its own
   session. This is the active stack.
5. **Fix the remaining §6 bugs in `EVALUATION.md`.** Many are 1-line silent-failure
   bugs (cron schedule running 6× more often than intended, Gmail body extractor
   missing nested multipart and HTML-only emails). Strike #1, #5, #8 first —
   the reframe in step 3 makes them unreachable.
6. **Switch chat from regex JSON-action-blocks to Anthropic `tool_use`.** The
   current `routes/chat.ts` parses tool calls via regex with `catch {}` swallows;
   malformed model output silently no-ops while the reply still says "done."
   This is the single largest reliability issue in the codebase.
7. **Two-pass classifier** (extract facts → score against rubric) for fact
   reliability. Validate runs against the eval harness.

Working conventions for changes:

- After pushing a feature branch on behalf of the user, automatically open
  a PR against `main` and merge it (standard `merge` method, matching the
  history). Don't wait for an explicit "merge" instruction.
- Don't touch prompts or models without running evals before + after.
- Don't add new features until the §6 bugs are fixed.
- Migrations are the source of truth for the DB schema, not `db/schema.sql`
  (which is stale — see below).
- Every classifier-touching change should add or update an eval fixture.

## Locked decisions
- Mobile: **Expo (React Native) + TypeScript**, distributed via **EAS Build -> TestFlight**.
- Backend: **Cloudflare Workers + D1 + R2 + Queues** (Hono framework). Requires Workers Paid plan.
- AI: **Anthropic Claude only**. Code currently pins `claude-opus-4-7` in both `services/claude.ts` and `routes/chat.ts` — this is drift from the original spec and a known cost issue. Target end state: `claude-sonnet-4-5` for triage / vision / audio, `claude-opus-4-7` reserved for chat reasoning where it's worth the 5× cost, `claude-haiku-4-5-20251001` for cheap secondary calls (e.g. web-search summarization). Wire model strings per call-site.
- Auth: **Google OAuth** = app identity.
- Domain: **`whyapp.us`** via Cloudflare Registrar. API at `api.whyapp.us`. OAuth callback at `https://api.whyapp.us/auth/google/callback`.
- iOS URL scheme: `whyapp://`
- Apple Developer account active.

## Current state (already done)
- Domain `whyapp.us` registered in Cloudflare.
- GitHub repo `wesyoakum/assistant` created; pnpm monorepo scaffold pushed to `main`.
- Google Cloud project `whyapp` configured:
  - APIs enabled: Gmail API, Google Calendar API
  - OAuth consent screen: External, Testing mode
  - Scopes: openid, userinfo.email, userinfo.profile, gmail.readonly, calendar.events, calendar.readonly
  - Test user: owner Gmail added
  - OAuth client `whyapp-worker` (Web application):
    - Client ID: `913020422844-pj24uj82ln4kqhru1skoj9sbh0uimqfs.apps.googleusercontent.com`
    - Client Secret: held by owner -- to stash in Worker secret `GOOGLE_CLIENT_SECRET`
    - Authorized redirect URI: `https://api.whyapp.us/auth/google/callback`
- Local working copy at `C:\dev\assistant`.

## Repo layout
assistant/
package.json
pnpm-workspace.yaml
tsconfig.base.json
.gitignore
apps/
mobile/ # Expo app (expo-router)
api/ # Cloudflare Worker (Hono)
packages/
shared/ # shared TS types

## Backend architecture (Cloudflare Worker)

Stack: Hono on Workers; D1 for data; R2 for files/audio; Workers Queues for async work; Cron Trigger for polling.

### D1 tables

**Source of truth: `apps/api/migrations/*.sql`, applied in numeric order.**
`apps/api/src/db/schema.sql` is the original `0001_init` and is stale — it
does **not** reflect later migrations (no `source_json`, `thread_id`,
`extracted_content`, `event_at`, `due_at`, `source_title`, `source_url`,
`event_created_at`, `event_updated_at`, etc.). Bootstrapping a new D1 from
`schema.sql` will give a broken DB. Either reconcile `schema.sql` or
delete it.

Tables (live, as of latest migration `0016_quadrant_and_monitor.sql`):

- `users` — id, google_sub (unique), email, name, picture_url, timestamps.
- `oauth_tokens` — encrypted access + refresh tokens (AES-GCM envelope encryption), scope, expires_at.
- `triage_items` — unified inbox. Key columns:
  `source_type` (`email | document | image | voice | chat | calendar | event`),
  `quadrant` (`hot | action | plan | monitor | noop` — classifier-predicted,
  primary classification target), `next_check_at` (Monitor re-check date),
  `priority` (importance 1–5), `urgency` (1–5),
  `source_json`, `thread_id`, `extracted_content`, `source_title`, `source_url`,
  `event_at`, `due_at`, `event_created_at`, `event_updated_at`.
- `feedback` — kind (up|down|wrong_priority), corrected_priority, corrected_urgency, note.
- `calendar_suggestions` — title, start/end ISO, location, status, google_event_id.
- `calendar_sync_state` — per (user, calendar, event) hash for change detection.
- `ingested_files` — kind, r2_key, status.
- `push_tokens` — expo_token (unique), platform.
- `notification_log` — outbound push history (title, body, category, optional triage_item_id).
- `gmail_sync_state` — history_id, last_synced_at.
- `user_settings` — mode (normal|controlled) + controlled_batch_size.
- `pending_emails` — controlled-mode buffer (source_type added in 0015 so it now also holds calendar events and captures awaiting manual classification).
- `user_context` — kind/label/detail rows that feed the classifier prompt and chat (people, dates, preferences, feature requests).
- `user_calendar_prefs` — per-calendar enabled flag.
- `reminders` — id, user_id, message, fire_at, status (pending|fired|cancelled).
- `chat_messages` — persisted chat history.
- `chat_summaries` — chunk + mega summaries used to keep chat context bounded.
- `ical_feeds` — external iCal URLs subscribed by the user.
- `api_usage` — per-call cost log (model, purpose, tokens, cache hits, cost_cents).

### API surface (Hono routes)
All authed endpoints require `Authorization: Bearer <session_jwt>`. JWT is HS256, signed with `SESSION_JWT_SECRET`, 30-day expiry.

- Auth: `GET /auth/google/start`, `GET /auth/google/callback` (redirects to `whyapp://auth?token=...`), `POST /auth/logout`, `GET /me`.
- Triage: `GET /triage`, `GET /triage/:id`, `PATCH /triage/:id`, `POST /triage/:id/feedback`, `POST /triage/:id/status`, `POST /triage/:id/reevaluate`, plus top-level `POST /triage/fresh-start` and `POST /triage/reclassify-all` (in `src/index.ts`).
- Gmail: `POST /gmail/sync` (manual trigger; also called by cron, no-ops if user is controlled).
- Calendar: `GET /calendar/events`, `GET /calendar/suggestions`, `POST /calendar/suggestions/:id/accept`, `POST /calendar/suggestions/:id/reject`, `POST /calendar/events`.
- Files: `POST /files/upload` (proxy through Worker, ≤100MB), `POST /files/:id/complete`, `GET /files/:id`, `GET /files/:id/download` (token-in-query supported for in-app browser open).
- Push: `POST /push/register`, `POST /push/unregister`.
- Context: `GET /context`, `POST /context`, `DELETE /context/:id` — user-context entries (people, preferences, features).
- Chat: `POST /chat` (sends a message; emits regex-parsed `save_context` / `save_triage` / `edit_triage` / `create_reminder` / `create_event` / `edit_event` / `delete_event` / `search_web` blocks — **migration target: Anthropic tool_use**), `GET /chat/greeting`, `GET /chat/history`, `DELETE /chat/history`.
- Control (spend / controlled mode):
  - `GET /control/status` — current mode, batch size, collected count + preview.
  - `POST /control/mode` — set `{ mode?, batch_size? }`.
  - `POST /control/collect` — step 1: raw Gmail + calendar + capture pull (no Claude); buffers into `pending_emails` (source_type distinguishes kinds).
  - `POST /control/classify-next` — step 2: classify up to `batch_size` buffered items.
- Usage: `GET /usage` — per-day cost rollup from `api_usage`.

### Controlled mode behavior
- Cron skips `gmail.poll` for controlled users; `handleGmailPoll` and `POST /gmail/sync` also no-op as defense in depth.
- `push.send` is suppressed for controlled users (single choke point), so high-priority push is off in controlled mode.
- All classify+store is centralized in `services/classify.ts` (`classifyAndStore`), shared by email, calendar, file, and chat paths. `classifyAndStoreEmail` is a thin wrapper that delegates to `classifyAndStore`.
- Mobile: Settings is tabbed (General / Calendars / Context); the Controlled-mode toggle + batch-size stepper live under General. The Triage tab shows Collect / Classify-next controls when controlled.

### Triage loop
Cron Trigger → enqueues `gmail.poll` per non-controlled user → consumer pulls new messages since `history_id` (cap 20) → enqueues `triage.classify` per item → `classifyAndStore` calls Claude → writes `triage_items` row (with `quadrant`) + optional `calendar_suggestions` row → if quadrant is `hot`, enqueues `push.send` → POST to `https://exp.host/--/api/v2/push/send`. The same `scheduled()` handler also: polls iCal feeds, fires due reminders, bumps overdue items' urgency to 5, auto-dismisses past Noop calendar items, auto-archives 14-day-old Noop items (Plan and Monitor are long-lived by design), re-surfaces Monitor items in the morning briefing when `next_check_at` is due, sends event heads-up 30 min before, and at 13:00 UTC sends a morning briefing + overdue digest.

**Known bug:** `wrangler.toml` cron is `"* * * * *"` (every minute) and `scheduled()` does not gate by minute, so Gmail polling and iCal sync run every minute instead of every 10. Either minute-gate inside `scheduled()` or use multiple cron lines. See EVALUATION.md §5.3.

### Claude prompt design (`apps/api/src/prompts/triage-system.ts`)

The prompt is the strongest part of the codebase — keep the design, harden the plumbing.

- **Five quadrants** (primary classification): Hot, Action, Plan, Monitor, Noop. The classifier picks the quadrant directly; dimension scores are supplementary ranking within a quadrant. Monitor items have a `next_check_at` date for re-surfacing.
- **5-dimension scoring** (1–5 each): Impact, Meaning, Responsibility, Time-Sensitivity, Immediacy. Synthesized into **Importance** + **Urgency** (1–5 each), with caps in the prompt: Importance ≤ max(Impact, Meaning, Responsibility); Urgency ≤ max(Time-Sensitivity, Immediacy). **Caps are not yet enforced server-side** — should be clamped in `services/classify.ts` after parse.
- **Confidence (1–5)** plus a **required `clarification_question`** when confidence ≤ 2 (enforced by Zod `.refine` in `triage.schema.ts`).
- **Source-agnostic framing**: the prompt handles inputs from email, calendar, captures, iCal feeds, and chat through a single classify path. "Noop" classifications are stored so the user sees what was processed.
- **`updates_existing`** field lets the classifier merge a follow-up into an existing open item instead of creating a duplicate (`classifyAndStore` performs the merge).
- **Per-user context** is injected: regular context entries appear under "User Context"; entries with `kind = 'preference'` appear under "Classification Rules (MUST follow these)" — preferences are hard rules, context is background.
- **Feedback few-shot**: last 10 corrections globally injected as `<example>` blocks. Known weakness: not relevance- or category-matched; invalidates the prompt cache every time. See EVALUATION.md §2.1.
- **Prompt caching**: currently a single `cache_control: ephemeral` breakpoint wrapping the entire system prompt. Volatile feedback + user_context sits inside the breakpoint, so cache rarely hits. Target restructure: two breakpoints — static rubric (long-lived) | volatile context (short-lived).
- **Output validation**: Zod schema in `triage.schema.ts`; retry once with the parse error appended. Final fallback returns Importance/Urgency=3, confidence=1, summary = subject. Known issue: fallback rows look identical to real classifications in the UI — flag as `{"fallback": true}` in `classifier_json` and surface it.

### OAuth security
- Master key in `wrangler secret put OAUTH_ENCRYPTION_KEY` (32-byte base64).
- Per-token: random 12-byte IV, AES-GCM encrypt access + refresh tokens, store {ciphertext, iv} in D1.
- Mobile holds only the Worker session JWT (in `expo-secure-store`); Google tokens never leave the Worker.

## Mobile app (Expo)
Stack: Expo SDK latest, `expo-router` (file-based), TS strict, React Query for server state, Zustand for tiny auth-mirror state, `expo-secure-store`, `expo-image-picker`, `expo-document-picker`, `expo-av` (recording -- needs EAS dev build), `expo-notifications`.

Screens (in `apps/mobile/app/`):
- `sign-in.tsx` — Google sign-in via `WebBrowser.openAuthSessionAsync` to `/auth/google/start`.
- `(tabs)/triage.tsx` — inbox grouped by quadrant, pull-to-refresh, Collect/Classify-next controls in controlled mode.
- `triage/[id].tsx` — detail screen with quadrant badge, P/U badge, expandable 5-dimension score pickers + reasoning, source content (email body / calendar event details / file preview), buttons: Discuss in Chat, Open Original, Re-evaluate, Dismiss.
- `(tabs)/email.tsx` — email-source triage view.
- `(tabs)/calendar.tsx` — upcoming events + pending suggestions banner.
- `(tabs)/capture.tsx` — Camera / Document / Voice memo.
- `(tabs)/chat.tsx` — conversational assistant, persisted history, deep-link from triage detail.
- `(tabs)/settings.tsx` — tabbed: General (account, sign out, push toggle, controlled-mode toggle + batch size) / Calendars / Context.
- `notifications.tsx` — notification log view.

## Google API gotchas
- Stay in OAuth Testing mode for v1 (no verification needed, 100 test users max).
- Refresh tokens expire after 7 days in Testing mode -- build re-auth UX (catch 401 -> back to sign-in) from day one.
- Add each tester Gmail to test users before they sign in.
- Privacy policy URL + homepage URL must be reachable on `whyapp.us` even in Testing.
- Defer brand verification + production publishing past v1.

## Push notifications
- Generate APNs Auth Key (.p8) in Apple Developer; upload to EAS via `eas credentials`.
- On first launch after sign-in: `Notifications.getExpoPushTokenAsync({projectId})` -> POST `/push/register`.
- Worker pushes via `https://exp.host/--/api/v2/push/send`; deep link `whyapp://triage/<id>`.
- Trigger: priority >= 4.

## Historical milestones

The original week-by-week plan (Foundations → Auth → Gmail polling → Triage detail / Calendar → Capture → Push + TestFlight) is complete in substance. Kept here only for context; do not treat as TODOs. New work is driven by `EVALUATION.md`.

## Key files (current)

Backend (`apps/api/`):
- `wrangler.toml` — D1, R2, Queue bindings; cron triggers; secrets list.
- `src/index.ts` — Hono router, `scheduled()` cron handler, queue consumer, fresh-start / reclassify-all routes, Expo push helper.
- `src/routes/` — `auth`, `triage`, `gmail`, `calendar`, `chat`, `files`, `context`, `push`, `control`, `usage`.
- `src/services/` — `gmail`, `google-calendar`, `claude`, `classify`, `context`, `settings`, `ical`, `crypto`, `jwt`.
- `src/prompts/` — `triage-system.ts` (the system prompt builder), `triage.schema.ts` (Zod result schema).
- `src/middleware/auth.ts` — JWT verification + `userId` injection.
- `src/db/schema.sql` — original `0001_init`; **stale, do not trust** (see "D1 tables" above).
- `migrations/0001_init.sql` … `migrations/0015_pending_source_type.sql` — applied in order; source of truth.

Mobile (`apps/mobile/`):
- `app.json`, `eas.json` — bundle id `us.whyapp`, scheme `whyapp`, plugins.
- `src/api/client.ts` — typed fetch with session JWT.
- `src/state/auth.ts` — SecureStore + Zustand.
- `src/hooks/useNotifications.ts` — Expo push token registration + deep-link routing.
- `app/_layout.tsx`, `app/(tabs)/_layout.tsx` — expo-router layouts.
- `app/sign-in.tsx`, `app/index.tsx`, `app/notifications.tsx`.
- `app/(tabs)/{triage,email,calendar,capture,chat,settings}.tsx`.
- `app/triage/[id].tsx`, `app/triage/_layout.tsx`.

Shared (`packages/shared/src/`):
- `types.ts` — `TriageItem`, `FeedbackKind`, `FeedbackRow`, `CalendarSuggestion`, `QueueMessage`, etc.

Other:
- `apps/web/src/index.ts` — small marketing/privacy-policy Worker for `whyapp.us`.

## Operating cost (2 testers)

Original target: ~$20–35/mo + $99/yr Apple. Current spend is likely 3–10× the Anthropic line item because of (a) the model drift to Opus on the classifier and (b) the every-minute cron schedule running Gmail polling 6× more often than intended. Both are tracked in `EVALUATION.md` §6 (bugs #2 and #13).

Once those are fixed, the target stands:

- Apple Developer: ~$8/mo
- Domain: ~$1/mo
- Cloudflare Workers Paid: ~$5/mo
- Anthropic API (Sonnet classifier + Opus chat, with restructured caching): ~$7–20/mo
- EAS: free tier

Total: ~$20–35/month + $99/yr Apple. Check `GET /usage` for actual rolling spend.
