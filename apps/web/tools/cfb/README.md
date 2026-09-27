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
| `build_cfbanalysis.py` | Reads the CSVs, drops 2020 (COVID season) from every number except coach tenure years, writes one page per team plus the league page into `out/` (Texas A&M is also `out/index.html`, the default landing). |
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

## What the page computes

- **Cover margin** = actual margin + closing spread (team's perspective, negative = favored).
- **Market-expected wins** = sum of spread-implied win probabilities (normal model, sigma fitted to the data).
- **Deserved wins** (second-order wins) = sum of CFBD postgame win probability per game; the spread-implied probability stands in where CFBD has no play-by-play.
- **Luck** = actual wins minus deserved wins. **Market gap** = market-expected minus deserved wins (positive = overrated).
- **Talent minus SP+** = average 247 talent-composite rank minus average SP+ rank (positive = plays above its roster).
- **Head-coaching tenures** = the coach who worked the most games in a season; tenure year counts seasons before the window and 2020.
- **2020** is excluded everywhere except tenure years: ten conference games, no non-conference schedule.
