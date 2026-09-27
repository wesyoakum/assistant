"""
Build the SEC expectations / luck / talent pages.
    pip install pandas numpy
    python build_cfbanalysis.py      (reads sec_games_2016_2025.csv + sec_seasons_2016_2025.csv, writes out/)
Falls back to sec_games_2021_2025.csv if the ten-season games file is not there yet; the
window on the page is whatever seasons the games file has, minus 2020.
out/index.html is Texas A&M (the default landing); out/sec/ is the league page; out/<team-slug>/ is each team.
npm run cfb:build copies out/ to public/cfbanalysis/.
"""
import pandas as pd, numpy as np, html as H, math, os, shutil
GAMES='sec_games_2016_2025.csv' if os.path.exists('sec_games_2016_2025.csv') else 'sec_games_2021_2025.csv'
SFILE='sec_seasons_2016_2025.csv' if os.path.exists('sec_seasons_2016_2025.csv') else 'sec_seasons_2021_2025.csv'
EXCLUDE={2020}; BASE='/cfbanalysis/'
try: d=pd.read_csv(GAMES,encoding='utf-8')
except UnicodeDecodeError: d=pd.read_csv(GAMES,encoding='latin-1')
d=d[~d.season.isin(EXCLUDE)].copy()
d['res']=np.where(d.cover_margin>0,'Cover',np.where(d.cover_margin<0,'No Cover','Push'))
d['fav']=np.where(d.close_spread<0,'Favorite',np.where(d.close_spread>0,'Underdog','Pick'))
d['move']=d.close_spread-d.open_spread  # negative = opinion moved toward the team during the week
d['su']=np.where(d.actual_margin>0,'W','L')
d['xm']=-d.close_spread                 # expected margin, positive = expected to win by that much
SIG=d.cover_margin.std()                # observed std dev of (actual margin - expected margin); ~15 points
d['p']=[0.5*(1+math.erf(-sp/(SIG*math.sqrt(2)))) for sp in d.close_spread]  # pre-game chance of winning implied by the expected margin
for c in ['post_wp','to_margin','pre_elo']:
    if c not in d: d[c]=np.nan
d['sow']=d.post_wp.fillna(d.p)          # deserved-win credit per game: CFBD postgame win probability, p where CFBD has none
d['pve']=d.sow-d.p                      # play versus expectation, per game
d['onescore']=d.actual_margin.abs()<=8
d=d.sort_values(['team','season','date']).reset_index(drop=True)
d['gi']=d.groupby(['team','season']).cumcount()+1
THIRDS=['Early (games 1-4)','Middle (5-8)','Late (9 on)']
d['third']=np.where(d.gi<=4,THIRDS[0],np.where(d.gi<=8,THIRDS[1],THIRDS[2]))
SDG=d.pve.std()                         # per-game std dev of (deserved credit - expected probability)
YEARS=sorted(int(y) for y in d.season.unique()); NSEAS=len(YEARS); YMIN,YMAX=YEARS[0],YEARS[-1]
AVGN=d.groupby('team').size().mean()
SPAN=f"{YMIN}–{YMAX}"; SPAN_NOTE=f"{NSEAS} seasons, {YMIN} through {YMAX}"+(" with 2020 left out" if YMIN<2020<YMAX else "")
RK_SE=5*math.sqrt(5/NSEAS)              # rough noise on a multi-season rank average
def sig(v,se):
    z=abs(v)/se if se else 0
    return ('within the noise' if z<1 else 'suggestive but not conclusive' if z<2 else 'unlikely to be noise')+f' ({z:.1f} standard errors)'
def strength(v,se): return sig(v,se).split(' (')[0]
HAS_S=os.path.exists(SFILE)
S=pd.read_csv(SFILE) if HAS_S else pd.DataFrame(columns=['season','team'])
if HAS_S:
    S=S[S.season.isin(YEARS)].copy()    # only seasons that have games; tenure years were computed on the full record
    for c in ['coach','coach_tenure_year','coach_first_year']:
        if c not in S: S[c]=np.nan
    S['coach_last']=S.coach.fillna('').astype(str).str.split().str[-1].replace('','–')
def srow(t,yr):
    r=S[(S.team==t)&(S.season==yr)]
    return r.iloc[0] if len(r) else pd.Series(dtype=float)
def fr(v,fmt='{:.0f}',dash='–'):
    try:
        if v is None or pd.isna(v): return dash
        if '.0f' in fmt: v=round(float(v))+0.0
        return fmt.format(v)
    except Exception: return dash
def xmtxt(sp):
    """plain-English expected margin from the team's spread"""
    return 'even' if sp==0 else (f'expected to win by {-sp:g}' if sp<0 else f'expected to lose by {sp:g}')
COLORS={"Alabama":"#9E1B32","Arkansas":"#9D2235","Auburn":"#0C2340","Florida":"#0021A5","Georgia":"#BA0C2F","Kentucky":"#0033A0","LSU":"#461D7C","Mississippi State":"#5D1725","Missouri":"#F1B82D","Oklahoma":"#841617","Ole Miss":"#14213D","South Carolina":"#73000A","Tennessee":"#FF8200","Texas":"#BF5700","Texas A&M":"#500000","Vanderbilt":"#866D4B",
        "Ohio State":"#BB0000","Indiana":"#990000","Michigan":"#00274C","Clemson":"#F56600","Notre Dame":"#0C2340"}
SEC=sorted(["Alabama","Arkansas","Auburn","Florida","Georgia","Kentucky","LSU","Mississippi State","Missouri","Oklahoma","Ole Miss","South Carolina","Tennessee","Texas","Texas A&M","Vanderbilt"])
EXTRA=sorted([t for t in COLORS if t not in SEC and t in set(d.team)])
ALLTEAMS=SEC+EXTRA; TEAMS=ALLTEAMS; MAROON='#500000'
def slug(t): return t.lower().replace(' ','-').replace('&','')
def stats(g):
    n=len(g); c=(g.res=='Cover').sum(); nc=(g.res=='No Cover').sum(); p=(g.res=='Push').sum()
    fv=g[g.fav=='Favorite']; ud=g[g.fav=='Underdog']
    return dict(n=n,c=c,nc=nc,p=p,pct=(c+0.5*p)/n*100 if n else np.nan,cm=g.cover_margin.mean() if n else np.nan,
                w=(g.su=='W').sum(),l=(g.su=='L').sum(),xw=g.p.sum() if n else np.nan,am=g.actual_margin.mean() if n else np.nan,
                fw=(fv.su=='W').sum(),fl=(fv.su=='L').sum(),uw=(ud.su=='W').sum(),ul=(ud.su=='L').sum(),
                sow=g.sow.sum() if n else np.nan,pve=g.pve.mean() if n else np.nan,
                osw=((g.onescore)&(g.su=='W')).sum(),osl=((g.onescore)&(g.su=='L')).sum(),
                tom=g.to_margin.sum() if g.to_margin.notna().any() else np.nan,
                se_mg=SDG*math.sqrt(n) if n else np.nan,se_lk=math.sqrt((g.sow*(1-g.sow)).sum()) if n else np.nan,
                se_pct=100*math.sqrt(0.25/n) if n else np.nan,se_xw=math.sqrt((g.p*(1-g.p)).sum()) if n else np.nan)
def rec(s): return f"{s['c']}-{s['nc']}-{s['p']}"
def xrec(s): return f"{s['xw']:.1f}-{s['n']-s['xw']:.1f}"
def z0(v): return round(v,1)+0.0
def dw(s): return z0(s['w']-s['xw'])
def luck(s): return z0(s['w']-s['sow'])
def mgap(s): return z0(s['xw']-s['sow'])
def thirds(g): return {th:stats(g[g.third==th]) for th in THIRDS}
def trend(g):
    th=thirds(g); e,l=th[THIRDS[0]],th[THIRDS[2]]
    diff=z0(l['cm']-e['cm']) if e['n'] and l['n'] else np.nan
    se=SIG*math.sqrt(1/e['n']+1/l['n']) if e['n'] and l['n'] else np.nan
    return diff,se,th
def wtrend(th):
    e,l=th[THIRDS[0]],th[THIRDS[2]]
    if not e['n'] or not l['n']: return np.nan,np.nan
    return z0(dw(l)-dw(e)),math.sqrt(e['se_xw']**2+l['se_xw']**2)
def pts(v): return f"{abs(v):.1f} points a game {'ahead of' if v>=0 else 'short of'} expectations"

# ---------- coaching tenures (within the window; tenure year counts seasons before the window and 2020)
def tenures_for(t):
    out=[]
    if not HAS_S or 'coach' not in S: return out
    ss=S[(S.team==t)&S.coach.notna()].sort_values('season')
    for (coach,first),grp in ss.groupby(['coach','coach_first_year'],sort=False):
        yrs=sorted(int(y) for y in grp.season); g=d[(d.team==t)&(d.season.isin(yrs))]
        if not len(g): continue
        out.append(dict(team=t,coach=coach,last=coach.split()[-1],first=int(first),yrs=yrs,st=stats(g),
                        tal=grp.talent_rank.mean(),sp=grp.sp_rank.mean()))
    out.sort(key=lambda x:x['yrs'][0]); return out
TEN={t:tenures_for(t) for t in ALLTEAMS}
ALLTEN=[x for t in ALLTEAMS for x in TEN[t]]
def gap(x): return (x['tal']-x['sp']) if pd.notna(x['tal']) and pd.notna(x['sp']) else np.nan

# ---------- charts (team)
def scatter(g,color):
    W,Hh=720,540; L,R,T,B=56,20,20,48
    xmin,xmax=-40,60; ymin,ymax=-45,65
    X=lambda v:L+(v-xmin)/(xmax-xmin)*(W-L-R); Y=lambda v:T+(ymax-v)/(ymax-ymin)*(Hh-T-B)
    s=[f'<svg viewBox="0 0 {W} {Hh}" class="chart" role="img" aria-label="Expected margin versus actual margin">']
    for v in range(-40,61,10): s.append(f'<line x1="{X(v):.1f}" y1="{T}" x2="{X(v):.1f}" y2="{Hh-B}" class="grid"/><text x="{X(v):.1f}" y="{Hh-B+18}" class="tick" text-anchor="middle">{v:+d}</text>')
    for v in range(-40,66,10): s.append(f'<line x1="{L}" y1="{Y(v):.1f}" x2="{W-R}" y2="{Y(v):.1f}" class="grid"/><text x="{L-8}" y="{Y(v)+4:.1f}" class="tick" text-anchor="end">{v:+d}</text>')
    s.append(f'<line x1="{X(xmin):.1f}" y1="{Y(0):.1f}" x2="{X(xmax):.1f}" y2="{Y(0):.1f}" class="zero"/>')
    s.append(f'<line x1="{X(-40):.1f}" y1="{Y(-40):.1f}" x2="{X(60):.1f}" y2="{Y(60):.1f}" class="fair"/>')
    s.append(f'<text x="{X(38):.1f}" y="{Y(58)-6:.1f}" class="lbl" text-anchor="end">Exactly as expected</text>')
    s.append(f'<text x="{X(-36):.1f}" y="{Y(50):.1f}" class="lbl faint">Beat expectations ↑</text><text x="{X(30):.1f}" y="{Y(-36):.1f}" class="lbl faint">↓ Fell short</text>')
    s.append(f'<text x="{(L+W-R)/2:.0f}" y="{Hh-8}" class="axis" text-anchor="middle">Expected margin (positive = expected to win by that much)</text>')
    s.append(f'<text transform="translate(14 {(T+Hh-B)/2:.0f}) rotate(-90)" class="axis" text-anchor="middle">Actual margin</text>')
    for _,r in g.iterrows():
        cls={'Cover':'cover','No Cover':'nocover','Push':'push'}[r.res]
        loc={'H':'vs','A':'at','N':'vs (N)'}[r.site]
        tip=f"{r.season} {loc} {r.opponent}: {r.su} {r.team_pts}-{r.opp_pts}, {xmtxt(r.close_spread)}, beat by {r.cover_margin:+g}"
        s.append(f'<circle cx="{X(max(xmin,min(xmax,r.xm))):.1f}" cy="{Y(max(ymin,min(ymax,r.actual_margin))):.1f}" r="5" class="pt {cls}"><title>{H.escape(tip)}</title></circle>')
    s.append('</svg>'); return ''.join(s)

