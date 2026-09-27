"""
Player-level context for the expectations / luck / talent pages:
  - NFL draft capital produced by each team-season (draft held after the season)
  - "who played": participation-weighted recruiting rating of the players who took the
    snaps, from season usage shares (offense), season tackles (defense) and the five
    highest-rated linemen on the roster (offense line, which the box score cannot see)

    python pull_sec_players.py      (needs CFBD_KEY; writes sec_players_2016_2025.csv)

Everything is cached per season in cache/; a rerun only fetches what is missing.
Call budget for a cold run: ~12 draft + ~210 rosters + ~32 recruiting classes + 5 portal
+ ~10 usage + ~50 defensive stats.
"""
import csv, json, os, sys, time
import requests

KEY = os.environ.get("CFBD_KEY")
if not KEY:
    sys.exit("Set CFBD_KEY in your environment first.")
BASE = "https://api.collegefootballdata.com"
H = {"Authorization": f"Bearer {KEY}"}
SEASONS = range(2016, 2026)
SEC = ["Alabama", "Arkansas", "Auburn", "Florida", "Georgia", "Kentucky", "LSU",
       "Mississippi State", "Missouri", "Oklahoma", "Ole Miss", "South Carolina",
       "Tennessee", "Texas", "Texas A&M", "Vanderbilt"]
EXTRA = ["Ohio State", "Indiana", "Michigan", "Clemson", "Notre Dame"]
TEAMS = SEC + EXTRA
CONFS = {"SEC": SEC + (["Texas", "Oklahoma"]), "B1G": ["Ohio State", "Indiana", "Michigan"], "ACC": ["Clemson"], "B12": ["Texas", "Oklahoma"]}
REFETCH = {max(SEASONS)}
CACHE = "cache"; os.makedirs(CACHE, exist_ok=True)
ROUND_VALUE = {1: 5, 2: 3, 3: 2}          # rounds 4-7 = 1
OL = {"OL", "OT", "OG", "C", "G", "T"}
OFF = {"QB", "RB", "WR", "TE", "FB", "HB", "ATH"}
DEF = {"DL", "DE", "DT", "NT", "EDGE", "LB", "ILB", "OLB", "DB", "CB", "S", "SAF", "FS", "SS"}

def get(path, optional=True, **params):
    err = None
    for attempt in range(4):
        try:
            r = requests.get(BASE + path, headers=H, params=params, timeout=120)
            if r.status_code == 200:
                return r.json()
            err = f"{r.status_code} {r.text[:200]}"
            if r.status_code == 429 and "quota" in r.text.lower():
                sys.exit(f"Quota exhausted: {path} {params}")
        except requests.RequestException as e:
            err = repr(e)
        time.sleep(3 * (attempt + 1))
    if optional:
        print(f"  warn: {path} {params} -> {err}; leaving blank", flush=True); return []
    sys.exit(f"Request failed: {path} {params} -> {err}")

def cached(name, year, fetch):
    f = os.path.join(CACHE, f"{name}_{year}.json")
    if year not in REFETCH and os.path.exists(f):
        return json.load(open(f, encoding="utf-8"))
    data = fetch(); json.dump(data, open(f, "w", encoding="utf-8")); time.sleep(0.3)
    return data

# ---------- recruiting ratings: recruit id -> rating, plus (name, school) -> rating for fallbacks
rating_by_recruit = {}; rating_by_name = {}
for y in range(2009, max(SEASONS) + 1):
    for cls in ["HighSchool", "JUCO"]:
        rows = cached(f"recruits_{cls.lower()}", y, lambda y=y, cls=cls: get("/recruiting/players", year=y, classification=cls))
        for r in rows:
            if r.get("rating") is None: continue
            if r.get("id") is not None: rating_by_recruit[str(r["id"])] = float(r["rating"])
            if r.get("athleteId") is not None: rating_by_recruit["a" + str(r["athleteId"])] = float(r["rating"])
            rating_by_name[(r.get("name", "").lower(), (r.get("committedTo") or "").lower())] = float(r["rating"])
portal = {}
for y in range(2021, max(SEASONS) + 1):
    for r in cached("portal", y, lambda y=y: get("/player/portal", year=y)):
        if r.get("rating") is not None and r.get("destination"):
            portal[(f"{r.get('firstName','')} {r.get('lastName','')}".lower().strip(), r["destination"].lower())] = float(r["rating"])
print(f"ratings on file: {len(rating_by_recruit)} recruits, {len(portal)} portal entries", flush=True)

# ---------- draft picks: draft year D credits season D-1
draft = {}   # (season, college team) -> dict
for D in range(min(SEASONS) + 1, max(SEASONS) + 2):
    picks = cached("draft", D, lambda D=D: get("/draft/picks", year=D))
    for p in picks:
        key = (D - 1, p.get("collegeTeam"))
        d = draft.setdefault(key, dict(capital=0, picks=0, r1=0))
        rd = p.get("round") or 7
        d["capital"] += ROUND_VALUE.get(rd, 1); d["picks"] += 1; d["r1"] += 1 if rd == 1 else 0
draft_rank = {}
for season in SEASONS:
    teams = [(t, v["capital"]) for (s, t), v in draft.items() if s == season]
    teams.sort(key=lambda x: -x[1])
    for i, (t, c) in enumerate(teams): draft_rank[(season, t)] = i + 1
    draft_rank[(season, None)] = len(teams) + 1   # rank for a team with no picks
print(f"draft picks mapped for seasons {min(SEASONS)}-{max(SEASONS)}", flush=True)

