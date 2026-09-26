# SEC against-the-spread page (`/cfbanalysis`)

Python tooling that builds the static page served at `https://whyapp.us/cfbanalysis`.
These are offline scripts, not Worker source; they live outside `src/` so they are
never bundled.

| File | Purpose |
| --- | --- |
| `pull_sec_lines.py` | Fetches games + betting lines for 16 SEC teams, 2021-2025, from CollegeFootballData.com. Writes `sec_games_2021_2025.csv`. |
| `sec_games_2021_2025.csv` | The pulled data (latin-1 encoded; one opponent name has an accent). Committed as deployable state. |
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
npm run cfb:refresh   # pull fresh data from CFBD, rebuild, copy into public/cfbanalysis/
npm run cfb:build     # rebuild from the existing CSV only (no API key needed)
npm run deploy        # wrangler deploy — publishes public/ as static assets
```

Then commit the updated `sec_games_2021_2025.csv` and `public/cfbanalysis/index.html`.
