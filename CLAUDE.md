# Personal Assistant iOS App ("whyapp") — Project Brief

## What we are building
A simplified personal-assistant iOS app for solo distribution to 1–2 testers via TestFlight. v1 features:
- Gmail triage (read + classify + suggested actions)
- Google Calendar read + write (with suggestion-from-content workflow)
- Document / image ingestion (Claude vision OCR)
- Voice capture + transcription (Claude audio)
- Trainable priority/urgency that learns from per-item feedback
- Push notifications for high-priority items

Goal: ~6–8 weeks at ~10–15 hrs/week. Operating cost ~$20–35/mo.

## Locked decisions
- Mobile: **Expo (React Native) + TypeScript**, distributed via **EAS Build -> TestFlight**.
- Backend: **Cloudflare Workers + D1 + R2 + Queues** (Hono framework). Requires Workers Paid plan.
- AI: **Anthropic Claude only**. Model: `claude-sonnet-4-5` for text triage, vision OCR, audio transcription.
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

### D1 tables (define in `apps/api/src/db/schema.sql`)
- `users` -- id, google_sub (unique), email, name, picture_url, timestamps
- `oauth_tokens` -- encrypted access + refresh tokens (AES-GCM envelope encryption), scope, expires_at
- `triage_items` -- unified inbox: source_type (email|document|image|voice), source_ref, priority 1-5, urgency 1-5, suggested_action, classifier_json, status (open|done|dismissed). Index `(user_id, status, created_at DESC)` and `(user_id, priority DESC, urgency DESC)`.
- `feedback` -- kind (up|down|wrong_priority), corrected_priority, corrected_urgency, note. Index `(user_id, created_at DESC)`.
- `calendar_suggestions` -- title, start_iso/end_iso, location, status (pending|accepted|rejected), google_event_id (post-accept).
- `ingested_files` -- kind (pdf|image|audio), r2_key (`users/<uid>/files/<id>.<ext>`), status.
- `push_tokens` -- expo_token (unique), platform.
- `gmail_sync_state` -- history_id, last_synced_at (per user).

### API surface (Hono routes)
All authed endpoints require `Authorization: Bearer <session_jwt>`. JWT is HS256, signed with `SESSION_JWT_SECRET`, 30-day expiry.

- Auth: `GET /auth/google/start`, `GET /auth/google/callback` (redirects to `whyapp://auth?token=...`), `POST /auth/logout`, `GET /me`
- Triage: `GET /triage`, `GET /triage/:id`, `POST /triage/:id/feedback`, `POST /triage/:id/status`
- Gmail: `POST /gmail/sync` (manual trigger; also called by cron)
- Calendar: `GET /calendar/events`, `GET /calendar/suggestions`, `POST /calendar/suggestions/:id/accept`, `POST /calendar/suggestions/:id/reject`, `POST /calendar/events`
- Files: `POST /files/upload` (proxy through Worker, <=100MB), `POST /files/:id/complete`, `GET /files/:id`
- Push: `POST /push/register`, `POST /push/unregister`

### Triage loop
Cron Trigger every 10 min -> enqueues `gmail.poll` per user -> consumer pulls new threads since `history_id` (cap ~20 unread) -> enqueues `triage.classify` per item -> Claude call writes `triage_items` row + optional `calendar_suggestions` row -> if priority >= 4, enqueues `push.send` -> POST to `https://exp.host/--/api/v2/push/send`.

File and voice ingestion reuse `triage.classify` with vision/audio content blocks.

### Claude prompt design (`apps/api/src/prompts/triage-system.ts`)
- Model: `claude-sonnet-4-5`.
- System prompt defines priority/urgency scales 1-5 and a strict output JSON schema (priority, urgency, category, summary, suggested_action, suggested_calendar_event?).
- Inject last ~10 feedback rows per user as <example> blocks in the system prompt -- the "trainable" part.
- Prompt caching: mark static instructions + feedback few-shot as `cache_control: ephemeral`. Per-item content (subject/body) goes outside the cache breakpoint.
- Validate output with a Zod schema (`triage.schema.ts`); retry once on parse failure with the error appended.

