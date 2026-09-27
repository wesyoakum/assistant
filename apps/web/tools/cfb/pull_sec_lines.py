"""
Games, kickoff/opening point spreads, postgame win probability, pregame Elo and
box-score turnovers for the 16 current SEC programs plus a national comparison set, 2016-2025, from
CollegeFootballData.com.

    python pull_sec_lines.py          (needs CFBD_KEY; writes sec_games_2016_2025.csv)

Call budget: about 6 calls per season (games, lines, box scores per conference plus
Notre Dame) -> about 60 calls for ten seasons.
Responses are cached per season in cache/ so a rerun only fetches seasons that
are missing or in progress (the latest season is always refetched).
"""
import csv, json, os, sys, time, re
import requests

KEY = os.environ.get("CFBD_KEY")
if not KEY:
    sys.exit("Set CFBD_KEY in your environment first.")

BASE = "https://api.collegefootballdata.com"
H = {"Authorization": f"Bearer {KEY}"}
SEASONS = range(2016, 2026)
REFETCH = {max(SEASONS)}          # in-progress season: never trust the cache
SEC = ["Alabama", "Arkansas", "Auburn", "Florida", "Georgia", "Kentucky", "LSU",
       "Mississippi State", "Missouri", "Oklahoma", "Ole Miss", "South Carolina",
       "Tennessee", "Texas", "Texas A&M", "Vanderbilt"]
# national comparison set: recent champions + programs whose average final AP rank is inside the top 12, plus Indiana
EXTRA = ["Ohio State", "Indiana", "Michigan", "Clemson", "Notre Dame"]
TEAMS = SEC + EXTRA
BIG12_UNTIL = 2023                # Texas and Oklahoma joined the SEC in 2024
# box scores are fetched by conference (one call each); Notre Dame is independent, so by team
BOX_CONFS = lambda year: ["SEC", "B1G", "ACC"] + (["B12"] if year <= BIG12_UNTIL else [])
BOX_TEAMS = ["Notre Dame"]
PROVIDER_ORDER = ["consensus", "DraftKings", "Bovada", "ESPN Bet", "teamrankings", "numberfire"]
CACHE = "cache"; os.makedirs(CACHE, exist_ok=True)

def norm(d): return {re.sub(r'([A-Z])', lambda m: '_' + m.group(1).lower(), k): v for k, v in d.items()}

def get(path, **params):
    err = None
    for attempt in range(4):
        try:
            r = requests.get(BASE + path, headers=H, params=params, timeout=120)
            if r.status_code == 200:
                return r.json()
            err = f"{r.status_code} {r.text[:200]}"
            if r.status_code == 429 and "quota" in r.text.lower():
                break             # monthly quota: retrying will not help
        except requests.RequestException as e:
            err = repr(e)
        time.sleep(3 * (attempt + 1))
    sys.exit(f"Request failed: {path} {params} -> {err}")

def cached(name, year, fetch):
    """Load cache/<name>_<year>.json, or fetch and store it."""
    f = os.path.join(CACHE, f"{name}_{year}.json")
    if year not in REFETCH and os.path.exists(f):
        return json.load(open(f, encoding="utf-8"))
    data = fetch(); json.dump(data, open(f, "w", encoding="utf-8")); time.sleep(0.3)
    return data

rows = []
for year in SEASONS:
    games = cached("games", year, lambda: get("/games", year=year, seasonType="both"))
    lines = cached("lines", year, lambda: get("/lines", year=year, seasonType="both"))
    box = []
    for conf in BOX_CONFS(year):
        box += cached(f"box_{conf.lower()}", year, lambda c=conf: get("/games/teams", year=year, conference=c, seasonType="both"))
    for bt in BOX_TEAMS:
        box += cached(f"box_{bt.lower().replace(' ', '_')}", year, lambda b=bt: get("/games/teams", year=year, team=b, seasonType="both"))
    games = {g["id"]: norm(g) for g in games}
    lines = {l["id"]: l for l in lines}
    tos = {}
    for bx in box:
        for side in bx.get("teams", []):
            st = {x.get("category"): x.get("stat") for x in side.get("stats", [])}
            if st.get("turnovers") is not None:
                tos[(bx["id"], side.get("team"))] = int(st["turnovers"])
    for team in TEAMS:
        n = 0
        for gid, g in games.items():
            if team not in (g.get("home_team"), g.get("away_team")) or g.get("home_points") is None:
                continue
            is_home = g["home_team"] == team
            opp = g["away_team"] if is_home else g["home_team"]
            tp = g["home_points"] if is_home else g["away_points"]
            op = g["away_points"] if is_home else g["home_points"]
            site = "N" if g.get("neutral_site") else ("H" if is_home else "A")
            post_wp = g.get("home_postgame_win_probability") if is_home else g.get("away_postgame_win_probability")
            pre_elo = g.get("home_pregame_elo") if is_home else g.get("away_pregame_elo")
            opp_pre_elo = g.get("away_pregame_elo") if is_home else g.get("home_pregame_elo")
            team_to, opp_to = tos.get((gid, team)), tos.get((gid, opp))
            spread = opening = provider = None
            posted = {l["provider"]: l for l in lines.get(gid, {}).get("lines", [])}
            for p in PROVIDER_ORDER + list(posted):
                if p in posted and posted[p].get("spread") is not None:
                    l = posted[p]
                    sign = 1 if is_home else -1
                    spread = sign * float(l["spread"])
                    opening = sign * float(l["spreadOpen"]) if l.get("spreadOpen") is not None else None
                    provider = p
                    break
            if spread is None:
                continue          # the page needs an expected margin for every game
            rows.append({
                "season": year, "week": g.get("week"), "date": g["start_date"][:10],
                "season_type": g.get("season_type"), "team": team, "opponent": opp,
                "site": site, "conf_game": "Y" if g.get("conference_game") else "N",
                "team_pts": tp, "opp_pts": op, "actual_margin": tp - op,
                "open_spread": opening, "close_spread": spread, "provider": provider,
                "cover_margin": tp - op + spread,
                "post_wp": post_wp, "pre_elo": pre_elo, "opp_pre_elo": opp_pre_elo,
                "turnovers": team_to, "opp_turnovers": opp_to,
                "to_margin": (opp_to - team_to) if team_to is not None and opp_to is not None else None,
                "excitement": g.get("excitement_index"),
            })
            n += 1
        print(f"{year} {team}: {n} games with a spread", flush=True)

out = "sec_games_2016_2025.csv"
with open(out, "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader(); w.writerows(rows)
print(f"Wrote {len(rows)} rows to {out}")
