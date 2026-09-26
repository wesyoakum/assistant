# SEC against-the-spread page (`/cfbanalysis`)

Python tooling that builds the static page served at `https://whyapp.us/cfbanalysis`.
These are offline scripts, not Worker source; they live outside `src/` so they are
never bundled.

| File | Purpose |
| --- | --- |
| `pull_sec_lines.py` | Fetches games, betting lines, postgame win probability, pregame Elo and box-score turnovers for 16 SEC teams, 2021-2025, from CollegeFootballData.com. Writes `sec_games_2021_2025.csv`. |
| `sec_games_2021_2025.csv` | Per team-game data (latin-1 encoded; one opponent name has an accent). Committed as deployable state. |
| `pull_sec_seasons.py` | Fetches season-level context: SP+ and FPI ratings, 247 talent composite, recruiting class rank, preseason and final AP rank, returning production, advanced season stats. Writes `sec_seasons_2021_2025.csv`. |
| `sec_seasons_2021_2025.csv` | Per team-season context. Committed as deployable state. The build still runs without it (context sections are skipped). |
| `build_cfbanalysis.py` | Reads the CSV, writes the self-contained `cfbanalysis.html` (~550 KB, only external dependency is Google Fonts). |
| `cfbanalysis.html` | Build output. Copied to `../../public/cfbanalysis/index.html`, which is what gets deployed. |

## Requirements

- Python 3 with `pandas`, `numpy`, `requests` (`pip install pandas numpy requests`)
- `CFBD_KEY` environment variable set to a CollegeFootballData.com API key.
  Only the pull step needs it. Never commit the key.

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

Then commit the updated CSVs and `public/cfbanalysis/index.html`.

## What the page computes

- **Cover margin** = actual margin + closing spread (team's perspective, negative = favored).
- **Market-expected wins** = sum of spread-implied win probabilities (normal model, sigma fitted to the data).
- **Deserved wins** (second-order wins) = sum of CFBD postgame win probability per game; the spread-implied probability stands in where CFBD has no play-by-play.
- **Luck** = actual wins minus deserved wins. **Market gap** = market-expected minus deserved wins (positive = overrated).
- **Talent minus SP+** = average 247 talent-composite rank minus average SP+ rank (positive = plays above its roster).
