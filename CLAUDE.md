# Personal Assistant iOS App ("whyapp") — Project Brief

## What this is

A chat-first personal assistant for solo use, distributed to 1–2 testers via
TestFlight. The triage / classifier pipeline that the project started with has
been removed. The current shape is:

- **Chat** is the primary interface. It can read your synced emails, calendar
  events, and pending reminders, set reminders, and persist memories
  ("remember that…", "from now on…") into `user_context` so future chats
  pick them up automatically.
- **Raw data tabs** (Email, Calendar, Capture) show synced source data with
  manual Sync buttons. No classification, no scoring, no ranking.
- **GroupMe** smoke-test integration: per-user encrypted token, read-only API
  wrappers for groups + messages.

## Stack (locked)

- Mobile: **Expo (React Native) + TypeScript**, distributed via **EAS Build → TestFlight**.
- Backend: **Cloudflare Workers + D1 + R2** (Hono framework). Workers Paid plan.
- AI: **Anthropic Claude** for chat. Currently `claude-opus-4-7` for chat
  (see `apps/api/src/services/claude.ts`).
- Auth: **Google OAuth** = app identity.
- Domain: **`whyapp.us`**. API at `api.whyapp.us`. OAuth callback at
  `https://api.whyapp.us/auth/google/callback`.
- iOS URL scheme: `whyapp://`

## Repo layout

```
assistant/
  package.json, pnpm-workspace.yaml, tsconfig.base.json
  apps/
    mobile/   # Expo app (expo-router)
    api/      # Cloudflare Worker (Hono)
    web/      # marketing + privacy-policy Worker for whyapp.us
  packages/
    shared/   # tiny shared TS types
```

## Backend (`apps/api/`)

Hono on Workers; D1 for data; R2 for files; a 1-minute cron for firing
reminders. The queue binding is kept but unused — the consumer drains
messages.

### Live D1 tables (source of truth: `apps/api/migrations/*.sql`)

- `users` — id, google_sub, email, name, picture_url
- `oauth_tokens` — encrypted Google access + refresh tokens (AES-GCM)
- `gmail_sync_state` — history_id for incremental Gmail sync
- `pending_emails` — raw store for synced emails (`source_type='email'`)
  and calendar events (`source_type='calendar'`); chat reads from here
- `calendar_sync_state` — per-(user, calendar, event) hash for change detection
- `user_calendar_prefs` — per-calendar enabled flag + alias
- `ical_feeds`, `ical_events` — external iCal subscriptions
- `ingested_files` — uploaded files in R2 (kind, r2_key, status)
- `user_context` — kind / label / detail. Chat memory.
  `kind='preference'` entries are surfaced as hard rules in the chat prompt.
- `chat_messages`, `chat_summaries` — chat history and rollups
- `reminders` — chat-created reminders (id, message, fire_at, status)
- `push_tokens` — Expo push tokens
- `notification_log` — outbound reminders
- `api_usage` — per-call cost log
- `groupme_tokens` — per-user encrypted GroupMe access tokens

Dropped in migration `0019_drop_triage.sql`: `triage_items`, `feedback`,
`calendar_suggestions`, `user_settings`, plus the `triage_item_id` columns
on `reminders` and `notification_log`.

### API surface (Hono routes)

All authed endpoints require `Authorization: Bearer <session_jwt>`.
JWT is HS256, 30-day expiry.

- **Auth:** `GET /auth/google/start`, `GET /auth/google/callback`, `POST /auth/logout`, `GET /me`.
- **Gmail:** `POST /gmail/sync`, `GET /gmail/emails`, `DELETE /gmail/emails`.
- **Calendar:** `GET /calendar/events`, `POST /calendar/sync`, `POST /calendar/events`,
  per-calendar toggles + aliases, iCal feed CRUD, `DELETE /calendar/data`.
- **Files:** `POST /files/upload` (≤100MB to R2), `GET /files`, `GET /files/:id`, `GET /files/:id/download`.
- **Chat:** `POST /chat` (Anthropic tool_use — `create_reminder`, `save_context`),
  `GET /chat/greeting`, `GET /chat/history`, `DELETE /chat/history`.
- **Context:** `GET /context`, `POST /context`, `DELETE /context/:id` — manual
  user_context management. The chat's `save_context` tool writes to the same table.
