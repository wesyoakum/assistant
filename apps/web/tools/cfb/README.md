# College football expectations / luck / talent pages (`/cfbanalysis`)

Python tooling that builds the static page served at `https://whyapp.us/cfbanalysis`.
These are offline scripts, not Worker source; they live outside `src/` so they are
never bundled.

| File | Purpose |
| --- | --- |
| `pull_sec_lines.py` | Fetches games, point spreads, postgame win probability, pregame Elo and box-score turnovers for the 16 SEC teams, 2016-2025: four bulk calls per season, cached per season in `cache/` (the latest season is always refetched). Writes `sec_games_2016_2025.csv`. |
| `sec_games_2016_2025.csv` | Per team-game data. Committed as deployable state. Until it exists the build falls back to `sec_games_2021_2025.csv`. |
| `pull_sec_seasons.py` | Fetches season-level context, 2016-2025: SP+ and FPI ratings, 247 talent composite, recruiting class rank, preseason and final AP rank, returning production, advanced season stats, and head coach + tenure year (from the coaches endpoint, one call per school). Writes `sec_seasons_2016_2025.csv`. |
| `sec_seasons_2016_2025.csv` | Per team-season context. Committed as deployable state. The build still runs without it (context sections are skipped). |
| `pull_sec_players.py` | Fetches NFL draft picks (draft capital per team-season), rosters with recruiting/portal ratings, season usage shares and defensive stats, and computes the "who played" participation rating. Writes `sec_players_2016_2025.csv`. Cold run ~320 calls; cached per season. |
| `sec_players_2016_2025.csv` | Per team-season draft capital and participation rating. Merged into the season table by the build; the build still runs without it. |
| `build_cfbanalysis.py` | Reads the CSVs, drops 2020 (COVID season) from every number except coach tenure years, writes one page per team plus the league, national and coaches pages for one season window (`--window all|2021-2025|2023-2025|current-coach`, `--out dir`). Texas A&M is also the folder's `index.html`. |
| `build_all.py` | Runs the build for every preset window: `out/` (2016-2025), `out/2021-2025/`, `out/2023-2025/`, `out/current-coach/`. This is what `npm run cfb:build` calls. |
| `out/` | Build output, one folder per page. Copied to `../../public/cfbanalysis/` by `npm run cfb:build`. Not committed. |

## Requirements

- Python 3 with `pandas`, `numpy`, `requests` (`pip install pandas numpy requests`)
- `CFBD_KEY` environment variable set to a CollegeFootballData.com API key.
  Only the pull step needs it. Never commit the key. The free tier allows 1,000
  calls a month; a full refresh is about 60 calls thanks to the per-season cache.

```powershell
$env:CFBD_KEY = "..."
```

## Refreshing the page

From `apps/web`:

```sh
npm run cfb:refresh   # pull fresh data from CFBD (both scripts), rebuild, copy into public/cfbanalysis/
npm run cfb:build     # rebuild from the existing CSV only (no API key needed)
npm run deploy        # wrangler deploy — publishes public/ as static assets
```

Then commit the updated CSVs and `public/cfbanalysis/`.

## Teams

The sixteen current SEC programs, plus a **national comparison set**: every team that
finished No. 1 in the final AP poll within the window, every program whose average final
AP ranking over the window (unranked counted as 26th) is inside the top 12, and Indiana.
As of 2016-2025 that adds Ohio State, Indiana, Michigan, Clemson and Notre Dame. The
lists live in `EXTRA` in both pull scripts; the build picks up whatever teams the games
file contains. Pages: `/cfbanalysis/sec/` (SEC only), `/cfbanalysis/national/` (everyone),
one page per team. The roster-gap baseline is the SEC average for SEC teams and the
whole-field average for the others.

## Season presets

Every page exists once per preset window, chosen with the Seasons dropdown: 2016-2025 (default,
at the root), 2021-2025, 2023-2025, and Current coach (each program over its sitting head coach's
tenure, so windows differ by team). All prose is generated from the data at build time, so the
takeaways and error bars on a preset page are correct for that window. Add a preset in `WINDOWS`
in `build_cfbanalysis.py` and in `build_all.py`.

## What the page computes

- **Cover margin** = actual margin + closing spread (team's perspective, negative = favored).
- **Market-expected wins** = sum of spread-implied win probabilities (normal model, sigma fitted to the data).
- **Deserved wins** (second-order wins) = sum of CFBD postgame win probability per game; the spread-implied probability stands in where CFBD has no play-by-play.
- **Luck** = actual wins minus deserved wins. **Market gap** = market-expected minus deserved wins (positive = overrated).
- **Talent minus SP+** = average 247 talent-composite rank minus average SP+ rank (positive = plays above its roster).
- **Draft capital** = round-weighted NFL draft picks (5 / 3 / 2 / 1 for rounds 1 / 2 / 3 / 4-7) in the draft after the season, credited to the player's final season, ranked nationally. **Talent minus draft** = talent rank minus draft rank (positive = recruits became pros beyond their rankings).
- **Who played** = weighted mean 247 rating of the players who took the snaps: offensive skill players by usage share (min(1, share/0.05)), defenders by tackles+sacks+TFL+PD+INT (min(1, n/15)), plus the five highest-rated linemen at full weight. Missing ratings are filled at the roster's lowest-quartile known rating; coverage is recorded. **vs roster** = who played minus the roster's top-44 mean rating.
- **Head-coaching tenures** = the coach who worked the most games in a season; tenure year counts seasons before the window and 2020.
- **2020** is excluded everywhere except tenure years: ten conference games, no non-conference schedule.