# ---------- usage (offense) and defensive season stats, per season for all teams
def usage_for(year):
    rows = cached("usage", year, lambda: get("/player/usage", year=year, excludeGarbageTime="true"))
    out = {}
    for r in rows:
        u = (r.get("usage") or {}).get("overall")
        if u is not None: out.setdefault(r.get("team"), []).append((r.get("name", ""), r.get("position", ""), float(u), str(r.get("id"))))
    return out
def defense_for(year):
    rows = []
    for conf in ["SEC", "B1G", "ACC"] + (["B12"] if year <= 2023 else []):
        rows += cached(f"pstats_{conf.lower()}", year, lambda conf=conf: get("/stats/player/season", year=year, conference=conf, seasonType="both", category="defensive"))
        rows += cached(f"pstats_int_{conf.lower()}", year, lambda conf=conf: get("/stats/player/season", year=year, conference=conf, seasonType="both", category="interceptions"))
    rows += cached("pstats_nd", year, lambda: get("/stats/player/season", year=year, team="Notre Dame", seasonType="both", category="defensive"))
    out = {}
    for r in rows:
        st = r.get("statType"); v = r.get("stat")
        if st in ("TOT", "SACKS", "TFL", "PD", "INT") and v not in (None, ""):
            try: v = float(v)
            except ValueError: continue
            key = (r.get("team"), str(r.get("playerId")), r.get("player", ""))
            out[key] = out.get(key, 0.0) + v
    return out

# ---------- roster with ratings
def roster_for(team, year):
    rows = cached(f"roster_{team.lower().replace(' ', '_').replace('&', 'and')}", year, lambda: get("/roster", team=team, year=year))
    out = []
    for r in rows:
        name = f"{r.get('firstName','')} {r.get('lastName','')}".lower().strip()
        rating = None
        for rid in (r.get("recruitIds") or []):
            if str(rid) in rating_by_recruit: rating = rating_by_recruit[str(rid)]; break
        if rating is None and r.get("id") is not None and "a" + str(r["id"]) in rating_by_recruit: rating = rating_by_recruit["a" + str(r["id"])]
        if rating is None: rating = portal.get((name, team.lower()))
        if rating is None: rating = rating_by_name.get((name, team.lower()))
        out.append(dict(id=str(r.get("id")), name=name, pos=(r.get("position") or "").upper(), rating=rating))
    return out

def wmean(pairs):
    tw = sum(w for _, w in pairs); return (sum(v * w for v, w in pairs) / tw) if tw else None

rows = []
for year in SEASONS:
    usage = usage_for(year); dfn = defense_for(year)
    for team in TEAMS:
        ro = roster_for(team, year)
        known = sorted([p["rating"] for p in ro if p["rating"] is not None], reverse=True)
        if not known:
            rows.append(dict(season=year, team=team)); continue
        floor = known[int(len(known) * 0.75)] if len(known) > 4 else known[-1]   # lowest quartile = walk-on level
        by_id = {p["id"]: p for p in ro}; by_name = {p["name"]: p for p in ro}
        def rate(pid, name):
            p = by_id.get(pid) or by_name.get(name.lower())
            if p and p["rating"] is not None: return p["rating"], True
            return floor, False
        # offense: usage share, capped at 5% of plays for full weight; plus the five best-rated linemen
        off = []; cov = []
        for name, pos, u, pid in usage.get(team, []):
            if pos.upper() in OFF or pos.upper() in {"QB", "RB", "WR", "TE"}:
                w = min(1.0, u / 0.05); r_, k = rate(pid, name); off.append((r_, w)); cov.append((k, w))
        ol = sorted([p for p in ro if p["pos"] in OL and p["rating"] is not None], key=lambda p: -p["rating"])[:5]
        for p in ol: off.append((p["rating"], 1.0)); cov.append((True, 1.0))
        # defense: tackles + sacks + TFL + PD + INT over the season; 15 involvements = full weight
        de = []
        for (t_, pid, name), inv in dfn.items():
            if t_ != team or inv <= 0: continue
            w = min(1.0, inv / 15.0); r_, k = rate(pid, name); de.append((r_, w)); cov.append((k, w))
        played_off = wmean(off); played_def = wmean(de)
        played = (played_off + played_def) / 2 if played_off is not None and played_def is not None else (played_off or played_def)
        roster44 = sum(known[:44]) / len(known[:44])
        coverage = (sum(w for k, w in cov if k) / sum(w for _, w in cov)) if cov else None
        dr = draft.get((year, team), dict(capital=0, picks=0, r1=0))
        rows.append(dict(season=year, team=team,
                         draft_capital=dr["capital"], draft_picks=dr["picks"], draft_r1=dr["r1"],
                         draft_rank=draft_rank.get((year, team), draft_rank.get((year, None))),
                         played_off=round(played_off, 4) if played_off is not None else None,
                         played_def=round(played_def, 4) if played_def is not None else None,
                         played=round(played, 4) if played is not None else None,
                         roster_top44=round(roster44, 4), played_gap=round(played - roster44, 4) if played is not None else None,
                         rating_coverage=round(coverage, 3) if coverage is not None else None,
                         n_off=len(off), n_def=len(de), roster_known=len(known), roster_size=len(ro)))
    print(f"{year}: done", flush=True)

out = "sec_players_2016_2025.csv"
fields = ["season", "team", "draft_capital", "draft_picks", "draft_r1", "draft_rank", "played_off", "played_def", "played",
          "roster_top44", "played_gap", "rating_coverage", "n_off", "n_def", "roster_known", "roster_size"]
with open(out, "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=fields); w.writeheader()
    for r in rows: w.writerow({c: r.get(c) for c in fields})
print(f"Wrote {len(rows)} rows to {out}")