def strip(g):
    W=720; rowh=118; seasons=sorted(g.season.unique()); Hh=rowh*len(seasons)+10
    s=[f'<svg viewBox="0 0 {W} {Hh}" class="chart" role="img" aria-label="Beat expectations by, game by game">']
    for i,yr in enumerate(seasons):
        y0=i*rowh+10; base=y0+62; rs=g[g.season==yr]; st=stats(rs)
        s.append(f'<text x="0" y="{y0+14}" class="seasonlbl">{yr}</text>')
        s.append(f'<text x="{W}" y="{y0+14}" class="seasonstat" text-anchor="end">{rec(st)} vs expectations · {st["w"]}-{st["l"]} won-lost · beat by {st["cm"]:+.1f} avg</text>')
        s.append(f'<line x1="70" y1="{base}" x2="{W-10}" y2="{base}" class="zero"/>')
        gap_=(W-90)/max(len(rs),14)
        for j,(_,r) in enumerate(rs.iterrows()):
            x=80+j*gap_+gap_/2; yv=base-(max(-40,min(40,r.cover_margin))/40)*40
            cls={'Cover':'cover','No Cover':'nocover','Push':'push'}[r.res]
            tip=f"{r.opponent} ({ {'H':'home','A':'away','N':'neutral'}[r.site]}): {r.su} {r.team_pts}-{r.opp_pts}, {xmtxt(r.close_spread)}, beat by {r.cover_margin:+g}"
            s.append(f'<rect x="{x-6:.1f}" y="{min(base,yv):.1f}" width="12" height="{abs(base-yv):.1f}" class="bar {cls}"><title>{H.escape(tip)}</title></rect>')
            nm=r.opponent.replace('Mississippi State','Miss St').replace('South Carolina','S Carolina').replace(' State',' St').replace('Appalachian','App')
            s.append(f'<text x="{x:.1f}" y="{base+50}" class="oppl" text-anchor="middle" transform="rotate(-38 {x:.1f} {base+50})">{H.escape(nm[:16])}</text>')
    s.append('</svg>'); return ''.join(s)

def xwchart(g,color,t):
    seasons=sorted(g.season.unique()); W,rh=720,34; L,R=130,250; Hh=rh*len(seasons)+50
    xmin,xmax=0,15; X=lambda v:L+(v-xmin)/(xmax-xmin)*(W-L-R)
    s=[f'<svg viewBox="0 0 {W} {Hh}" class="chart" role="img" aria-label="Actual, expected and deserved wins by season">']
    for v in range(0,16,3): s.append(f'<line x1="{X(v):.1f}" y1="10" x2="{X(v):.1f}" y2="{Hh-30}" class="grid"/><text x="{X(v):.1f}" y="{Hh-12}" class="tick" text-anchor="middle">{v}</text>')
    for i,yr in enumerate(seasons):
        y=22+i*rh; st=stats(g[g.season==yr]); a=st['w']; e=st['xw']; sw=st['sow']; r=srow(t,yr); cl=r.get('coach_last','') if HAS_S else ''
        cl='' if not isinstance(cl,str) or cl=='–' else cl
        s.append(f'<text x="{L-10}" y="{y+5}" class="tname" text-anchor="end">{yr}<tspan class="tick"> {H.escape(cl)}</tspan></text>')
        s.append(f'<line x1="{X(e):.1f}" y1="{y}" x2="{X(a):.1f}" y2="{y}" class="stem"/>')
        s.append(f'<circle cx="{X(e):.1f}" cy="{y}" r="6" fill="none" stroke="{color}" stroke-width="2.5"><title>{yr} expected: {xrec(st)}</title></circle>')
        s.append(f'<rect x="{X(sw)-5:.1f}" y="{y-5}" width="10" height="10" fill="{color}" opacity=".45"><title>{yr} deserved: {sw:.1f}</title></rect>')
        s.append(f'<circle cx="{X(a):.1f}" cy="{y}" r="6" fill="{color}"><title>{yr} actual: {a}-{st["l"]}</title></circle>')
        s.append(f'<text x="{W-R+14}" y="{y+4}" class="tick">{a}-{st["l"]}, {z0(a-e):+.1f} vs expected, {z0(a-sw):+.1f} vs deserved</text>')
    s.append(f'<text x="{(L+W-R)/2:.0f}" y="{Hh-0}" class="axis" text-anchor="middle">Wins</text></svg>'); return ''.join(s)

def rankchart(t):
    ss=S[S.team==t].sort_values('season'); yrs=[int(y) for y in ss.season]; W,Hh=720,320; L,R,T,B=56,20,34,40; YM=60
    if not yrs: return ''
    X=lambda i:L+(i+0.5)/len(yrs)*(W-L-R); Y=lambda r:T+(min(r,YM)-1)/(YM-1)*(Hh-T-B)
    s=[f'<svg viewBox="0 0 {W} {Hh}" class="chart" role="img" aria-label="National rank by season: talent, SP+, preseason AP, with head-coach eras">']
    runs=[]
    for i,(c,fy) in enumerate(zip(ss.coach.fillna(''),ss.coach_first_year.fillna(-1))):
        if runs and runs[-1][0]==(c,fy): runs[-1][2]=i
        else: runs.append([(c,fy),i,i])
    for k,((c,fy),a,b) in enumerate(runs):
        x0=L+a/len(yrs)*(W-L-R); x1=L+(b+1)/len(yrs)*(W-L-R)
        s.append(f'<rect x="{x0:.1f}" y="{T-20}" width="{x1-x0:.1f}" height="{Hh-B-T+20}" fill="var(--ink)" opacity="{0.07 if k%2 else 0.02}"/>')
        if c: s.append(f'<text x="{(x0+x1)/2:.1f}" y="{T-6}" class="tick" text-anchor="middle">{H.escape(c.split()[-1])}{" (from "+str(int(fy))+")" if 0<fy<yrs[a] else ""}</text>')
    for r in [1,10,20,30,40,50,60]: s.append(f'<line x1="{L}" y1="{Y(r):.1f}" x2="{W-R}" y2="{Y(r):.1f}" class="grid"/><text x="{L-8}" y="{Y(r)+4:.1f}" class="tick" text-anchor="end">{"60+" if r==60 else r}</text>')
    for i,yr in enumerate(yrs): s.append(f'<text x="{X(i):.1f}" y="{Hh-B+20}" class="tick" text-anchor="middle">{yr}</text>')
    s.append(f'<text transform="translate(14 {(T+Hh-B)/2:.0f}) rotate(-90)" class="axis" text-anchor="middle">National rank</text>')
    for col,lab,stroke,dash in [('talent_rank','Talent composite','var(--accent)',''),('sp_rank','SP+','var(--ink)',''),('ap_pre','Preseason AP','var(--push)','6 4')]:
        if col not in ss: continue
        pts_=[(i,v) for i,v in enumerate(ss[col]) if pd.notna(v)]
        rr=[]
        for i,v in pts_:
            if rr and rr[-1][-1][0]==i-1: rr[-1].append((i,v))
            else: rr.append([(i,v)])
        for run in rr:
            if len(run)>1: s.append(f'<polyline points="{" ".join(f"{X(i):.1f},{Y(v):.1f}" for i,v in run)}" fill="none" stroke="{stroke}" stroke-width="2" stroke-dasharray="{dash}"/>')
        for i,v in pts_: s.append(f'<circle cx="{X(i):.1f}" cy="{Y(v):.1f}" r="5" fill="{stroke}"><title>{yrs[i]} {lab}: No. {v:.0f}</title></circle>')
    s.append('</svg>'); return ''.join(s)

def trendchart(g,color):
    W,Hh=720,320; L,R,T,B=56,20,20,44; n=int(g.gi.max()); xmin,xmax=1,max(n,12); ymin,ymax=-35,35
    X=lambda v:L+(v-xmin)/(xmax-xmin)*(W-L-R); Y=lambda v:T+(ymax-v)/(ymax-ymin)*(Hh-T-B)
    s=[f'<svg viewBox="0 0 {W} {Hh}" class="chart" role="img" aria-label="Beat expectations by, by game of the season">']
    for v in range(-30,31,10): s.append(f'<line x1="{L}" y1="{Y(v):.1f}" x2="{W-R}" y2="{Y(v):.1f}" class="{"zero" if v==0 else "grid"}"/><text x="{L-8}" y="{Y(v)+4:.1f}" class="tick" text-anchor="end">{v:+d}</text>')
    for v in range(xmin,xmax+1): s.append(f'<text x="{X(v):.1f}" y="{Hh-B+18}" class="tick" text-anchor="middle">{v}</text>')
    for b in [4.5,8.5]: s.append(f'<line x1="{X(b):.1f}" y1="{T}" x2="{X(b):.1f}" y2="{Hh-B}" class="grid" stroke-dasharray="4 4"/>')
    for x,lab in [(2.5,'Early'),(6.5,'Middle'),((8.5+xmax)/2,'Late')]: s.append(f'<text x="{X(x):.1f}" y="{T+12}" class="lbl faint" text-anchor="middle">{lab}</text>')
    s.append(f'<text x="{(L+W-R)/2:.0f}" y="{Hh-6}" class="axis" text-anchor="middle">Game of the season (postseason included)</text>')
    s.append(f'<text transform="translate(14 {(T+Hh-B)/2:.0f}) rotate(-90)" class="axis" text-anchor="middle">Beat expectations by (points)</text>')
    for yr,rs in g.groupby('season'):
        pts_=[(r.gi,max(ymin,min(ymax,r.cover_margin))) for _,r in rs.iterrows()]
        s.append(f'<polyline points="{" ".join(f"{X(a):.1f},{Y(b):.1f}" for a,b in pts_)}" fill="none" stroke="{color}" stroke-width="1.3" opacity=".22"><title>{yr}</title></polyline>')
    m=g.groupby('gi').cover_margin.agg(['mean','count']); m=m[m['count']>=3]
    s.append(f'<polyline points="{" ".join(f"{X(i):.1f},{Y(max(ymin,min(ymax,v))):.1f}" for i,v in m["mean"].items())}" fill="none" stroke="{color}" stroke-width="3.5"/>')
    for i,v in m['mean'].items(): s.append(f'<circle cx="{X(i):.1f}" cy="{Y(max(ymin,min(ymax,v))):.1f}" r="4.5" fill="{color}"><title>Game {i}, {NSEAS}-season average: beat by {v:+.1f}</title></circle>')
    s.append('</svg>'); return ''.join(s)

def surprises(g):
    def row(r):
        loc={'H':'vs','A':'at','N':'vs (N)'}[r.site]
        return f"<tr><td>{r.season} {loc} {H.escape(r.opponent)}</td><td>{r.su} {r.team_pts}-{r.opp_pts}</td><td>{xmtxt(r.close_spread)}</td><td>{r.p*100:.0f}%</td></tr>"
    hdr="<tr><th>Game</th><th>Result</th><th>Going in</th><th>Chance to win</th></tr>"
    wins=''.join(row(r) for _,r in g[g.su=='W'].nsmallest(5,'p').iterrows())
    losses=''.join(row(r) for _,r in g[g.su=='L'].nlargest(5,'p').iterrows())
    return f"<h3>Unlikeliest wins</h3><div class='wrap'><table>{hdr}{wins}</table></div><h3>Most surprising losses</h3><div class='wrap'><table>{hdr}{losses}</table></div>"