- **Push:** `POST /push/register`, `POST /push/unregister` (for reminder delivery).
- **Usage:** `GET /usage*` — per-day cost rollup.
- **GroupMe:** `GET /groupme/connect`, `GET /groupme/callback` (OAuth flow);
  `POST /groupme/token` (paste an existing access token directly);
  `GET /groupme/status`, `GET /groupme/me`, `GET /groupme/groups`,
  `GET /groupme/groups/:id/messages`, `DELETE /groupme/` (disconnect).

### Chat memory

The chat system prompt injects two slots of `user_context`:

- Entries with `kind='preference'` appear under **User Preferences (follow these)**
  as hard rules the assistant must follow.
- Other entries appear under **Remembered Context** as background facts.

The `save_context` tool lets the model write new entries when the user says
"remember that…" / "from now on…" / "I prefer…". Use a descriptive kind
(`person`, `project`, `fact`, `habit`, `goal`) for background; use `preference`
for behavioral rules.

### Cron

`crons = ["* * * * *"]`. The single job in `scheduled()` fires due reminders
and ships them as Expo push.

### OAuth security

- Master key in Worker secret `OAUTH_ENCRYPTION_KEY` (32-byte base64).
- Per-token: random 12-byte IV, AES-GCM encrypt access + refresh tokens,
  store `{ciphertext, iv}` in D1.
- Mobile holds only the Worker session JWT (in `expo-secure-store`); third-party
  tokens (Google, GroupMe) never leave the Worker.

## Mobile (`apps/mobile/`)

Stack: Expo SDK 54, `expo-router` (file-based), TS strict, React Query, Zustand,
`expo-secure-store`, `expo-image-picker`, `expo-document-picker`, `expo-av`,
`expo-notifications`.

Tabs:
- `chat.tsx` — primary interface.
- `email.tsx` — raw email list with Sync button.
- `calendar.tsx` — upcoming events with Sync button.
- `capture.tsx` — camera / document / voice memo upload.
- `settings.tsx` — General (account, sign out, clear chat / emails / calendar) +
  Calendars (per-calendar toggle + alias + iCal feed CRUD).

## Google API gotchas

- Stay in OAuth Testing mode for v1 (no verification, 100 test users max).
- Refresh tokens expire after 7 days in Testing mode — build re-auth UX
  (catch 401 → back to sign-in) from day one.
- Add each tester Gmail to test users before they sign in.

## GroupMe gotchas

- The OAuth callback URL configured in the GroupMe app must match
  `https://api.whyapp.us/groupme/callback` for the OAuth flow to work.
- The dev access token shown on the app's dev.groupme.com page can be pasted
  directly into `POST /groupme/token` to skip OAuth entirely (this is the
  fastest path for owner-only testing).
- `GROUPME_CLIENT_ID` is a non-secret app ID; set via
  `wrangler secret put GROUPME_CLIENT_ID` only if you want `/groupme/connect`.

## Push notifications

- Generate APNs Auth Key (.p8) in Apple Developer; upload via `eas credentials`.
- On first launch after sign-in: `Notifications.getExpoPushTokenAsync({projectId})`
  → `POST /push/register`.
- Worker pushes via `https://exp.host/--/api/v2/push/send`.
- Only the `reminder` category is in use.

## Key files

Backend (`apps/api/`):
- `wrangler.toml` — D1, R2, Queue bindings; cron; secrets list.
- `src/index.ts` — Hono router, reminders cron, push helper, queue drain.
- `src/routes/` — `auth`, `gmail`, `calendar`, `chat`, `files`, `context`, `push`, `usage`, `groupme`.
- `src/services/` — `gmail`, `google-calendar`, `claude` (just `CHAT_MODEL` + `logUsage`),
  `ical`, `crypto`, `jwt`, `groupme`.
- `src/middleware/auth.ts` — JWT verification + `userId` injection.
- `migrations/0001_init.sql` … `migrations/0019_drop_triage.sql` — append-only.

Mobile (`apps/mobile/`):
- `app.json`, `eas.json` — bundle id `us.whyapp`, scheme `whyapp`.
- `src/api/client.ts`, `src/state/auth.ts`, `src/hooks/useNotifications.ts`.
- `app/_layout.tsx`, `app/(tabs)/_layout.tsx`, `app/sign-in.tsx`, `app/index.tsx`.
- `app/(tabs)/{chat,email,calendar,capture,settings}.tsx`.

Shared (`packages/shared/src/types.ts`): minimal — `User` only.

## Operating cost (2 testers)

- Apple Developer: ~$8/mo
- Domain: ~$1/mo
- Cloudflare Workers Paid: ~$5/mo
- Anthropic API (chat-only, Opus): variable, check `GET /usage`
- EAS: free tier
