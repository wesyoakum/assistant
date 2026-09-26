import csv, os, sys, time, re
def norm(d): return {re.sub(r'([A-Z])', lambda m: '_' + m.group(1).lower(), k): v for k, v in d.items()}
import requests

KEY = os.environ.get("CFBD_KEY")
if not KEY:
    sys.exit("Set CFBD_KEY in your environment first.")

BASE = "https://api.collegefootballdata.com"
H = {"Authorization": f"Bearer {KEY}"}
SEASONS = range(2021, 2026)
TEAMS = ["Alabama", "Arkansas", "Auburn", "Florida", "Georgia", "Kentucky", "LSU",
         "Mississippi State", "Missouri", "Oklahoma", "Ole Miss", "South Carolina",
         "Tennessee", "Texas", "Texas A&M", "Vanderbilt"]
PROVIDER_ORDER = ["consensus", "DraftKings", "Bovada", "ESPN Bet", "teamrankings", "numberfire"]

def get(path, **params):
    for attempt in range(3):
        r = requests.get(BASE + path, headers=H, params=params, timeout=30)
        if r.status_code == 200:
            return r.json()
        time.sleep(2)
    sys.exit(f"Request failed: {path} {params} -> {r.status_code} {r.text[:200]}")

rows = []
for year in SEASONS:
    for team in TEAMS:
        games = {g["id"]: norm(g) for g in get("/games", year=year, team=team, seasonType="both")}
        lines = {l["id"]: l for l in get("/lines", year=year, team=team, seasonType="both")}
        for gid, g in games.items():
            if g.get("home_points") is None:
                continue
            is_home = g["home_team"] == team
            opp = g["away_team"] if is_home else g["home_team"]
            tp = g["home_points"] if is_home else g["away_points"]
            op = g["away_points"] if is_home else g["home_points"]
            site = "N" if g.get("neutral_site") else ("H" if is_home else "A")
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
            rows.append({
                "season": year, "week": g.get("week"), "date": g["start_date"][:10],
                "season_type": g.get("season_type"), "team": team, "opponent": opp,
                "site": site, "conf_game": "Y" if g.get("conference_game") else "N",
                "team_pts": tp, "opp_pts": op, "actual_margin": tp - op,
                "open_spread": opening, "close_spread": spread, "provider": provider,
                "cover_margin": (tp - op + spread) if spread is not None else None,
            })
        print(f"{year} {team}: {len(games)} games", flush=True)
        time.sleep(0.3)

out = "sec_games_2021_2025.csv"
with open(out, "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader(); w.writerows(rows)
print(f"Wrote {len(rows)} rows to {out}")