def split_table(g):
    rows=[]
    for lab,sub in [('All games',g),('Expected to win',g[g.fav=='Favorite']),('Expected to lose',g[g.fav=='Underdog']),
                    ('Expected to win by 14+',g[g.close_spread<=-14]),('Home',g[g.site=='H']),('Away',g[g.site=='A']),('Neutral',g[g.site=='N']),
                    ('Conference games',g[g.conf_game=='Y']),('Non-conference',g[g.conf_game=='N']),('Postseason',g[g.season_type=='postseason'])]:
        if len(sub)==0: continue
        st=stats(sub); rows.append(f"<tr><td>{lab}</td><td>{st['n']}</td><td>{st['w']}-{st['l']}</td><td>{rec(st)}</td><td>{st['pct']:.0f}%</td><td>{st['cm']:+.1f}</td></tr>")
    return "<div class='wrap'><table><tr><th>Split</th><th>Games</th><th>Won-lost</th><th>Vs expectations</th><th>Beat %</th><th>Beat by, avg</th></tr>"+''.join(rows)+"</table></div>"

def thirds_table(th):
    rows=''.join(f"<tr><td>{lab}</td><td>{s['n']}</td><td>{s['w']}-{s['l']}</td><td>{s['xw']:.1f}</td><td>{s['am']:+.1f}</td><td>{s['cm']:+.1f}</td><td>{s['pve']*100:+.0f}%</td></tr>" for lab,s in th.items() if s['n'])
    return "<div class='wrap'><table><tr><th>Part of season</th><th>Games</th><th>Won-lost</th><th>Expected wins</th><th>Avg margin</th><th>Beat by, avg</th><th>Play vs expected, per game</th></tr>"+rows+"</table></div>"

def coach_table(tens,show_team=False):
    rows=[]
    for x in tens:
        st=x['st']; yrs=x['yrs']; span=f"{yrs[0]}–{yrs[-1]}" if len(yrs)>1 else str(yrs[0])
        since=f' <span class=mute>(since {x["first"]})</span>' if x['first']<yrs[0] else ''
        team=f' <span class=mute>{H.escape(x["team"])}</span>' if show_team else ''
        rows.append(f"<tr><td>{H.escape(x['coach'])}{team}</td><td>{span}{since}</td><td>{len(yrs)}</td><td>{st['w']}-{st['l']}</td><td>{st['xw']:.1f}</td><td>{st['sow']:.1f}</td><td>{dw(st):+.1f}</td><td>{luck(st):+.1f}</td><td>{mgap(st):+.1f}</td><td>{fr(x['tal'])}</td><td>{fr(x['sp'])}</td><td>{fr(gap(x),'{:+.0f}')}</td></tr>")
    return "<div class='wrap'><table><tr><th>Coach</th><th>Seasons here</th><th>#</th><th>Record</th><th>Expected</th><th>Deserved</th><th>Won vs expected</th><th>Won vs deserved</th><th>Expected vs deserved</th><th>Talent rk</th><th>SP+ rk</th><th>Talent&minus;SP+</th></tr>"+''.join(rows)+"</table></div>"

# ---------- text
GLOSS='<details class="gloss"><summary>Terms used on this page</summary><dl><dt>Expected margin</dt><dd>How many points the team was expected to win or lose by, according to the point spread the sportsbooks posted just before kickoff. It sums up what oddsmakers, bettors, and the public expected, with money behind it, so this page uses it as the measure of expectations. A week-earlier version (the opening number) also exists; when the two differ, opinion moved during the week.</dd><dt>Expected wins</dt><dd>Each game\'s expected margin converted to a chance of winning, then added up. The record the public thought was coming.</dd><dt>Deserved wins</dt><dd>Each game\'s postgame win probability, from CollegeFootballData\'s play-by-play model, added up. How many games a team that played that way usually wins. The gap between actual and deserved wins is what most people call luck.</dd><dt>SP+</dt><dd>Bill Connelly\'s efficiency rating of how well a team actually played, adjusted for opponent. Used here as the measure of quality, separate from the record.</dd><dt>Talent composite</dt><dd>247Sports\' rating of the whole roster\'s recruiting pedigree. Used here as the measure of what the players were supposed to be.</dd><dt>Beat expectations (by)</dt><dd>Won by more than the expected margin, or lost by less. "Beat by" is the actual margin minus the expected margin: +7 means seven points better than expected. A bettor would say the team covered.</dd><dt>One-score game</dt><dd>Decided by eight points or fewer.</dd><dt>Head coach, tenure year</dt><dd>The head coach who worked the most games that season, and how many seasons into his run at the school it was, counting seasons before this page\'s window and the 2020 season.</dd><dt>Standard error</dt><dd>The size of gap that random variation alone produces about a third of the time. A number within one standard error is noise. Beyond two, it is probably real. Each takeaway has a "How sure is this?" note that says which.</dd></dl></details>'

def intro_team(t,st):
    T=H.escape(t); v=dw(st)
    if v>=2: lead=f"{T} has spent {NSEAS} seasons beating expectations: {st['w']} wins against {st['xw']:.1f} expected. The question is how. <b>Were the expectations too low</b>, with the public slow to believe in a good team? <b>Did the bounces go its way</b>, winning games the play did not quite earn? <b>Or did the roster outplay its recruiting rankings?</b>"
    elif v<=-2: lead=f"{T} has spent {NSEAS} seasons short of expectations: {st['w']} wins against {st['xw']:.1f} expected. Every disappointing season comes down to one of three things. <b>The expectations were wrong:</b> the team was never as good as the polls, the public, and the fans believed. <b>The bounces were wrong:</b> the team played well enough to win and didn\'t. <b>The development was wrong:</b> the players were there and the play wasn\'t."
    else: lead=f"Over {NSEAS} seasons {T} has been about what everyone expected: {st['w']} wins against {st['xw']:.1f} expected. That does not mean nothing is going on underneath. <b>Were the expectations right for the right reasons?</b> <b>Did the bounces even out?</b> <b>Did the roster play to its recruiting rankings?</b>"
    return f'<div class="intro"><p>{lead} The sections below take those one at a time, split them by head coach, then ask whether any of it changes as a season goes on. Each ends with a short takeaway; a note under it says how much to trust the number. {SPAN_NOTE}: about {AVGN:.0f} games per team.</p></div>'
INTRO_SEC=f'<div class="intro"><p>Every season that goes differently than expected comes down to one of three things: the expectations were wrong, the bounces were wrong, or the development was wrong. This page asks those three questions of all sixteen programs at once, then of every head-coaching tenure, then asks whether any of it changes as a season goes on. Each chart ends with a short takeaway, with a note on how much to trust it. {SPAN_NOTE}: about {AVGN:.0f} games per team. Every team also has its own page in the menu above.</p></div>'

def take(body,sure): return f'<div class="take"><p><b>Takeaway:</b> {body}</p><details><summary>How sure is this?</summary><p>{sure}</p></details></div>'
def _yr_ext(ys,f,hi=True):
    yr=max(ys,key=lambda y:f(ys[y])) if hi else min(ys,key=lambda y:f(ys[y])); return yr,f(ys[yr])

def take_expect(t,st,ys):
    T=H.escape(t); mg=mgap(st); xw=st['xw']; sw=st['sow']; se=st['se_mg']
    z=abs(mg)/se if se else 0
    if mg>0:
        yr,v=_yr_ext(ys,mgap); body=f"The public expected more of {T} than the play delivered: {xw:.1f} wins expected against {sw:.1f} deserved over {NSEAS} seasons. The widest gap was {yr}, {ys[yr]['xw']:.1f} expected against {ys[yr]['sow']:.1f} deserved."
        body+=(" On this evidence the expectations were too optimistic." if z>=2 else " The expectations were probably too optimistic, though the gap is not far outside the noise." if z>=1 else " The gap is inside the noise, so call the expectations about right.")
    elif mg<0:
        yr,v=_yr_ext(ys,mgap,hi=False); body=f"The public expected less of {T} than the play delivered: {xw:.1f} wins expected against {sw:.1f} deserved. The widest gap was {yr}, {ys[yr]['sow']:.1f} deserved against {ys[yr]['xw']:.1f} expected."
        body+=(" The expectations were too pessimistic." if z>=2 else " The expectations were probably too pessimistic, though the gap is not far outside the noise." if z>=1 else " The gap is inside the noise, so call the expectations about right.")
    else:
        body=f"Expectations for {T} have matched the play exactly: {xw:.1f} wins expected, {sw:.1f} deserved."
    return take(body,f"One standard error on this gap is about &plusmn;{se:.1f} wins over {st['n']} games, so {mg:+.1f} is {sig(mg,se)}.")

def take_luck(t,st,ys):
    T=H.escape(t); lk=luck(st); w=st['w']; sw=st['sow']; tom=fr(st['tom'],'{:+.0f}'); se=st['se_lk']
    by,bv=_yr_ext(ys,luck); wy,wv=_yr_ext(ys,luck,hi=False)
    z=abs(lk)/se if se else 0
    if z<1:
        body=f"Luck is not the story. {T} won {w} games against {sw:.1f} deserved over {NSEAS} seasons. The swing seasons roughly cancel, {by} ({bv:+.1f}) against {wy} ({wv:+.1f}). One-score games went {st['osw']}-{st['osl']} and the turnover margin was {tom}."
    elif lk<0:
        body=f"{T} won {w} games against {sw:.1f} deserved, {abs(lk):.1f} wins short{'' if z>=2 else ', a gap only a little outside the noise'}, with a {st['osw']}-{st['osl']} record in one-score games and a turnover margin of {tom}. {wy} was the worst of it ({wv:+.1f})."
    else:
        body=f"The bounces have gone {T}'s way: {w} wins against {sw:.1f} deserved, {lk:.1f} to the good{'' if z>=2 else ', a gap only a little outside the noise'}, with a {st['osw']}-{st['osl']} record in one-score games and a turnover margin of {tom}. {by} was the best of it ({bv:+.1f})."
    return take(body,f"One standard error on luck is about &plusmn;{se:.1f} wins over {NSEAS} seasons, so {lk:+.1f} is {sig(lk,se)}. Luck needs far more than {st['n']} games to measure; anything under about {2*se:.0f} wins here cannot be told from nothing.")

def lg_dev_for(t): return DEV_SEC if t in SEC else DEV_ALL
def lg_name_for(t): return 'SEC' if t in SEC else 'field'
def take_roster(t,st):
    T=H.escape(t); ss=S[S.team==t]; LG_DEV=lg_dev_for(t); LGN=lg_name_for(t)
    if not HAS_S or not len(ss) or ss.talent_rank.isna().all() or ss.sp_rank.isna().all(): return ''
    ta=ss.talent_rank.mean(); sp=ss.sp_rank.mean(); dv=ta-sp; off=ss.sp_off_rank.mean(); de=ss.sp_def_rank.mean()
    gp=(ss.talent_rank-ss.sp_rank); i=gp.idxmin() if dv<0 else gp.idxmax(); r=ss.loc[i]
    below=int((gp<0).sum()); unit='offense' if off>de else 'defense'; rel=dv-LG_DEV
    if dv<=-5:
        body=f"The roster ranked No. {ta:.0f} on average and the play ranked No. {sp:.0f}, a gap of {abs(dv):.0f} spots, and the play ranked below the roster in {below} of {len(ss)} seasons. {int(r.season)} was the low point: a No. {r.talent_rank:.0f} roster that played like No. {r.sp_rank:.0f}. The offense averaged No. {off:.0f} and the defense No. {de:.0f}, so the {unit} has been the larger drag."
    elif dv>=5:
        body=f"{T} has played above its roster: No. {sp:.0f} in play against a No. {ta:.0f} roster, {dv:.0f} spots better than the recruiting rankings would predict, in {len(ss)-below} of {len(ss)} seasons. {int(r.season)} was the high point, a No. {r.talent_rank:.0f} roster that played like No. {r.sp_rank:.0f}. The offense averaged No. {off:.0f} and the defense No. {de:.0f}."
    else:
        body=f"{T} has played about like its roster: No. {sp:.0f} in play against a No. {ta:.0f} roster. The offense averaged No. {off:.0f} and the defense No. {de:.0f}."
    peers='the conference' if LGN=='SEC' else 'the programs on this site'
    if rel<=-5: judge=f"even by the standards of {peers} the roster has underdelivered."
    elif rel>=5: judge=f"by the standards of {peers} this roster has overdelivered."
    else: judge=f"against that baseline {T} is typical of {peers}. The absolute gap is real; the relative one is not."
    body+=f" The comparison that matters is the peer group: the average gap across {'the SEC' if LGN=='SEC' else 'all the programs on this site'} is {LG_DEV:+.0f} spots, because the talent composite rates elite rosters higher than they play, so {judge}"
    return take(body,f"{NSEAS} seasons of rank averages carry roughly &plusmn;{RK_SE:.0f} spots of noise; single-season gaps of 20 or more spots are well outside it. The peer comparison is the fair one, since the talent composite is generous to every roster here.")