### OAuth security
- Master key in `wrangler secret put OAUTH_ENCRYPTION_KEY` (32-byte base64).
- Per-token: random 12-byte IV, AES-GCM encrypt access + refresh tokens, store {ciphertext, iv} in D1.
- Mobile holds only the Worker session JWT (in `expo-secure-store`); Google tokens never leave the Worker.

## Mobile app (Expo)
Stack: Expo SDK latest, `expo-router` (file-based), TS strict, React Query for server state, Zustand for tiny auth-mirror state, `expo-secure-store`, `expo-image-picker`, `expo-document-picker`, `expo-av` (recording -- needs EAS dev build), `expo-notifications`.

Screens (in `apps/mobile/app/`):
- `sign-in.tsx` -- Google sign-in via `WebBrowser.openAuthSessionAsync` to `/auth/google/start`
- `(tabs)/triage.tsx` -- inbox grouped by priority, pull-to-refresh
- `triage/[id].tsx` -- detail + classifier reasoning + thumbs-up/down/wrong-priority + accept calendar suggestion CTA
- `(tabs)/calendar.tsx` -- upcoming events + pending suggestions banner
- `(tabs)/capture.tsx` -- Camera / Document / Voice memo
- `(tabs)/settings.tsx` -- account, sign out, push toggle

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

## Week-by-week milestones (resume here)
1. Week 1 -- Foundations (IN PROGRESS): [done] buy domain, [done] init monorepo. TODO: scaffold Hono Worker + `/health`, scaffold Expo app, create D1 + R2 + first migration, point `api.whyapp.us` at the Worker.
2. Week 2 -- Auth end-to-end: [done] Google Cloud + OAuth client. TODO: Worker auth routes (start/callback/logout/me), JWT issuance, encrypted token storage, mobile sign-in screen, `/me` round-trip.
3. Week 3 -- Gmail polling + basic triage: Gmail client with token refresh; cron + Queue + consumer; Claude classifier; Triage Inbox screen.
4. Week 4 -- Triage detail, feedback, calendar read: detail screen + feedback buttons; wire feedback into classifier few-shot; calendar events + suggestion accept; calendar screen.
5. Week 5 -- Capture: file upload proxy + R2; Claude vision for PDFs/images, audio for voice; Capture screen; first EAS dev build.
6. Week 6 -- Push, polish, TestFlight: APNs key in EAS; push-on-high-priority; static privacy policy + homepage; first EAS production build -> `eas submit -p ios` -> TestFlight.

Budget weeks 7-8 for App Store Connect first-time friction.

## Critical files to create
Backend:
- `apps/api/wrangler.toml` -- D1, R2, Queue bindings; cron trigger; secrets
- `apps/api/src/index.ts` -- Hono router + `scheduled()` + queue consumer
- `apps/api/src/routes/{auth,triage,calendar,files,push}.ts`
- `apps/api/src/services/{gmail,google-calendar,claude,crypto}.ts`
- `apps/api/src/prompts/triage-system.ts` + `triage.schema.ts`
- `apps/api/src/db/schema.sql` + `db/migrations/0001_init.sql`

Mobile:
- `apps/mobile/app.json` -- bundle id, scheme `whyapp`, plugins
- `apps/mobile/eas.json`
- `apps/mobile/src/api/client.ts` -- typed fetch with session JWT
- `apps/mobile/src/state/auth.ts` -- SecureStore + Zustand
- `apps/mobile/app/sign-in.tsx`
- `apps/mobile/app/(tabs)/{triage,calendar,capture,settings}.tsx`
- `apps/mobile/app/triage/[id].tsx`

Shared:
- `packages/shared/src/types.ts` -- `TriageItem`, `FeedbackKind`, `CalendarSuggestion`

## Operating cost (2 testers)
- Apple Developer: ~$8/mo
- Domain: ~$1/mo
- Cloudflare Workers Paid: ~$5/mo
- Anthropic API (with caching): ~$7-20/mo
- EAS: free tier
Total: ~$20-35/month + $99/yr Apple.
