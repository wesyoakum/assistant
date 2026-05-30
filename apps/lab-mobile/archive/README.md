# archive/

Parked code from the 2026-05 slim-down. The lab app was cut to **two features**
— **Plate** (AR home-plate / baseball-field registration, `app/(tabs)/ar.tsx`)
and **Tracker** (video object tracking, `app/(tabs)/tracker.tsx`) — plus a
minimal **Settings** tab.

Everything here is excluded from the typecheck (`tsconfig.json` → `exclude`) and
is **not routed** (no longer under `app/`), so it doesn't ship or build. It's
kept in git rather than deleted so it can be pulled back if needed.

| Path | Was | Why parked |
|---|---|---|
| `app-tabs/experiments.tsx` | The 5400-line "Lab" screen (vision / tracker / audio / sensors / device / info) | Only the Tracker sub-tab survived; it now lives standalone at `app/(tabs)/tracker.tsx` via `src/tracker/TrackerTab.tsx`. |
| `app-tabs/lab.tsx` | `(tabs)/lab` route — rendered `experiments.tsx` | Route removed. |
| `app-tabs/chat.tsx` | `(tabs)/chat` placeholder ("Coming in Phase 2") | Unused. |
| `src/audio/chords.ts` | FFT note/chord detection for the experiments Audio tab | Only consumer was `experiments.tsx`. |

## Not archived (deliberately)

The unused native modules — `expo-yolo`, `expo-baseball`, `expo-vision-detect`,
`expo-gamecontroller` — were **left in `modules/`**. They're pnpm workspace
packages pinned in `pnpm-lock.yaml`; moving them would break
`pnpm install --frozen-lockfile` in CI. Their *usage* was removed (the screens
that imported them are here), so they're inert. Delete them properly only
together with a lockfile regeneration.

## Restoring something

Move the file back under `app/` (or `src/`), re-add its route/import, and remove
the `archive` entry from `tsconfig.json`'s `exclude` if you want it typechecked.
For `experiments.tsx` you'd also need to restore the `src/audio` import path.