def take_coaches(t):
    T=H.escape(t); tens=[x for x in TEN[t] if len(x['yrs'])>=2 and pd.notna(gap(x))]
    if not TEN[t]: return ''
    if len(tens)<2: return take(f"{T} has had one head coach for most of the window, so the coach split adds little the sections above did not say.","Nothing to test with one tenure.")
    best=max(tens,key=gap); worst=min(tens,key=gap)
    lk=max(tens,key=lambda x:abs(luck(x['st']))); mg=max(tens,key=lambda x:abs(mgap(x['st'])))
    body=(f"Of the coaches with two or more seasons here, {H.escape(best['coach'])} got the most out of the roster (No. {best['tal']:.0f} talent, No. {best['sp']:.0f} play, {gap(best):+.0f} spots) and {H.escape(worst['coach'])} the least ({gap(worst):+.0f} spots). "
          f"The biggest expectation gap belongs to {H.escape(mg['coach'])} ({mgap(mg['st']):+.1f} wins, {'overrated' if mgap(mg['st'])>0 else 'underrated'} by the public over {mg['st']['n']} games); the biggest luck swing to {H.escape(lk['coach'])} ({luck(lk['st']):+.1f} wins).")
    short=[x for x in tens if x['st']['n']<40]
    sure=(f"Tenures of two or three seasons are 25 to 40 games, so their standard errors are roughly &plusmn;{SDG*math.sqrt(30):.1f} wins on the expectation gap and &plusmn;{math.sqrt(30*0.16):.1f} on luck; "+(f"{', '.join(H.escape(x['coach']) for x in short)} {'is' if len(short)==1 else 'are'} in that range" if short else "none of these tenures is that short")+". Treat rank averages over two seasons as &plusmn;8 spots.")
    return take(body,sure)

def take_trend(t,st,g):
    T=H.escape(t); diff,se,th=trend(g); e,m,l=th[THIRDS[0]],th[THIRDS[1]],th[THIRDS[2]]
    if pd.isna(diff): return ''
    wd,sew=wtrend(th)
    if abs(diff)<3: body=f"By margin, no real pattern: {T} was {pts(e['cm'])} early in seasons, {pts(m['cm'])} in the middle, and {pts(l['cm'])} late."
    elif diff>0: body=f"By margin, {T} has finished seasons better than it started them: {pts(l['cm'])} from game 9 on, versus {pts(e['cm'])} in the first four. Because the expected margin already adjusts week by week, that means the public was slow to catch up."
    else: body=f"By margin, {T} has faded as seasons go on: {pts(l['cm'])} from game 9 on, versus {pts(e['cm'])} in the first four. Because the expected margin already adjusts week by week, that means the public kept believing longer than the play warranted."
    body+=f" In wins: {e['w']}-{e['l']} early against {e['xw']:.1f} expected ({dw(e):+.1f}), {l['w']}-{l['l']} late against {l['xw']:.1f} expected ({dw(l):+.1f})."
    if abs(wd)>=2*sew and abs(diff)<2*se: body+=f" The wins tell a clearer story than the margins: late-season results have run {abs(wd):.1f} wins {'ahead of' if wd>0 else 'behind'} expectations relative to the early stretch, and that is outside the noise. {'Winning big games narrowly is not luck the public rewards.' if wd>0 else 'That is the profile of a team that loses the close ones when the schedule stiffens.'}"
    return take(body,f"One standard error on the early-versus-late margin difference is about &plusmn;{se:.1f} points a game ({e['n']} early games, {l['n']} late), so {diff:+.1f} is {sig(diff,se)}. On the wins comparison one standard error is about &plusmn;{sew:.1f} wins, so {wd:+.1f} is {sig(wd,sew)}. Single-game swings of 20 points are routine, which is why the faint season lines look so jagged.")

def bottom(t,st,g):
    T=H.escape(t); mg=mgap(st); lk=luck(st); ss=S[S.team==t]; LG_DEV=lg_dev_for(t); LGN=lg_name_for(t)
    zm=abs(mg)/st['se_mg']; zl=abs(lk)/st['se_lk']
    dirn='too high' if mg>0 else 'too low'
    if zm>=2: e=f'Expectations for {T} have clearly run {dirn} ({mg:+.1f} wins, {strength(mg,st["se_mg"])})'
    elif zm>=1: e=f'Expectations for {T} have probably run {dirn} ({mg:+.1f} wins, {strength(mg,st["se_mg"])})'
    else: e=f'Expectations for {T} have been about right ({mg:+.1f} wins, within the noise)'
    l=(f'Luck has been a non-factor ({lk:+.1f} wins, within the noise)' if zl<1 else (('It has clearly been ' if zl>=2 else 'It has probably been ')+('unlucky' if lk<0 else 'lucky')+f' ({lk:+.1f} wins, {strength(lk,st["se_lk"])})'))
    if HAS_S and len(ss) and ss.talent_rank.notna().any():
        dv=round(ss.talent_rank.mean()-ss.sp_rank.mean())+0.0; rel=dv-LG_DEV
        peer='SEC' if LGN=='SEC' else 'peer-group'
        r=(f'The roster has underdelivered even by {peer} standards ({dv:+.0f} spots against a {peer} average of {LG_DEV:+.0f})' if rel<=-5 else
           f'The roster has outplayed its rankings by {peer} standards ({dv:+.0f} spots against a {peer} average of {LG_DEV:+.0f})' if rel>=5 else
           f'The roster-to-play gap ({dv:+.0f} spots) is the {peer} norm ({LG_DEV:+.0f}); the talent rankings flatter every elite roster, not just {T}')
    else: r='No roster data'
    diff,se,th=trend(g); tr=''; wd,sew=wtrend(th)
    if pd.notna(diff) and abs(diff)>=2*se: tr=f" Late-season form has been {'better' if diff>0 else 'worse'} than early-season form by {abs(diff):.0f} points a game, and that is outside the noise."
    elif pd.notna(wd) and abs(wd)>=2*sew: tr=f" Late in seasons {T} has {'won' if wd>0 else 'lost'} more than expected relative to its early-season results, by {abs(wd):.1f} wins, and that is outside the noise even though the margins are not."
    tens=[x for x in TEN[t] if len(x['yrs'])>=2 and pd.notna(gap(x))]; ct=''
    if len(tens)>=2:
        b=max(tens,key=gap); w=min(tens,key=gap)
        if gap(b)-gap(w)>=10: ct=f" By coach, the roster-to-play gap ran from {gap(b):+.0f} under {H.escape(b['last'])} to {gap(w):+.0f} under {H.escape(w['last'])}."
    return f'<div class="take bottom"><p><b>Bottom line:</b> {e}. {l}. {r}.{ct}{tr}</p></div>'

def team_section(t):
    g=d[d.team==t].sort_values('date'); st=stats(g); col=COLORS[t]
    yrs=sorted(int(y) for y in g.season.unique()); ys={yr:stats(g[g.season==yr]) for yr in yrs}
    def cl(yr):
        v=srow(t,yr).get('coach_last','–') if HAS_S else '–'
        return H.escape(str(v)) if isinstance(v,str) else '–'
    def cty(yr):
        v=srow(t,yr).get('coach_tenure_year',np.nan) if HAS_S else np.nan
        return f' ({int(v)})' if pd.notna(v) else ''
    t1=''.join(f"<tr><td>{yr}</td><td class=mute>{cl(yr)}</td><td>{s['w']}-{s['l']}</td><td>{xrec(s)}</td><td>{s['sow']:.1f}-{s['n']-s['sow']:.1f}</td><td>{dw(s):+.1f}</td><td>{luck(s):+.1f}</td><td>{s['fw']}-{s['fl']}</td><td>{s['uw']}-{s['ul']}</td></tr>" for yr,s in ys.items())
    t2=''.join(f"<tr><td>{yr}</td><td>{s['w']}-{s['l']}</td><td>{s['osw']}-{s['osl']}</td><td>{fr(s['tom'],'{:+.0f}')}</td><td>{luck(s):+.1f}</td></tr>" for yr,s in ys.items())
    t3=''.join(f"<tr><td>{yr}</td><td class=mute>{cl(yr)}{cty(yr)}</td><td>{fr(r.get('talent_rank'))}</td><td>{fr(r.get('recruit_rank'))}</td><td>{fr(r.get('ap_pre'))}</td><td>{fr(r.get('sp_rank'))}</td><td>{fr(r.get('sp_off_rank'))}</td><td>{fr(r.get('sp_def_rank'))}</td><td>{ys[yr]['w']}-{ys[yr]['l']}</td></tr>" for yr in yrs for r in [srow(t,yr)])
    t4=''.join(f"<tr><td>{yr}</td><td>{s['w']}-{s['l']}</td><td>{rec(s)}</td><td>{s['pct']:.0f}%</td><td>{s['cm']:+.1f}</td></tr>" for yr,s in ys.items())
    mv=g.dropna(subset=['move']); mvtxt=''
    if len(mv)>20:
        toward=mv[mv.move<0]; away=mv[mv.move>0]
        mvtxt=f"<p>Of {len(mv)} games with a week-earlier number on file, opinion moved toward {H.escape(t)} during the week in {len(toward)} ({stats(toward)['pct']:.0f}% beat expectations when it did) and away in {len(away)} ({stats(away)['pct']:.0f}%). Average movement {mv.move.mean():+.2f} points; negative means the public leaned further toward the team as kickoff approached.</p>"
    tal_t=tal.get(t,np.nan); sp_t=spr.get(t,np.nan); diff,se,th=trend(g)
    coach_block=(f'''<h3>By head coach</h3>
<p>The same numbers split by head-coaching tenure. Tenure years count seasons before this window and 2020, which is left out of every other number on the page.</p>
{coach_table(TEN[t])}
{take_coaches(t)}''' if TEN[t] else '')
    return f'''<section class="team" id="{slug(t)}" style="--accent:{col}">
<h1>{H.escape(t)}</h1>
<p class="sub">Every game over {NSEAS} seasons, from the {H.escape(t)} side of the expectations.</p>
<div class="big"><div><b>{st['w']}-{st['l']}</b><span>won-lost, {st['n']} games</span></div><div><b>{st['xw']:.1f}</b><span>wins the public expected</span></div><div><b>{st['sow']:.1f}</b><span>wins the play deserved</span></div><div><b>No. {fr(tal_t)}</b><span>roster by talent, avg national rank</span></div><div><b>No. {fr(sp_t)}</b><span>quality of play (SP+), avg national rank</span></div></div>
{intro_team(t,st)}
{GLOSS}
<h2>1. Were the expectations wrong?</h2>
<p>Every game carries an expected margin, the point spread posted just before kickoff, which sums up what oddsmakers, bettors, and the public thought would happen. Convert each one to a chance of winning and add them up, and you get the record the public expected. Deserved wins come from the other direction: after each game, a play-by-play model estimates how often a team that played that way wins it. If the public expected more wins than the play deserved, the expectations were too optimistic.</p>
{xwchart(g,col,t)}
<div class="key"><span><i style="background:var(--accent)"></i>Won</span><span><i class="open"></i>Public expected</span><span><i class="sq" style="background:var(--accent)"></i>Play deserved</span></div>
<div class="wrap"><table><tr><th>Season</th><th>Coach</th><th>Record</th><th>Expected</th><th>Deserved</th><th>Won vs expected</th><th>Won vs deserved</th><th>Expected to win</th><th>Expected to lose</th></tr>{t1}</table></div>
{take_expect(t,st,ys)}
<h2>2. Was it luck?</h2>
<p>Luck is the gap between what the play deserved and what actually happened: close games, turnovers, and the afternoons that defied the odds. The games below are ranked by the pre-game chance of winning implied by the expected margin.</p>
{surprises(g)}
<h3>Close games and turnovers</h3>
<div class="wrap"><table><tr><th>Season</th><th>Record</th><th>One-score games</th><th>Turnover margin</th><th>Won vs deserved</th></tr>{t2}</table></div>
{take_luck(t,st,ys)}
<h2>3. Was it the roster?</h2>
<p>Three national rankings side by side: the roster's recruiting pedigree (247Sports talent composite), how well the team actually played (SP+), and where the preseason AP poll had it. Lower is better. When the play line sits below the talent line, the roster gave less than its rankings promised. Above it, more. Shaded bands mark head-coaching eras.</p>
{rankchart(t) if HAS_S else ''}
<div class="key"><span><i style="background:var(--accent)"></i>Talent composite</span><span><i style="background:var(--ink)"></i>SP+ (quality of play)</span><span><i style="background:var(--push)"></i>Preseason AP (blank = unranked)</span></div>
<div class="wrap"><table><tr><th>Season</th><th>Coach (year)</th><th>Talent</th><th>Recruiting class</th><th>Preseason AP</th><th>SP+</th><th>Offense</th><th>Defense</th><th>Record</th></tr>{t3}</table></div>
{take_roster(t,st)}
{coach_block}
<h2>4. Does it change as the season goes on?</h2>
<p>Each faint line is one season, game by game: how many points {H.escape(t)} beat expectations by, or fell short. The heavy line is the {NSEAS}-season average for that game of the year. The table pools the seasons into early, middle, and late stretches. The expected margin already moves week to week as opinion changes, so a pattern here says the public was slow to adjust, in one direction or the other.</p>
{trendchart(g,col)}
{thirds_table(th)}
{take_trend(t,st,g)}
{bottom(t,st,g)}
<h2>Appendix: game by game against expectations</h2>
<p>For readers who follow the point spreads. Everything above was built from these games.</p>
<div class="big"><div><b>{rec(st)}</b><span>vs expectations (beat-short-even)</span></div><div><b>{st['pct']:.0f}%</b><span>beat expectations (52.4% is a bettor's break-even)</span></div><div><b>{st['cm']:+.1f}</b><span>beat expectations by, avg points</span></div></div>
<h3>Expected margin versus actual margin</h3>
<p>Each dot is one game. Left to right is how many points {H.escape(t)} was expected to win or lose by; up and down is what actually happened. Dots above the dashed line beat expectations, dots below fell short.</p>
{scatter(g,col)}
<div class="key"><span><i style="background:var(--accent)"></i>Beat expectations</span><span><i style="background:var(--nocover)"></i>Fell short</span><span><i style="background:var(--push)"></i>Exactly even</span></div>
<h3>Beat expectations by, game by game</h3>
{strip(g)}
<h3>Season by season</h3>
<div class="wrap"><table><tr><th>Season</th><th>Record</th><th>Vs expectations</th><th>Beat %</th><th>Beat by, avg</th></tr>{t4}</table></div>
<h3>Splits</h3>
{split_table(g)}
{mvtxt}
{take(f"A {st['pct']:.0f}% rate of beating expectations over {st['n']} games, against an even split. Over {NSEAS} seasons the public's expected margins for {H.escape(t)} have been {'too optimistic by' if st['cm']<-1.5 else 'too pessimistic by' if st['cm']>1.5 else 'close to right, off by'} {abs(st['cm']):.1f} points a game on average.", f"The rate is {sig(st['pct']-50,st['se_pct'])} against an even split; one standard error is about &plusmn;{st['se_pct']:.0f} points at this sample size. The splits above are smaller samples still and should be treated as anecdotes.")}
<p class="more">{'<a href="'+BASE+'sec/">Compare with the rest of the SEC</a> · ' if t in SEC else ''}<a href="{BASE}national/">Compare across the SEC and the national field</a></p>
</section>'''

