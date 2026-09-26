"""
Season-level context for the SEC against-the-spread page: SP+ / FPI ratings,
247 talent composite, recruiting class rank, AP polls, returning production and
season advanced stats, for the 16 current SEC programs 2021-2025.

    python pull_sec_seasons.py      (needs CFBD_KEY; writes sec_seasons_2021_2025.csv)
"""
import csv, os, sys, time
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

def get(path, optional=False, **params):
    err = None
    for attempt in range(4):
        try:
            r = requests.get(BASE + path, headers=H, params=params, timeout=120)
            if r.status_code == 200:
                return r.json()
            err = f"{r.status_code} {r.text[:200]}"
        except requests.RequestException as e:
            err = repr(e)
        time.sleep(3 * (attempt + 1))
    if optional:
        print(f"  warn: {path} {params} -> {err}; leaving blank", flush=True)
        return []
    sys.exit(f"Request failed: {path} {params} -> {err}")

def team_of(r):
    return r.get("team") or r.get("school")

def ranks(rows, key, higher_is_better=True):
    """Rank every returned team by a numeric field (1 = best)."""
    vals = [(team_of(r), r.get(key)) for r in rows if r.get(key) is not None]
    vals.sort(key=lambda x: x[1], reverse=higher_is_better)
    return {t: i + 1 for i, (t, _) in enumerate(vals)}

def ap(rows):
    """AP Top 25 from a /rankings response -> {team: rank}."""
    out = {}
    for wk in rows:
        for poll in wk.get("polls", []):
            if poll.get("poll") == "AP Top 25":
                for r in poll.get("ranks", []):
                    out[team_of(r)] = r["rank"]
    return out

FIELDS = ["season", "team", "sp_rating", "sp_rank", "sp_off_rank", "sp_def_rank", "sp_sos",
          "fpi", "fpi_rank", "fpi_sor_rank", "talent", "talent_rank", "recruit_rank",
          "recruit_points", "ap_pre", "ap_final", "ret_ppa_pct", "ret_usage_pct",
          "off_ppa", "off_success", "off_explosiveness", "def_ppa", "def_success",
          "def_explosiveness"]

rows = {}
for year in SEASONS:
    for t in TEAMS:
        rows[(year, t)] = {"season": year, "team": t}
    R = lambda t: rows[(year, t)]

    for r in get("/ratings/sp", year=year):
        t = team_of(r)
        if (year, t) in rows:
            o, d = r.get("offense") or {}, r.get("defense") or {}
            R(t).update(sp_rating=r.get("rating"), sp_rank=r.get("ranking"), sp_sos=r.get("sos"),
                        sp_off_rank=o.get("ranking"), sp_def_rank=d.get("ranking"))
    time.sleep(0.3)

    for r in get("/ratings/fpi", year=year, optional=True):
        t = team_of(r)
        if (year, t) in rows:
            rr = r.get("resumeRanks") or {}
            R(t).update(fpi=r.get("fpi"), fpi_rank=rr.get("fpi"), fpi_sor_rank=rr.get("strengthOfRecord"))
    time.sleep(0.3)

    tal = get("/talent", year=year, optional=True)
    trank = ranks(tal, "talent")
    for r in tal:
        t = team_of(r)
        if (year, t) in rows:
            R(t).update(talent=r.get("talent"), talent_rank=trank.get(t))
    time.sleep(0.3)

    for r in get("/recruiting/teams", year=year, optional=True):
        t = team_of(r)
        if (year, t) in rows:
            R(t).update(recruit_rank=r.get("rank"), recruit_points=r.get("points"))
    time.sleep(0.3)

    pre = ap(get("/rankings", year=year, seasonType="regular", week=1, optional=True))
    fin = ap(get("/rankings", year=year, seasonType="postseason", optional=True))
    for t in TEAMS:
        R(t).update(ap_pre=pre.get(t), ap_final=fin.get(t))
    time.sleep(0.3)

    for r in get("/player/returning", year=year, optional=True):
        t = team_of(r)
        if (year, t) in rows:
            R(t).update(ret_ppa_pct=r.get("percentPPA"), ret_usage_pct=r.get("usage"))
    time.sleep(0.3)

    for r in get("/stats/season/advanced", year=year, excludeGarbageTime="true", optional=True):
        t = team_of(r)
        if (year, t) in rows:
            o, d = r.get("offense") or {}, r.get("defense") or {}
            R(t).update(off_ppa=o.get("ppa"), off_success=o.get("successRate"), off_explosiveness=o.get("explosiveness"),
                        def_ppa=d.get("ppa"), def_success=d.get("successRate"), def_explosiveness=d.get("explosiveness"))
    print(f"{year}: done", flush=True)
    time.sleep(0.3)

out = "sec_seasons_2021_2025.csv"
with open(out, "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=FIELDS)
    w.writeheader()
    for k in sorted(rows):
        w.writerow({c: rows[k].get(c) for c in FIELDS})
print(f"Wrote {len(rows)} rows to {out}")
