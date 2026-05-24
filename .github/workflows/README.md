# Mobile update pipeline

Two workflows, two purposes:

| Workflow | Where it runs | When | What it does |
|---|---|---|---|
| `eas-update.yml` | GitHub Actions | Push to `main` touching `apps/mobile/**` or `packages/shared/**`, or manual dispatch | Publishes an OTA update via `eas update`. JS/TS changes only. |
| `../../.eas/workflows/build-ios-testflight.yml` | EAS (Expo's CI) | Manual dispatch only | Full native iOS build + TestFlight submit. Use after native changes (new Expo plugin, native module, SDK bump, `app.json` ios block). |

## One-time setup (do this once, from any browser — phone works)

### 1. Make an Expo access token

1. Visit https://expo.dev/settings/access-tokens
2. "Create token", name it `github-actions-whyapp`, copy the value.

### 2. Add it to GitHub

1. Visit https://github.com/wesyoakum/assistant/settings/secrets/actions
2. "New repository secret" → name `EXPO_TOKEN`, paste the value.

That's enough for OTA updates. The EAS workflow runs on Expo's infra and uses your Expo account directly — no GitHub secret needed.

### 3. (One time) Rebuild for TestFlight with channels wired up

`eas.json` now sets `channel: "production"` on the production profile. Existing TestFlight builds may not be on a channel, so the first OTA update could fail to reach them. Trigger one TestFlight build through the EAS workflow:

1. Go to https://expo.dev → your project → Workflows
2. Run `build-ios-testflight.yml` with profile `production`
3. Wait for the build → it auto-submits to TestFlight
4. Install the new TestFlight build on your phone

From then on, **JS changes ship via OTA in ~minutes** — no rebuild needed.

## Day-to-day flow

- **JS/TS change** (most of the time):
  Commit → push to `main` → GitHub Actions runs `eas update --branch production` → your phone picks it up on next app launch (the app has `checkAutomatically: ON_LOAD`).
- **Native change** (rare — new Expo plugin, native module, version bump):
  Trigger the EAS workflow manually from expo.dev → install the new TestFlight build.

## How to tell which kind of change you have

Native = anything that changes `app.json`'s `ios`/`android`/`plugins` blocks, adds a new package that has native code (most `expo-*` and `react-native-*` packages do), or bumps `expo` major. When in doubt, run an OTA update first — if the app crashes or the change doesn't appear, it was native and you need a build.