# ---------- shared across pages
tal={t:(S[S.team==t].talent_rank.mean() if HAS_S and 'talent_rank' in S else np.nan) for t in ALLTEAMS}
spr={t:(S[S.team==t].sp_rank.mean() if HAS_S and 'sp_rank' in S else np.nan) for t in ALLTEAMS}
dev={t:(tal[t]-spr[t] if pd.notna(tal[t]) and pd.notna(spr[t]) else 0) for t in ALLTEAMS}
DEV_SEC=float(np.mean([dev[t] for t in SEC])); DEV_ALL=float(np.mean([dev[t] for t in ALLTEAMS]))
tot={t:stats(d[d.team==t]) for t in ALLTEAMS}
fav={t:stats(d[(d.team==t)&(d.fav=='Favorite')]) for t in ALLTEAMS}
dog={t:stats(d[(d.team==t)&(d.fav=='Underdog')]) for t in ALLTEAMS}
mvs={t:d[(d.team==t)].move.mean() for t in ALLTEAMS}
trd={t:trend(d[d.team==t]) for t in ALLTEAMS}
sd=d.groupby('team').cover_margin.mean().std()
lg_th={th:stats(d[d.third==th]) for th in THIRDS}; lg_nc={th:stats(d[(d.third==th)&(d.conf_game=='N')]) for th in THIRDS}

def build_league(KEY,TITLE,SUB,INTRO,TL):
    global TEAMS,LG_DEV,ALLTEN,order,xorder,dorder,morder,lorder,torder,ctx_rows,conf_rows,allst,am,rank,xrank,mrank,lrank,drank,trank,xw_rows,trend_rows,LONG,FY,coach_section,conf
    TEAMS=TL
    global lg_th,lg_nc
    lg_th={th:stats(d[(d.third==th)&(d.team.isin(TEAMS))]) for th in THIRDS}; lg_nc={th:stats(d[(d.third==th)&(d.conf_game=='N')&(d.team.isin(TEAMS))]) for th in THIRDS}
    order=sorted(TEAMS,key=lambda t:tot[t]['cm'],reverse=True)
    xorder=sorted(TEAMS,key=lambda t:dw(tot[t]),reverse=True)
    dorder=sorted(TEAMS,key=lambda t:dev[t],reverse=True)
    LG_DEV=DEV_SEC if KEY=='sec' else DEV_ALL
    ALLTEN=[x for t in TEAMS for x in TEN[t]]
    morder=sorted(TEAMS,key=lambda t:mgap(tot[t]),reverse=True)
    lorder=sorted(TEAMS,key=lambda t:luck(tot[t]),reverse=True)
    torder=sorted(TEAMS,key=lambda t:trd[t][0],reverse=True)
    ctx_rows=''.join(f"<tr{' class=hi' if t=='Texas A&M' else ''}><td>{H.escape(t)}</td><td>{fr(tal[t])}</td><td>{fr(spr[t])}</td><td>{fr(dev[t],'{:+.0f}')}</td><td>{tot[t]['w']}-{tot[t]['l']}</td><td>{tot[t]['sow']:.1f}</td><td>{tot[t]['xw']:.1f}</td><td>{luck(tot[t]):+.1f}</td><td>{mgap(tot[t]):+.1f}</td></tr>" for t in morder)

    def lollipop(keys,val,label,xr,step,fmt='{:+.1f}',aria=''):
        W,rh=720,30; L,R=150,30; Hh=rh*len(keys)+50; xmin,xmax=xr; X=lambda v:L+(v-xmin)/(xmax-xmin)*(W-L-R)
        s=[f'<svg viewBox="0 0 {W} {Hh}" class="chart" role="img" aria-label="{aria}">']
        for v in range(xmin,xmax+1,step): s.append(f'<line x1="{X(v):.1f}" y1="10" x2="{X(v):.1f}" y2="{Hh-30}" class="{"zero" if v==0 else "grid"}"/><text x="{X(v):.1f}" y="{Hh-12}" class="tick" text-anchor="middle">{v:+d}</text>')
        for i,t in enumerate(keys):
            y=20+i*rh; raw=val(t); v=max(xmin,min(xmax,raw))
            s.append(f'<text x="{L-10}" y="{y+5}" class="tname{" hi" if t=="Texas A&M" else ""}" text-anchor="end">{H.escape(t)}</text>')
            s.append(f'<line x1="{X(0):.1f}" y1="{y}" x2="{X(v):.1f}" y2="{y}" class="stem"/>')
            s.append(f'<circle cx="{X(v):.1f}" cy="{y}" r="7" fill="{COLORS[t]}" class="dot"><title>{H.escape(label(t))}</title></circle>')
            s.append(f'<text x="{X(v)+(12 if v>=0 else -12):.1f}" y="{y+4}" class="tick" text-anchor="{"start" if v>=0 else "end"}">{fmt.format(round(raw)+0.0 if ".0f" in fmt else raw)}</text>')
        s.append('</svg>'); return ''.join(s)
    def dotplot(): return lollipop(order,lambda t:tot[t]['cm'],lambda t:f"{t}: {rec(tot[t])} vs expectations, {tot[t]['pct']:.0f}%, avg {tot[t]['cm']:+.2f}",(-4,4),1,aria='Average beat-expectations margin by team')
    def xwplot():
        m=max(8,int(math.ceil(max(abs(dw(tot[t])) for t in TEAMS)/4)*4)); return lollipop(xorder,lambda t:dw(tot[t]),lambda t:f"{t}: {tot[t]['w']}-{tot[t]['l']} actual, {xrec(tot[t])} expected",(-m,m),4 if m>8 else 2,aria='Wins above expectation by team')
    def devplot(): return lollipop(dorder,lambda t:dev[t],lambda t:f"{t}: avg talent rank {tal[t]:.0f}, avg SP+ rank {spr[t]:.0f}",(-30,30),10,'{:+.0f}',aria='Talent rank minus SP+ rank by team')
    def trendplot(): return lollipop(torder,lambda t:trd[t][0],lambda t:f"{t}: early {trd[t][2][THIRDS[0]]['cm']:+.1f}, late {trd[t][2][THIRDS[2]]['cm']:+.1f} points a game vs expectations",(-12,12),4,aria='Late-season minus early-season margin against expectations, by team')

    def favdog():
        W,rh=720,30; L,R=150,30; Hh=rh*len(TEAMS)+50; xmin,xmax=20,80; X=lambda v:L+(v-xmin)/(xmax-xmin)*(W-L-R)
        s=[f'<svg viewBox="0 0 {W} {Hh}" class="chart" role="img" aria-label="Beat-expectations rate when expected to win versus expected to lose">']
        for v in range(20,81,10): s.append(f'<line x1="{X(v):.1f}" y1="10" x2="{X(v):.1f}" y2="{Hh-30}" class="{"zero" if v==50 else "grid"}"/><text x="{X(v):.1f}" y="{Hh-12}" class="tick" text-anchor="middle">{v}%</text>')
        for i,t in enumerate(sorted(TEAMS,key=lambda t:fav[t]['pct'],reverse=True)):
            y=20+i*rh; f=fav[t]['pct']; u=dog[t]['pct']
            s.append(f'<text x="{L-10}" y="{y+5}" class="tname{" hi" if t=="Texas A&M" else ""}" text-anchor="end">{H.escape(t)}</text>')
            s.append(f'<line x1="{X(f):.1f}" y1="{y}" x2="{X(u):.1f}" y2="{y}" class="stem"/>')
            s.append(f'<circle cx="{X(f):.1f}" cy="{y}" r="6" fill="{COLORS[t]}"><title>{H.escape(t)} when expected to win: {rec(fav[t])} ({f:.0f}%)</title></circle>')
            s.append(f'<circle cx="{X(u):.1f}" cy="{y}" r="6" fill="none" stroke="{COLORS[t]}" stroke-width="2.5"><title>{H.escape(t)} when expected to lose: {rec(dog[t])} ({u:.0f}%)</title></circle>')
        s.append('</svg>'); return ''.join(s)

    def quad():
        W,Hh=720,540; L,R,T,B=56,20,24,48
        pts_={t:(luck(tot[t]),mgap(tot[t])) for t in TEAMS}
        m=max(6,math.ceil(max(max(abs(x),abs(y)) for x,y in pts_.values())+0.5))
        X=lambda v:L+(v+m)/(2*m)*(W-L-R); Y=lambda v:T+(m-v)/(2*m)*(Hh-T-B)
        s=[f'<svg viewBox="0 0 {W} {Hh}" class="chart" role="img" aria-label="Overrated versus underrated and overperforming versus underperforming">']
        step=2 if m<=8 else 4
        for v in range(-m,m+1,step):
            s.append(f'<line x1="{X(v):.1f}" y1="{T}" x2="{X(v):.1f}" y2="{Hh-B}" class="{"zero" if v==0 else "grid"}"/><text x="{X(v):.1f}" y="{Hh-B+18}" class="tick" text-anchor="middle">{v:+d}</text>')
            s.append(f'<line x1="{L}" y1="{Y(v):.1f}" x2="{W-R}" y2="{Y(v):.1f}" class="{"zero" if v==0 else "grid"}"/><text x="{L-8}" y="{Y(v)+4:.1f}" class="tick" text-anchor="end">{v:+d}</text>')
        for x,y,a,txt in [(L+8,T+14,'start','Overrated, underperformed'),(W-R-8,T+14,'end','Overrated, overperformed'),(L+8,Hh-B-8,'start','Underrated, underperformed'),(W-R-8,Hh-B-8,'end','Underrated, overperformed')]:
            s.append(f'<text x="{x}" y="{y}" class="lbl faint" text-anchor="{a}">{txt}</text>')
        s.append(f'<text x="{(L+W-R)/2:.0f}" y="{Hh-8}" class="axis" text-anchor="middle">Actual wins minus deserved wins (overperformed to the right)</text>')
        s.append(f'<text transform="translate(14 {(T+Hh-B)/2:.0f}) rotate(-90)" class="axis" text-anchor="middle">Expected minus deserved wins (overrated is up)</text>')
        for t in sorted(TEAMS,key=lambda t:pts_[t][1]):
            x,y=pts_[t]; s.append(f'<circle cx="{X(x):.1f}" cy="{Y(y):.1f}" r="7" fill="{COLORS[t]}" class="dot"><title>{H.escape(t)}: won {tot[t]["w"]}, deserved {tot[t]["sow"]:.1f}, public expected {tot[t]["xw"]:.1f}</title></circle>')
            s.append(f'<text x="{X(x)+10:.1f}" y="{Y(y)+4:.1f}" class="tname{" hi" if t=="Texas A&M" else ""}" style="font-size:12px">{H.escape(t)}</text>')
        s.append('</svg>'); return ''.join(s)

    def coachplot():
        tens=[x for x in ALLTEN if len(x['yrs'])>=3 and pd.notna(gap(x))]
        if not tens: return ''
        W,Hh=720,600; L,R,T,B=56,20,24,48; M=70
        X=lambda v:L+(min(v,M)-1)/(M-1)*(W-L-R); Y=lambda v:T+(min(v,M)-1)/(M-1)*(Hh-T-B)
        s=[f'<svg viewBox="0 0 {W} {Hh}" class="chart" role="img" aria-label="Head-coaching tenures: roster talent rank against SP+ rank">']
        for v in [1,10,20,30,40,50,60,70]:
            s.append(f'<line x1="{X(v):.1f}" y1="{T}" x2="{X(v):.1f}" y2="{Hh-B}" class="grid"/><text x="{X(v):.1f}" y="{Hh-B+18}" class="tick" text-anchor="middle">{"70+" if v==70 else v}</text>')
            s.append(f'<line x1="{L}" y1="{Y(v):.1f}" x2="{W-R}" y2="{Y(v):.1f}" class="grid"/><text x="{L-8}" y="{Y(v)+4:.1f}" class="tick" text-anchor="end">{"70+" if v==70 else v}</text>')
        s.append(f'<line x1="{X(1):.1f}" y1="{Y(1):.1f}" x2="{X(70):.1f}" y2="{Y(70):.1f}" class="fair"/>')
        s.append(f'<text x="{X(68):.1f}" y="{Y(52):.1f}" class="lbl faint" text-anchor="end">Played worse than the roster ↓</text><text x="{X(48):.1f}" y="{Y(2)+10:.1f}" class="lbl faint" text-anchor="end">↑ Played better than the roster</text>')
        s.append(f'<text x="{(L+W-R)/2:.0f}" y="{Hh-8}" class="axis" text-anchor="middle">Roster talent, average national rank (best at left)</text>')
        s.append(f'<text transform="translate(14 {(T+Hh-B)/2:.0f}) rotate(-90)" class="axis" text-anchor="middle">Quality of play (SP+), average national rank (best at top)</text>')
        for x in sorted(tens,key=lambda x:x['sp']):
            hi=x['team']=='Texas A&M'
            s.append(f'<circle cx="{X(x["tal"]):.1f}" cy="{Y(x["sp"]):.1f}" r="{7 if hi else 6}" fill="{COLORS[x["team"]]}" class="dot"><title>{H.escape(x["coach"])}, {H.escape(x["team"])} {x["yrs"][0]}–{x["yrs"][-1]}: talent No. {x["tal"]:.0f}, SP+ No. {x["sp"]:.0f}, {x["st"]["w"]}-{x["st"]["l"]}</title></circle>')
            s.append(f'<text x="{X(x["tal"])+9:.1f}" y="{Y(x["sp"])+4:.1f}" class="tname{" hi" if hi else ""}" style="font-size:11px">{H.escape(x["last"])}</text>')
        s.append('</svg>'); return ''.join(s)

    def heat():
        yrs=YEARS; cw=(720-150-20)/len(yrs); L=150; W=720; rh=30; Hh=rh*len(TEAMS)+40
        s=[f'<svg viewBox="0 0 {W} {Hh}" class="chart" role="img" aria-label="Record against expectations by team and season">']
        for j,y in enumerate(yrs): s.append(f'<text x="{L+j*cw+cw/2:.1f}" y="20" class="tick" text-anchor="middle">{y}</text>')
        for i,t in enumerate(order):
            y=30+i*rh; s.append(f'<text x="{L-10}" y="{y+19}" class="tname{" hi" if t=="Texas A&M" else ""}" text-anchor="end">{H.escape(t)}</text>')
            for j,yr in enumerate(yrs):
                st=stats(d[(d.team==t)&(d.season==yr)]); p=st['pct']; a=min(1,abs(p-50)/30)
                fill=f'rgba(80,0,0,{a:.2f})' if p>=50 else f'rgba(184,168,143,{a:.2f})'
                s.append(f'<rect x="{L+j*cw+2:.1f}" y="{y+2}" width="{cw-4:.1f}" height="{rh-4}" fill="{fill}" class="cell"><title>{H.escape(t)} {yr}: {rec(st)} vs expectations, {st["w"]}-{st["l"]} won-lost, beat by {st["cm"]:+.1f} avg</title></rect>')
                s.append(f'<text x="{L+j*cw+cw/2:.1f}" y="{y+19}" class="cellt" style="font-size:{11 if len(yrs)>6 else 12}px" text-anchor="middle">{rec(st)}</text>')
        s.append('</svg>'); return ''.join(s)

    conf_rows=''.join(f"<tr{' class=hi' if t=='Texas A&M' else ''}><td>{H.escape(t)}</td><td>{tot[t]['w']}-{tot[t]['l']}</td><td>{rec(tot[t])}</td><td>{tot[t]['pct']:.0f}%</td><td>{tot[t]['cm']:+.1f}</td><td>{fav[t]['pct']:.0f}%</td><td>{dog[t]['pct']:.0f}%</td><td>{mvs[t]:+.2f}</td></tr>" for t in order)
    allst=stats(d); am=tot['Texas A&M']; rank=order.index('Texas A&M')+1; xrank=xorder.index('Texas A&M')+1
    mrank=morder.index('Texas A&M')+1; lrank=lorder.index('Texas A&M')+1; drank=dorder.index('Texas A&M')+1; trank=torder.index('Texas A&M')+1
    xw_rows=''.join(f"<tr{' class=hi' if t=='Texas A&M' else ''}><td>{H.escape(t)}</td><td>{tot[t]['w']}-{tot[t]['l']}</td><td>{xrec(tot[t])}</td><td>{dw(tot[t]):+.1f}</td><td>{tot[t]['fw']}-{tot[t]['fl']}</td><td>{tot[t]['uw']}-{tot[t]['ul']}</td></tr>" for t in xorder)
    trend_rows=''.join(f"<tr{' class=hi' if t=='Texas A&M' else ''}><td>{H.escape(t)}</td><td>{trd[t][2][THIRDS[0]]['cm']:+.1f}</td><td>{trd[t][2][THIRDS[1]]['cm']:+.1f}</td><td>{trd[t][2][THIRDS[2]]['cm']:+.1f}</td><td>{trd[t][0]:+.1f}</td><td>{trd[t][2][THIRDS[0]]['w']}-{trd[t][2][THIRDS[0]]['l']}</td><td>{trd[t][2][THIRDS[2]]['w']}-{trd[t][2][THIRDS[2]]['l']}</td></tr>" for t in torder)
    LONG=[x for x in ALLTEN if len(x['yrs'])>=2]; LONG.sort(key=lambda x:gap(x) if pd.notna(gap(x)) else -99,reverse=True)

    # first-year coaches league-wide
    def first_year_split():
        if not HAS_S or 'coach_tenure_year' not in S or S.coach_tenure_year.isna().all(): return None
        ts=[]
        for (t,yr),grp in S[S.team.isin(TEAMS)].groupby(['team','season']):
            g=d[(d.team==t)&(d.season==yr)]
            if not len(g) or pd.isna(grp.iloc[0].coach_tenure_year): continue
            st=stats(g); ts.append(dict(team=t,season=yr,ty=grp.iloc[0].coach_tenure_year,dw=dw(st),mg=mgap(st),lk=luck(st),dev=grp.iloc[0].talent_rank-grp.iloc[0].sp_rank))
        ts=pd.DataFrame(ts); a=ts[ts.ty==1]; b=ts[ts.ty>1]
        if len(a)<3 or len(b)<3: return None
        def cmp(col):
            diff=a[col].mean()-b[col].mean(); se=math.sqrt(a[col].var()/len(a)+b[col].var()/len(b)); return a[col].mean(),b[col].mean(),diff,se
        return dict(n1=len(a),n2=len(b),dw=cmp('dw'),mg=cmp('mg'),lk=cmp('lk'),dev=cmp('dev'))
    FY=first_year_split()

    def _axis(st):
        mg=mgap(st); lk=luck(st); zm=abs(mg)/st['se_mg']; zl=abs(lk)/st['se_lk']
        a=('overrated' if mg>0 else 'underrated') if zm>=2 else ('leaning overrated' if mg>0 else 'leaning underrated') if zm>=1 else 'expected about right'
        b=('lucky' if lk>0 else 'unlucky') if zl>=2 else ('a little lucky' if lk>0 else 'a little unlucky') if zl>=1 else 'neither lucky nor unlucky'
        return f"{a}, {b}"
    def _names(ts): return ', '.join(H.escape(t) for t in ts) if ts else 'no team'
    def take_quad():
        mo,mu,lo,lu=morder[0],morder[-1],lorder[0],lorder[-1]; a=tot['Texas A&M']
        sem=np.mean([tot[t]['se_mg'] for t in TEAMS]); sel=np.mean([tot[t]['se_lk'] for t in TEAMS])
        clear=[t for t in TEAMS if abs(mgap(tot[t]))>=2*tot[t]['se_mg'] or abs(luck(tot[t]))>=2*tot[t]['se_lk']]
        sugg=[t for t in TEAMS if t not in clear and (abs(mgap(tot[t]))>=tot[t]['se_mg'] or abs(luck(tot[t]))>=tot[t]['se_lk'])]
        return take(f'By this measure {H.escape(mo)} is the most overrated program {'in the league' if KEY=='sec' else 'on this site'} ({mgap(tot[mo]):+.1f} wins) and {H.escape(mu)} the most underrated ({mgap(tot[mu]):+.1f}). '
                    f'{H.escape(lo)} has won the most beyond what its play deserved ({luck(tot[lo]):+.1f}) and {H.escape(lu)} the least ({luck(tot[lu]):+.1f}). '
                    f'Texas A&amp;M sits at {mgap(a):+.1f} on the expectation axis and {luck(a):+.1f} on the luck axis: {_axis(a)}. The {'league' if KEY=='sec' else 'field'} as a whole clusters near the middle; the corners are a handful of programs.',
                    f'One standard error is about &plusmn;{sem:.1f} wins up and down and &plusmn;{sel:.1f} left and right. Beyond two standard errors on either axis: {_names(clear)}. Between one and two: {_names(sugg)}. Everyone else is inside the noise, and the luck axis in particular needs many seasons to say much.')
    def take_dev():
        pos=[t for t in dorder if dev[t]-LG_DEV>=5]; neg=[t for t in dorder if dev[t]-LG_DEV<=-5]; a=dev['Texas A&M']
        return take(f'The {"league" if KEY=="sec" else "field"} average is {LG_DEV:+.0f} spots: the talent composite rates elite rosters higher than they play, so the fair baseline is the peer group, not zero. '
                    f'Clearly above that baseline: {_names(pos)}. Clearly below it: {_names(neg)}. Texas A&amp;M at {a:+.0f} is {"even with" if abs(a-LG_DEV)<1 else f"{a-LG_DEV:+.0f} against"} the {"league" if KEY=="sec" else "field"} average, {"typical of the group" if abs(a-LG_DEV)<5 else "outside the pack"}.',
                    f'{NSEAS} seasons of rank averages carry roughly &plusmn;{RK_SE:.0f} spots of noise, so gaps inside that are not worth arguing about. Gaps of 15 or more against the league average are well outside it.')
    def take_coach_lg():
        tens=[x for x in LONG if len(x['yrs'])>=3 and pd.notna(gap(x))]
        if len(tens)<4: return ''
        best=tens[:3]; worst=tens[-3:]
        def lst(xs): return ', '.join(f"{H.escape(x['last'])} at {H.escape(x['team'])} ({gap(x):+.0f})" for x in xs)
        fy=''
        if FY:
            m1,m2,df,se=FY['dw']; g1,g2,dg,seg=FY['mg']; v1,v2,dv,sev=FY['dev']
            fy=(f" First-year head coaches ({FY['n1']} debut seasons) have finished {m1:+.1f} wins a season against expectations, versus {m2:+.1f} for everyone else; the public has {'over' if g1>g2 else 'under'}rated them relative to established coaches by {abs(dg):.1f} wins a season, and their rosters played {'better' if dv>0 else 'worse'} relative to talent by {abs(dv):.0f} spots.")
        return take(f"Among tenures of three or more seasons, the most out of a roster: {lst(best)}. The least: {lst(worst)}. The {'league' if KEY=='sec' else 'field'} average is {LG_DEV:+.0f}, so read every tenure against that.{fy}",
                    (f"Three-season tenures are about 38 games: roughly &plusmn;{SDG*math.sqrt(38):.1f} wins on the expectation gap, &plusmn;{math.sqrt(38*0.16):.1f} on luck, and &plusmn;7 spots on a rank average. "+
                     (f"On the first-year split, one standard error is about &plusmn;{FY['dw'][3]:.1f} wins a season on the results gap ({sig(FY['dw'][2],FY['dw'][3])}), &plusmn;{FY['mg'][3]:.1f} on the expectation gap ({sig(FY['mg'][2],FY['mg'][3])}), and &plusmn;{FY['dev'][3]:.0f} spots on the roster gap ({sig(FY['dev'][2],FY['dev'][3])})." if FY else "")))
    def take_xw():
        se=np.mean([tot[t]['se_lk'] for t in TEAMS]); clear=[t for t in TEAMS if abs(dw(tot[t]))>=2*se]
        return take(f'{H.escape(xorder[0])} and {H.escape(xorder[1])} have beaten expectations by the most ({dw(tot[xorder[0]]):+.1f}, {dw(tot[xorder[1]]):+.1f}); {H.escape(xorder[-1])} and {H.escape(xorder[-2])} have fallen furthest short ({dw(tot[xorder[-1]]):+.1f}, {dw(tot[xorder[-2]]):+.1f}). Texas A&amp;M is {dw(tot["Texas A&M"]):+.1f}, {xrank} of {len(TEAMS)}. This number mixes the first two questions together; the quadrant chart above is the one that separates them.',
                    f'One standard error is about &plusmn;{se:.1f} wins, so only {_names(clear)} {"is" if len(clear)==1 else "are"} clearly outside the noise.')
    def take_trend_lg():
        clear=[t for t in torder if abs(trd[t][0])>=2*trd[t][1]]; sugg=[t for t in torder if t not in clear and abs(trd[t][0])>=trd[t][1]]
        e,l=lg_th[THIRDS[0]],lg_th[THIRDS[2]]; ne,nl=lg_nc[THIRDS[0]],lg_nc[THIRDS[2]]; a=trd['Texas A&M']
        return take(f'{H.escape(torder[0])} ({trd[torder[0]][0]:+.1f} points a game) and {H.escape(torder[1])} ({trd[torder[1]][0]:+.1f}) finish seasons strongest relative to expectations; {H.escape(torder[-1])} ({trd[torder[-1]][0]:+.1f}) and {H.escape(torder[-2])} ({trd[torder[-2]][0]:+.1f}) fade the most. Texas A&amp;M is {a[0]:+.1f}, {trank} of {len(TEAMS)}. '
                    f'{'League-wide the pattern is flat' if KEY=='sec' else 'Across the whole field the averages are close to flat'} ({e["cm"]:+.1f} early, {l["cm"]:+.1f} late){', as it must be when conference games count for both sides' if KEY=='sec' else ''}; in non-conference games alone {'the SEC' if KEY=='sec' else 'these programs'} beat expectations by {ne["cm"]:+.1f} a game early and {nl["cm"]:+.1f} late.',
                    f'One standard error on a team\'s early-versus-late difference is about &plusmn;{np.mean([trd[t][1] for t in TEAMS]):.1f} points a game. Beyond two: {_names(clear)}. Between one and two: {_names(sugg)}. The rest is noise; single games swing by 20 points routinely.')
    def take_ats():
        clear=[t for t in TEAMS if abs(tot[t]['pct']-50)>=2*tot[t]['se_pct']]
        return take(f'Over {NSEAS} seasons there is no {'SEC team' if KEY=='sec' else 'program here'} whose expected margins are reliably off. The most optimistic the public has been about any program is {abs(tot[order[-1]]["cm"]):.1f} points a game ({H.escape(order[-1])}), the most pessimistic {tot[order[0]]["cm"]:.1f} ({H.escape(order[0])}), and the whole {'league' if KEY=='sec' else 'field'} spans about {sd*2:.0f} points. That is what you would expect when the number is set by people with money on it.',
                    f'With about {AVGN:.0f} games per team, one standard error on a beat-expectations rate is roughly &plusmn;{100*math.sqrt(0.25/AVGN):.0f} points. Outside two standard errors: {_names(clear)}.')

    coach_section=(f'''<h2>Coaches and their rosters</h2>
    <p>Every head-coaching tenure of three or more seasons in the window, as one dot: the roster's average talent rank against the play's average SP+ rank. Above the diagonal, the coach got more out of the roster than its recruiting rankings promised; below, less. The table lists every tenure of two or more seasons. Tenure years count seasons before the window and 2020.</p>
    {coachplot()}
    {coach_table(LONG,show_team=True)}
    {take_coach_lg()}''' if HAS_S and LONG else '')

    conf=f'''<section class="team" id="sec" style="--accent:{MAROON}">
    <h1>{TITLE}</h1>
    <p class="sub">{SUB} {len(d[d.team.isin(TEAMS)]):,} team-games over {NSEAS} seasons, every one with an expected margin.{" 2020 is left out as an anomaly: ten conference games, no non-conference schedule." if YMIN<2020<YMAX else ""}</p>
    <div class="big"><div><b>{am['w']}-{am['l']}</b><span>Texas A&amp;M won-lost</span></div><div><b>{mgap(am):+.1f}</b><span>expected minus deserved wins, {mrank} of {len(TEAMS)}</span></div><div><b>{luck(am):+.1f}</b><span>won minus deserved wins, {lrank} of {len(TEAMS)}</span></div><div><b>{fr(dev['Texas A&M'],'{:+.0f}')}</b><span>talent rank minus SP+ rank, {drank} of {len(TEAMS)}</span></div></div>
    {INTRO}
    {GLOSS}
    <h2>Overrated, underrated, lucky, unlucky</h2>
    <p>Up and down is what the public expected minus what the play deserved: up is overrated. Left and right is actual wins minus deserved wins: right is overperforming, usually close games and turnover luck. {NSEAS}-season totals. A team can be overrated and unlucky at the same time; that is the top-left corner.</p>
    {quad()}
    {take_quad()}
    <h2>Playing above or below the roster</h2>
    <p>Average talent-composite rank minus average SP+ rank across the {NSEAS} seasons. Positive means the program has played better than its recruiting rankings would predict; negative means the roster has been better than the play. Ranks are among all FBS programs.</p>
    {devplot() if HAS_S else ''}
    <div class="wrap"><table><tr><th>Team</th><th>Talent rank</th><th>SP+ rank</th><th>Talent&minus;SP+</th><th>Record</th><th>Deserved</th><th>Expected</th><th>Won vs deserved</th><th>Expected vs deserved</th></tr>{ctx_rows}</table></div>
    {take_dev()}
    {coach_section}
    <h2>Wins versus expectation</h2>
    <p>Actual wins minus the wins the public expected, {NSEAS}-season totals. Positive means the program won more often than expected. This mixes the first two questions together; the quadrant chart above pulls them apart.</p>
    {xwplot()}
    <div class="wrap"><table><tr><th>Team</th><th>Record</th><th>Expected</th><th>Won vs expected</th><th>When expected to win</th><th>When expected to lose</th></tr>{xw_rows}</table></div>
    {take_xw()}
    <h2>Early season versus late season</h2>
    <p>How many points a game each program beat expectations by, or fell short, in the last stretch of its seasons (game 9 on, postseason included) minus the first four games. Positive means the team finished seasons stronger than the public expected; negative means it faded. Because the expected margin already moves week to week, this measures how slow opinion was to adjust.</p>
    {trendplot()}
    <div class="wrap"><table><tr><th>Team</th><th>Early</th><th>Middle</th><th>Late</th><th>Late &minus; early</th><th>Early record</th><th>Late record</th></tr>{trend_rows}</table></div>
    {take_trend_lg()}
    <h2>Appendix: against expectations</h2>
    <p>For readers who follow the point spreads.</p>
    <div class="big"><div><b>{allst['pct']:.1f}%</b><span>league-wide rate of beating expectations</span></div><div><b>{am['pct']:.0f}%</b><span>Texas A&amp;M rate</span></div><div><b>{rank} of {len(TEAMS)}</b><span>A&amp;M rank by beat-by average</span></div></div>
    <h3>Beat expectations by, on average</h3>
    <p>Positive means the program beat its expected margin on average; negative means the public was consistently too optimistic about it.</p>
    {dotplot()}
    {take_ats()}
    <h3>When expected to win, when expected to lose</h3>
    <p>Filled dot is the rate of beating expectations when the team was expected to win, open circle when it was expected to lose. A team far to the left on the filled dot but to the right on the open one is a program the public overbuys when it is supposed to win.</p>
    {favdog()}
    <h3>Season by season</h3>
    <p>Record against expectations per team-season. Maroon shading is above 50%, tan is below; deeper color is further from even.</p>
    {heat()}
    <h3>{'All sixteen' if KEY=='sec' else 'All '+str(len(TEAMS))}</h3>
    <p>Opinion shift is the average change from the week-earlier number to the kickoff number, from the team's perspective; negative means the public leaned further toward the team during the week. Not every game has a week-earlier number on file.</p>
    <div class="wrap"><table><tr><th>Team</th><th>Won-lost</th><th>Vs expectations</th><th>Beat %</th><th>Beat by, avg</th><th>Beat % when expected to win</th><th>Beat % when expected to lose</th><th>Opinion shift</th></tr>{conf_rows}</table></div>
    <p class="note">Data: CollegeFootballData.com games, lines, ratings, talent, recruiting, rankings and coaches endpoints, kickoff point spread from consensus or DraftKings where available. Expected margins are from the listed team's side. Beat by = actual margin minus expected margin. Conference games appear once for each side, so the league-wide beat-by average nets to roughly zero by construction; per-team numbers are unaffected. Expected wins convert each expected margin to a win probability with a normal model (standard deviation {SIG:.1f} points, fitted to this data) and sum them. Deserved wins sum CFBD's postgame win probability per game; where CFBD has no play-by-play for a game ({int(d.post_wp.isna().sum())} of {len(d)}), the expected-margin probability stands in.{" The 2020 season is excluded from every number except head-coach tenure years." if YMIN<2020<YMAX else ""}</p>
    <p class="more"><a href="{BASE}texas-am/">Texas A&amp;M's page</a>{' · <a href="'+BASE+'national/">Compare across the SEC and the national field</a>' if KEY=='sec' else ' · <a href="'+BASE+'sec/">The SEC alone</a>'}</p>
    </section>'''

    return conf

# ---------- page shell, one file per section
CSS=f'''
:root{{box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);
--bg:#f7f5f2;--ink:#1c1a1a;--mute:#6b6360;--rule:#dcd6d0;--nocover:#b8a88f;--push:#8e8e8e;--panel:#ffffff}}
section.team{{--head:var(--accent)}}
@media (prefers-color-scheme:dark){{:root:not([data-theme="light"]){{--bg:#171414;--ink:#f1ecea;--mute:#a59d99;--rule:#332c2c;--nocover:#5e5750;--push:#7a7a7a;--panel:#211c1c}} :root:not([data-theme="light"]) section.team{{--head:color-mix(in srgb,var(--accent) 55%,#fff)}}}}
:root[data-theme="dark"]{{--bg:#171414;--ink:#f1ecea;--mute:#a59d99;--rule:#332c2c;--nocover:#5e5750;--push:#7a7a7a;--panel:#211c1c}} :root[data-theme="dark"] section.team{{--head:color-mix(in srgb,var(--accent) 55%,#fff)}}
html{{scroll-padding-top:env(safe-area-inset-top,0px)}}
body{{margin:0;background:var(--bg);color:var(--ink);font-family:Barlow,"Helvetica Neue",Arial,sans-serif;line-height:1.5}}
main{{max-width:760px;margin:0 auto;padding:20px 18px 60px}}
nav{{position:sticky;top:env(safe-area-inset-top,0px);background:var(--bg);padding:10px 0 12px;border-bottom:1px solid var(--rule);margin-bottom:22px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;z-index:2}}
nav .brand{{font-family:"Barlow Condensed","Arial Narrow",Arial,sans-serif;font-weight:700;font-size:20px;letter-spacing:.01em;margin-right:auto;color:inherit;text-decoration:none}}
nav label{{color:var(--mute);font-size:14px}}
select{{font:inherit;font-size:16px;padding:6px 10px;background:var(--panel);color:var(--ink);border:1px solid var(--rule);border-radius:4px}}
select:focus{{outline:2px solid var(--accent,{MAROON});outline-offset:1px}}
h1{{font-family:"Barlow Condensed","Arial Narrow",Arial,sans-serif;font-weight:700;font-size:clamp(38px,8vw,64px);line-height:.95;margin:0 0 6px;letter-spacing:-.01em;color:var(--head)}}
h2{{font-family:"Barlow Condensed","Arial Narrow",Arial,sans-serif;font-weight:700;font-size:26px;margin:44px 0 4px;color:var(--head)}}
h3{{font-family:"Barlow Condensed","Arial Narrow",Arial,sans-serif;font-weight:700;font-size:19px;margin:24px 0 0}}
.sub{{color:var(--mute);margin:0 0 26px;max-width:60ch}} p{{max-width:64ch}} .mute{{color:var(--mute);font-weight:400}}
.big{{display:flex;gap:20px;flex-wrap:wrap;margin:10px 0 6px;border-top:2px solid var(--accent);padding-top:12px}}
.big div{{min-width:110px;max-width:130px}} .big b{{font-family:"Barlow Condensed",Arial,sans-serif;font-size:44px;line-height:1;display:block}} .big span{{color:var(--mute);font-size:14px}}
.intro{{border:1px solid var(--rule);background:var(--panel);padding:4px 16px;margin:22px 0 10px}} .intro p{{max-width:none}}
.gloss{{font-size:14px;color:var(--mute);margin:0 0 8px}} .gloss summary{{cursor:pointer;font-weight:600;color:var(--ink)}} .gloss dl{{margin:6px 0 0}} .gloss dt{{font-weight:600;color:var(--ink);margin-top:8px}} .gloss dd{{margin:0}}
.take{{border-left:3px solid var(--accent);background:var(--panel);padding:10px 14px;margin:16px 0 0}} .take p{{max-width:none;margin:0}} .take b{{font-family:"Barlow Condensed",Arial,sans-serif;font-size:17px;letter-spacing:.01em}}
.take details{{margin-top:8px;font-size:14px;color:var(--mute)}} .take summary{{cursor:pointer;font-weight:600;color:var(--ink);font-size:14px}} .take details p{{margin-top:4px}}
.take.bottom{{border-left-width:6px;margin-top:22px}}
.chart{{width:100%;height:auto;display:block;background:var(--panel);border:1px solid var(--rule);padding:8px;box-sizing:border-box}}
.grid{{stroke:var(--rule);stroke-width:1}} .zero{{stroke:var(--mute);stroke-width:1.2}} .stem{{stroke:var(--rule);stroke-width:2}}
.fair{{stroke:var(--ink);stroke-width:1.5;stroke-dasharray:6 5}}
.tick,.lbl,.axis,.oppl,.seasonstat,.tname,.cellt{{font-family:Barlow,Arial,sans-serif;fill:var(--mute);font-size:12px}}
.lbl{{fill:var(--ink);font-weight:600}} .lbl.faint{{fill:var(--mute);font-weight:400}} .axis{{font-size:13px}} .oppl{{font-size:10.5px}}
.tname{{fill:var(--ink);font-size:14px}} .tname.hi{{font-weight:600}} .cellt{{fill:var(--ink);font-size:12px}}
.seasonlbl{{font-family:"Barlow Condensed",Arial,sans-serif;font-size:22px;font-weight:700;fill:var(--ink)}}
.pt{{stroke:var(--panel);stroke-width:1.2}} .pt.cover,.bar.cover{{fill:var(--accent)}} .pt.nocover,.bar.nocover{{fill:var(--nocover)}} .pt.push,.bar.push{{fill:var(--push)}}
.key{{display:flex;gap:18px;flex-wrap:wrap;font-size:13px;color:var(--mute);margin:8px 0 0}} .key i{{display:inline-block;width:12px;height:12px;border-radius:50%;vertical-align:-1px;margin-right:6px}}
.key i.open{{background:transparent;border:2px solid var(--accent);box-sizing:border-box}} .key i.sq{{border-radius:0;opacity:.5}}
table{{width:100%;border-collapse:collapse;font-size:15px;margin-top:10px}} th,td{{text-align:right;padding:8px 6px;border-bottom:1px solid var(--rule);white-space:nowrap}} th:first-child,td:first-child{{text-align:left}}
th{{font-weight:600;color:var(--mute)}} tr.hi td{{font-weight:600;background:rgba(80,0,0,.06)}} .wrap{{overflow-x:auto}}
.note{{font-size:14px;color:var(--mute);border-left:3px solid var(--nocover);padding-left:12px;margin-top:28px}}
.more{{margin-top:36px;font-weight:600}} a{{color:inherit}}
@media (prefers-reduced-motion:no-preference){{.pt{{transition:r .15s}} .pt:hover{{r:8.5}}}}
'''
SLUGS=['sec','national']+[slug(t) for t in ALLTEAMS]
def shell(title,body,current):
    opt=lambda s_,lab: f'<option value="{s_}"{" selected" if s_==current else ""}>{lab}</option>'
    o=('<optgroup label="Comparisons">'+opt('sec','The SEC (all sixteen)')+opt('national','SEC + national field')+'</optgroup>'
       '<optgroup label="SEC">'+''.join(opt(slug(t),H.escape(t)) for t in SEC)+'</optgroup>'
       '<optgroup label="National comparison">'+''.join(opt(slug(t),H.escape(t)) for t in EXTRA)+'</optgroup>')
    return f'''<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{H.escape(title)} · College football {SPAN}: expectations, luck, and talent</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;700&family=Barlow:wght@400;600&display=swap">
<style>{CSS}</style></head><body><main>
<nav><a class="brand" href="{BASE}">College football, {SPAN}</a><label for="pick">Team</label><select id="pick">{o}</select></nav>
{body}
</main>
<script>
(function(){{var B='{BASE}',K={SLUGS!r};var sel=document.getElementById('pick');
sel.addEventListener('change',function(){{location.href=B+sel.value+'/'}});
var h=location.hash.slice(1);if(h&&K.indexOf(h)>=0&&sel.value!==h){{location.replace(B+h+'/')}}}})();
</script></body></html>'''

OUT='out'
if os.path.isdir(OUT): shutil.rmtree(OUT)
os.makedirs(OUT)
INTRO_NAT=INTRO_SEC.replace('all sixteen programs at once','the sixteen SEC programs and '+str(len(EXTRA))+' of the country\'s elite at once')
pages={'sec':('The SEC',build_league('sec','The SEC',"Sixteen current SEC programs. Texas and Oklahoma's Big 12 seasons are included so each program has the same window.",INTRO_SEC,SEC)),
       'national':('SEC and the national field',build_league('national','The SEC and the national field',f"The sixteen SEC programs plus {', '.join(EXTRA[:-1])} and {EXTRA[-1]}: every recent national champion and every program whose average final AP ranking over the window sits inside the top 12.",INTRO_NAT,ALLTEAMS))}
for t in ALLTEAMS: pages[slug(t)]=(t,team_section(t))
total=0; largest=0
for s,(title,body) in pages.items():
    html_=shell(title,body,s); os.makedirs(os.path.join(OUT,s),exist_ok=True)
    open(os.path.join(OUT,s,'index.html'),'w',encoding='utf-8').write(html_); total+=len(html_); largest=max(largest,len(html_))
    if s=='texas-am': open(os.path.join(OUT,'index.html'),'w',encoding='utf-8').write(html_)
print(f'{len(pages)+1} files, {total//1024} KB total, largest {largest//1024} KB')
print(pd.DataFrame({t:tot[t] for t in order}).T[['n','c','nc','p','pct','cm']].round(1).to_string())
print('games file:',GAMES,'| seasons:',YEARS,'| season file:',SFILE,'| post_wp missing:',int(d.post_wp.isna().sum()),'| tenures:',len(ALLTEN))
print('sigma',round(SIG,2),'A&M W/xW',tot['Texas A&M']['w'],round(tot['Texas A&M']['xw'],1),'| LG_DEV',round(LG_DEV,1),'| first-year split:',FY and (FY['n1'],FY['n2']))
