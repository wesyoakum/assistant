"""
Build the SEC against-the-spread page.
    pip install pandas numpy
    python build_cfbanalysis.py      (reads sec_games_2021_2025.csv, writes cfbanalysis.html)
Rename/copy cfbanalysis.html to public/cfbanalysis/index.html in the web app.
"""
import pandas as pd, numpy as np, html as H, math, os
d=pd.read_csv('sec_games_2021_2025.csv',encoding='latin-1')
d['res']=np.where(d.cover_margin>0,'Cover',np.where(d.cover_margin<0,'No Cover','Push'))
d['fav']=np.where(d.close_spread<0,'Favorite',np.where(d.close_spread>0,'Underdog','Pick'))
d['move']=d.close_spread-d.open_spread  # negative = line moved toward team (team became bigger fav)
d['su']=np.where(d.actual_margin>0,'W','L')
SIG=d.cover_margin.std()  # observed std dev of (actual margin - spread); ~15 points in this data
d['p']=[0.5*(1+math.erf(-sp/(SIG*math.sqrt(2)))) for sp in d.close_spread]  # spread-implied pre-game win probability
for c in ['post_wp','to_margin','pre_elo']:
    if c not in d: d[c]=np.nan
d['sow']=d.post_wp.fillna(d.p)   # deserved-win credit per game: CFBD postgame win probability, spread-implied p where CFBD has none
d['onescore']=d.actual_margin.abs()<=8
SFILE='sec_seasons_2021_2025.csv'; HAS_S=os.path.exists(SFILE)
S=pd.read_csv(SFILE) if HAS_S else pd.DataFrame(columns=['season','team'])
def srow(t,yr):
    r=S[(S.team==t)&(S.season==yr)]
    return r.iloc[0] if len(r) else pd.Series(dtype=float)
def fr(v,fmt='{:.0f}',dash='–'):
    try:
        return dash if v is None or pd.isna(v) else fmt.format(v)
    except Exception: return dash
COLORS={"Alabama":"#9E1B32","Arkansas":"#9D2235","Auburn":"#0C2340","Florida":"#0021A5","Georgia":"#BA0C2F","Kentucky":"#0033A0","LSU":"#461D7C","Mississippi State":"#5D1725","Missouri":"#F1B82D","Oklahoma":"#841617","Ole Miss":"#14213D","South Carolina":"#73000A","Tennessee":"#FF8200","Texas":"#BF5700","Texas A&M":"#500000","Vanderbilt":"#866D4B"}
TEAMS=sorted(COLORS)
def slug(t): return t.lower().replace(' ','-').replace('&','')
def stats(g):
    n=len(g); c=(g.res=='Cover').sum(); nc=(g.res=='No Cover').sum(); p=(g.res=='Push').sum()
    fv=g[g.fav=='Favorite']; ud=g[g.fav=='Underdog']
    return dict(n=n,c=c,nc=nc,p=p,pct=(c+0.5*p)/n*100 if n else np.nan,cm=g.cover_margin.mean() if n else np.nan,
                w=(g.su=='W').sum(),l=(g.su=='L').sum(),xw=g.p.sum() if n else np.nan,
                fw=(fv.su=='W').sum(),fl=(fv.su=='L').sum(),uw=(ud.su=='W').sum(),ul=(ud.su=='L').sum(),
                sow=g.sow.sum() if n else np.nan,wp_missing=g.post_wp.isna().sum(),
                osw=((g.onescore)&(g.su=='W')).sum(),osl=((g.onescore)&(g.su=='L')).sum(),
                tom=g.to_margin.sum() if g.to_margin.notna().any() else np.nan)
def rec(s): return f"{s['c']}-{s['nc']}-{s['p']}"
def xrec(s): return f"{s['xw']:.1f}-{s['n']-s['xw']:.1f}"
def dw(s): return round(s['w']-s['xw'],1)+0.0
def luck(s): return round(s['w']-s['sow'],1)+0.0
def mgap(s): return round(s['xw']-s['sow'],1)+0.0

# ---------- charts
def scatter(g,color):
    W,Hh=720,540; L,R,T,B=56,20,20,48
    xmin,xmax=-60,40; ymin,ymax=-45,65
    X=lambda v:L+(v-xmin)/(xmax-xmin)*(W-L-R); Y=lambda v:T+(ymax-v)/(ymax-ymin)*(Hh-T-B)
    s=[f'<svg viewBox="0 0 {W} {Hh}" class="chart" role="img" aria-label="Expected margin versus actual margin">']
    for v in range(-60,41,10): s.append(f'<line x1="{X(v):.1f}" y1="{T}" x2="{X(v):.1f}" y2="{Hh-B}" class="grid"/><text x="{X(v):.1f}" y="{Hh-B+18}" class="tick" text-anchor="middle">{v:+d}</text>')
    for v in range(-40,66,10): s.append(f'<line x1="{L}" y1="{Y(v):.1f}" x2="{W-R}" y2="{Y(v):.1f}" class="grid"/><text x="{L-8}" y="{Y(v)+4:.1f}" class="tick" text-anchor="end">{v:+d}</text>')
    s.append(f'<line x1="{X(xmin):.1f}" y1="{Y(0):.1f}" x2="{X(xmax):.1f}" y2="{Y(0):.1f}" class="zero"/>')
    s.append(f'<line x1="{X(-60):.1f}" y1="{Y(60):.1f}" x2="{X(40):.1f}" y2="{Y(-40):.1f}" class="fair"/>')
    s.append(f'<text x="{X(-57):.1f}" y="{Y(58)-6:.1f}" class="lbl">Books exactly right</text>')
    s.append(f'<text x="{X(-45):.1f}" y="{Y(50):.1f}" class="lbl faint">Beat the number ↑</text><text x="{X(14):.1f}" y="{Y(-36):.1f}" class="lbl faint">↓ Fell short</text>')
    s.append(f'<text x="{(L+W-R)/2:.0f}" y="{Hh-8}" class="axis" text-anchor="middle">Closing line (negative = favored by that much)</text>')
    s.append(f'<text transform="translate(14 {(T+Hh-B)/2:.0f}) rotate(-90)" class="axis" text-anchor="middle">Actual margin</text>')
    for _,r in g.iterrows():
        cls={'Cover':'cover','No Cover':'nocover','Push':'push'}[r.res]
        loc={'H':'vs','A':'at','N':'vs (N)'}[r.site]
        tip=f"{r.season} {loc} {r.opponent}: {r.su} {r.team_pts}-{r.opp_pts}, line {r.close_spread:+g}, beat by {r.cover_margin:+g}"
        s.append(f'<circle cx="{X(r.close_spread):.1f}" cy="{Y(r.actual_margin):.1f}" r="5.5" class="pt {cls}"><title>{H.escape(tip)}</title></circle>')
    s.append('</svg>'); return ''.join(s)

def strip(g):
    W=720; rowh=118; seasons=sorted(g.season.unique()); Hh=rowh*len(seasons)+10
    s=[f'<svg viewBox="0 0 {W} {Hh}" class="chart" role="img" aria-label="Cover margin by game">']
    for i,yr in enumerate(seasons):
        y0=i*rowh+10; base=y0+62; rs=g[g.season==yr]; st=stats(rs)
        s.append(f'<text x="0" y="{y0+14}" class="seasonlbl">{yr}</text>')
        s.append(f'<text x="{W}" y="{y0+14}" class="seasonstat" text-anchor="end">{rec(st)} vs the number · {st["w"]}-{st["l"]} won-lost · beat by {st["cm"]:+.1f} avg</text>')
        s.append(f'<line x1="70" y1="{base}" x2="{W-10}" y2="{base}" class="zero"/>')
        gap=(W-90)/max(len(rs),14)
        for j,(_,r) in enumerate(rs.iterrows()):
            x=80+j*gap+gap/2; yv=base-(max(-40,min(40,r.cover_margin))/40)*40
            cls={'Cover':'cover','No Cover':'nocover','Push':'push'}[r.res]
            tip=f"{r.opponent} ({ {'H':'home','A':'away','N':'neutral'}[r.site]}): {r.su} {r.team_pts}-{r.opp_pts}, line {r.close_spread:+g}, beat by {r.cover_margin:+g}"
            s.append(f'<rect x="{x-6:.1f}" y="{min(base,yv):.1f}" width="12" height="{abs(base-yv):.1f}" class="bar {cls}"><title>{H.escape(tip)}</title></rect>')
            nm=r.opponent.replace('Mississippi State','Miss St').replace('South Carolina','S Carolina').replace(' State',' St').replace('Appalachian','App')
            s.append(f'<text x="{x:.1f}" y="{base+50}" class="oppl" text-anchor="middle" transform="rotate(-38 {x:.1f} {base+50})">{H.escape(nm[:16])}</text>')
    s.append('</svg>'); return ''.join(s)

def xwchart(g,color):
    seasons=sorted(g.season.unique()); W,rh=720,34; L,R=70,170; Hh=rh*len(seasons)+50
    xmin,xmax=0,15; X=lambda v:L+(v-xmin)/(xmax-xmin)*(W-L-R)
    s=[f'<svg viewBox="0 0 {W} {Hh}" class="chart" role="img" aria-label="Actual versus expected wins by season">']
    for v in range(0,16,3): s.append(f'<line x1="{X(v):.1f}" y1="10" x2="{X(v):.1f}" y2="{Hh-30}" class="grid"/><text x="{X(v):.1f}" y="{Hh-12}" class="tick" text-anchor="middle">{v}</text>')
    for i,yr in enumerate(seasons):
        y=22+i*rh; st=stats(g[g.season==yr]); a=st['w']; e=st['xw']
        s.append(f'<text x="{L-10}" y="{y+5}" class="tname" text-anchor="end">{yr}</text>')
        s.append(f'<line x1="{X(e):.1f}" y1="{y}" x2="{X(a):.1f}" y2="{y}" class="stem"/>')
        s.append(f'<circle cx="{X(e):.1f}" cy="{y}" r="6" fill="none" stroke="{color}" stroke-width="2.5"><title>{yr} expected: {xrec(st)}</title></circle>')
        sw=st['sow']; s.append(f'<rect x="{X(sw)-5:.1f}" y="{y-5}" width="10" height="10" fill="{color}" opacity=".45"><title>{yr} deserved (second-order wins): {sw:.1f}</title></rect>')
        s.append(f'<circle cx="{X(a):.1f}" cy="{y}" r="6" fill="{color}"><title>{yr} actual: {a}-{st["l"]}</title></circle>')
        s.append(f'<text x="{W-R+14}" y="{y+4}" class="tick">{a}-{st["l"]}, {round(a-e,1)+0.0:+.1f} vs market, {round(a-sw,1)+0.0:+.1f} vs play</text>')
    s.append(f'<text x="{(L+W-R)/2:.0f}" y="{Hh-0}" class="axis" text-anchor="middle">Wins</text></svg>'); return ''.join(s)

def rankchart(t):
    ss=S[S.team==t].sort_values('season'); yrs=list(ss.season); W,Hh=720,300; L,R,T,B=56,20,20,40; YM=60
    X=lambda i:L+(i+0.5)/len(yrs)*(W-L-R); Y=lambda r:T+(min(r,YM)-1)/(YM-1)*(Hh-T-B)
    s=[f'<svg viewBox="0 0 {W} {Hh}" class="chart" role="img" aria-label="National rank by season: talent, SP+, preseason AP">']
    for r in [1,10,20,30,40,50,60]: s.append(f'<line x1="{L}" y1="{Y(r):.1f}" x2="{W-R}" y2="{Y(r):.1f}" class="grid"/><text x="{L-8}" y="{Y(r)+4:.1f}" class="tick" text-anchor="end">{"60+" if r==60 else r}</text>')
    for i,yr in enumerate(yrs): s.append(f'<text x="{X(i):.1f}" y="{Hh-B+20}" class="tick" text-anchor="middle">{yr}</text>')
    s.append(f'<text transform="translate(14 {(T+Hh-B)/2:.0f}) rotate(-90)" class="axis" text-anchor="middle">National rank</text>')
    for col,lab,stroke,dash in [('talent_rank','Talent composite','var(--accent)',''),('sp_rank','SP+','var(--ink)',''),('ap_pre','Preseason AP','var(--push)','6 4')]:
        if col not in ss: continue
        pts=[(i,v) for i,v in enumerate(ss[col]) if pd.notna(v)]
        runs=[];
        for i,v in pts:
            if runs and runs[-1][-1][0]==i-1: runs[-1].append((i,v))
            else: runs.append([(i,v)])
        for run in runs:
            if len(run)>1: s.append(f'<polyline points="{" ".join(f"{X(i):.1f},{Y(v):.1f}" for i,v in run)}" fill="none" stroke="{stroke}" stroke-width="2" stroke-dasharray="{dash}"/>')
        for i,v in pts: s.append(f'<circle cx="{X(i):.1f}" cy="{Y(v):.1f}" r="5" fill="{stroke}"><title>{yrs[i]} {lab}: No. {v:.0f}</title></circle>')
    s.append('</svg>'); return ''.join(s)

def ctx_table(t,g):
    rows=[]
    for yr in sorted(g.season.unique()):
        st=stats(g[g.season==yr]); r=srow(t,yr)
        rows.append(f"<tr><td>{yr}</td><td>{fr(r.get('talent_rank'))}</td><td>{fr(r.get('recruit_rank'))}</td><td>{fr(r.get('ap_pre'))}</td><td>{fr(r.get('sp_rank'))}</td><td>{fr(r.get('sp_off_rank'))}</td><td>{fr(r.get('sp_def_rank'))}</td><td>{st['w']}-{st['l']}</td><td>{st['sow']:.1f}</td><td>{st['xw']:.1f}</td><td>{st['osw']}-{st['osl']}</td><td>{fr(st['tom'],'{:+.0f}')}</td></tr>")
    return "<div class='wrap'><table><tr><th>Season</th><th>Talent</th><th>Recruiting</th><th>Pre AP</th><th>SP+</th><th>Off</th><th>Def</th><th>Record</th><th>Deserved W</th><th>Market W</th><th>One-score</th><th>TO margin</th></tr>"+''.join(rows)+"</table></div>"

def verdict(t,g,st):
    ss=S[S.team==t]; tal=ss.talent_rank.mean() if 'talent_rank' in ss and ss.talent_rank.notna().any() else np.nan
    sp=ss.sp_rank.mean() if 'sp_rank' in ss and ss.sp_rank.notna().any() else np.nan
    out=[]
    if pd.notna(tal) and pd.notna(sp):
        gap=tal-sp; out.append(f"Over five seasons {H.escape(t)} carried the No. {tal:.0f} roster by talent on average and finished No. {sp:.0f} in SP+, so it played {'above' if gap>0 else 'below'} its talent by about {abs(gap):.0f} spots.")
    lk=luck(st); mg=mgap(st)
    out.append(f"Its play deserved about {st['sow']:.1f} wins. It won {st['w']} ({lk:+.1f}, {'overperformed' if lk>=0 else 'underperformed'}) and the market priced it for {st['xw']:.1f} ({mg:+.1f}, {'overrated' if mg>=0 else 'underrated'} by the closing lines). One-score games: {st['osw']}-{st['osl']}.")
    return '<p>'+' '.join(out)+'</p>'

def surprises(g):
    def row(r):
        loc={'H':'vs','A':'at','N':'vs (N)'}[r.site]
        return f"<tr><td>{r.season} {loc} {H.escape(r.opponent)}</td><td>{r.su} {r.team_pts}-{r.opp_pts}</td><td>{r.close_spread:+g}</td><td>{r.p*100:.0f}%</td></tr>"
    hdr="<tr><th>Game</th><th>Result</th><th>Closing line</th><th>Chance to win</th></tr>"
    wins=''.join(row(r) for _,r in g[g.su=='W'].nsmallest(4,'p').iterrows())
    losses=''.join(row(r) for _,r in g[g.su=='L'].nlargest(4,'p').iterrows())
    return f"<h3>Unlikeliest wins</h3><div class='wrap'><table>{hdr}{wins}</table></div><h3>Most surprising losses</h3><div class='wrap'><table>{hdr}{losses}</table></div>"

def split_table(g):
    rows=[]
    for lab,sub in [('All games',g),('As favorite',g[g.fav=='Favorite']),('As underdog',g[g.fav=='Underdog']),
                    ('Favored by 14+',g[g.close_spread<=-14]),('Home',g[g.site=='H']),('Away',g[g.site=='A']),('Neutral',g[g.site=='N']),
                    ('Conference games',g[g.conf_game=='Y']),('Non-conference',g[g.conf_game=='N']),('Postseason',g[g.season_type=='postseason'])]:
        if len(sub)==0: continue
        st=stats(sub); rows.append(f"<tr><td>{lab}</td><td>{st['n']}</td><td>{st['w']}-{st['l']}</td><td>{rec(st)}</td><td>{st['pct']:.0f}%</td><td>{st['cm']:+.1f}</td></tr>")
    return "<div class='wrap'><table><tr><th>Split</th><th>Games</th><th>Won-lost</th><th>Vs the number</th><th>Beat %</th><th>Beat by, avg</th></tr>"+''.join(rows)+"</table></div>"

GLOSS='<details class="gloss"><summary>Terms used on this page</summary><dl><dt>Closing line</dt><dd>The sportsbooks\' final forecast of the margin, with everyone\'s money behind it. Negative means the team was favored by that many points. Used here as the best available measure of what everyone expected.</dd><dt>Expected wins</dt><dd>Each closing line converted to a chance of winning, then added up. The record the market thought was coming.</dd><dt>Deserved wins</dt><dd>Each game\'s postgame win probability, from CollegeFootballData\'s play-by-play model, added up. How many games a team that played that way usually wins. The gap between actual and deserved wins is what most people call luck.</dd><dt>SP+</dt><dd>Bill Connelly\'s efficiency rating of how well a team actually played, adjusted for opponent. Used here as the measure of quality, separate from the record.</dd><dt>Talent composite</dt><dd>247Sports\' rating of the whole roster\'s recruiting pedigree. Used here as the measure of what the players were supposed to be.</dd><dt>Beat the number</dt><dd>Finished with a better margin than the closing line; a bettor would say "covered". Beat by is margin plus line: +7 means seven points better than expected.</dd><dt>One-score game</dt><dd>Decided by eight points or fewer.</dd></dl></details>'
INTRO_TEAM='<div class="intro"><p>Every frustrating season comes down to one of three things. <b>The expectations were wrong:</b> the team was never as good as the polls, the lines, and the fans believed. <b>The bounces were wrong:</b> the team played well enough to win and didn\'t. <b>The development was wrong:</b> the players were there and the play wasn\'t. Each section below tests one of them. The numbers don\'t pick a winner. You do.</p></div>'
INTRO_SEC='<div class="intro"><p>Every frustrating season comes down to one of three things: the expectations were wrong, the bounces were wrong, or the development was wrong. This page asks those three questions of all sixteen programs at once, so you can see where yours sits. Each team also has its own page in the menu above.</p></div>'

def team_section(t):
    g=d[d.team==t].sort_values('date'); st=stats(g); col=COLORS[t]
    yrs=sorted(g.season.unique()); ys={yr:stats(g[g.season==yr]) for yr in yrs}
    t1=''.join(f"<tr><td>{yr}</td><td>{s['w']}-{s['l']}</td><td>{xrec(s)}</td><td>{s['sow']:.1f}-{s['n']-s['sow']:.1f}</td><td>{dw(s):+.1f}</td><td>{luck(s):+.1f}</td><td>{s['fw']}-{s['fl']}</td><td>{s['uw']}-{s['ul']}</td></tr>" for yr,s in ys.items())
    t2=''.join(f"<tr><td>{yr}</td><td>{s['w']}-{s['l']}</td><td>{s['osw']}-{s['osl']}</td><td>{fr(s['tom'],'{:+.0f}')}</td><td>{luck(s):+.1f}</td></tr>" for yr,s in ys.items())
    t3=''.join(f"<tr><td>{yr}</td><td>{fr(r.get('talent_rank'))}</td><td>{fr(r.get('recruit_rank'))}</td><td>{fr(r.get('ap_pre'))}</td><td>{fr(r.get('sp_rank'))}</td><td>{fr(r.get('sp_off_rank'))}</td><td>{fr(r.get('sp_def_rank'))}</td><td>{ys[yr]['w']}-{ys[yr]['l']}</td></tr>" for yr in yrs for r in [srow(t,yr)])
    t4=''.join(f"<tr><td>{yr}</td><td>{s['w']}-{s['l']}</td><td>{rec(s)}</td><td>{s['pct']:.0f}%</td><td>{s['cm']:+.1f}</td></tr>" for yr,s in ys.items())
    mv=g.dropna(subset=['move']); mvtxt=''
    if len(mv)>20:
        toward=mv[mv.move<0]; away=mv[mv.move>0]
        mvtxt=f"<p>Of {len(mv)} games with an opening line, the number moved toward {H.escape(t)} in {len(toward)} ({stats(toward)['pct']:.0f}% beat the number when it did) and away in {len(away)} ({stats(away)['pct']:.0f}%). Average movement {mv.move.mean():+.2f} points; negative means bettors pushed the line further in the team's favor.</p>"
    tal_t=tal.get(t,np.nan); sp_t=spr.get(t,np.nan)
    return f'''<section class="team" id="{slug(t)}" style="--accent:{col}" hidden>
<h1>{H.escape(t)}, 2021 through 2025</h1>
<p class="sub">Every game with a closing line, five seasons, from the {H.escape(t)} side of the number.</p>
<div class="big"><div><b>{st['w']}-{st['l']}</b><span>won-lost, {st['n']} games</span></div><div><b>{st['xw']:.1f}</b><span>wins the market expected</span></div><div><b>{st['sow']:.1f}</b><span>wins the play deserved</span></div><div><b>No. {fr(tal_t)}</b><span>roster by talent, avg national rank</span></div><div><b>No. {fr(sp_t)}</b><span>quality of play (SP+), avg national rank</span></div></div>
{INTRO_TEAM}
{GLOSS}
<h2>1. Were the expectations wrong?</h2>
<p>The closing line is the sharpest forecast there is. Convert each one to a chance of winning and add them up, and you get the record the market expected. Deserved wins come from the other direction: after each game, a play-by-play model estimates how often a team that played that way wins it. If the market expected more wins than the play deserved, the expectations were wrong. If the play deserved more than the team got, keep reading.</p>
{xwchart(g,col)}
<div class="key"><span><i style="background:var(--accent)"></i>Won</span><span><i class="open"></i>Market expected</span><span><i class="sq" style="background:var(--accent)"></i>Play deserved</span></div>
<div class="wrap"><table><tr><th>Season</th><th>Record</th><th>Market expected</th><th>Play deserved</th><th>Won vs market</th><th>Won vs deserved</th><th>As favorite</th><th>As underdog</th></tr>{t1}</table></div>
<h2>2. Was it luck?</h2>
<p>Luck is the gap between what the play deserved and what actually happened: close games, turnovers, and the afternoons that defied the odds. The games below are ranked by the pre-game chance of winning implied by the closing line.</p>
{surprises(g)}
<h3>Close games and turnovers</h3>
<div class="wrap"><table><tr><th>Season</th><th>Record</th><th>One-score games</th><th>Turnover margin</th><th>Won vs deserved</th></tr>{t2}</table></div>
<h2>3. Was it the roster?</h2>
<p>Three national rankings side by side: the roster's recruiting pedigree (247Sports talent composite), how well the team actually played (SP+), and where the preseason AP poll had it. Lower is better. When the play line sits below the talent line, the roster gave less than its rankings promised. Above it, more.</p>
{rankchart(t) if HAS_S else ''}
<div class="key"><span><i style="background:var(--accent)"></i>Talent composite</span><span><i style="background:var(--ink)"></i>SP+ (quality of play)</span><span><i style="background:var(--push)"></i>Preseason AP (blank = unranked)</span></div>
<div class="wrap"><table><tr><th>Season</th><th>Talent</th><th>Recruiting class</th><th>Preseason AP</th><th>SP+</th><th>Offense</th><th>Defense</th><th>Record</th></tr>{t3}</table></div>
<h2>Appendix: game by game against the number</h2>
<p>For readers who follow the lines. Everything above was built from these games.</p>
<div class="big"><div><b>{rec(st)}</b><span>vs the number (beat-short-push)</span></div><div><b>{st['pct']:.0f}%</b><span>beat the number (52.4% breaks even for a bettor)</span></div><div><b>{st['cm']:+.1f}</b><span>beat the number by, avg points</span></div></div>
<h3>Expected margin versus actual margin</h3>
<p>Each dot is one game. Left to right is the closing line; up and down is the final margin. Dots above the dashed line beat the number, dots below fell short.</p>
{scatter(g,col)}
<div class="key"><span><i style="background:var(--accent)"></i>Beat the number</span><span><i style="background:var(--nocover)"></i>Fell short</span><span><i style="background:var(--push)"></i>Push</span></div>
<h3>Beat the number by, game by game</h3>
{strip(g)}
<h3>Season by season</h3>
<div class="wrap"><table><tr><th>Season</th><th>Record</th><th>Vs the number</th><th>Beat %</th><th>Beat by, avg</th></tr>{t4}</table></div>
<h3>Splits</h3>
{split_table(g)}
{mvtxt}
<p class="more"><a href="#sec">Compare with the rest of the SEC</a></p>
</section>'''

# ---------- conference page
tot={t:stats(d[d.team==t]) for t in TEAMS}
fav={t:stats(d[(d.team==t)&(d.fav=='Favorite')]) for t in TEAMS}
dog={t:stats(d[(d.team==t)&(d.fav=='Underdog')]) for t in TEAMS}
mvs={t:d[(d.team==t)].move.mean() for t in TEAMS}
order=sorted(TEAMS,key=lambda t:tot[t]['cm'],reverse=True)
xorder=sorted(TEAMS,key=lambda t:dw(tot[t]),reverse=True)
tal={t:(S[S.team==t].talent_rank.mean() if HAS_S and 'talent_rank' in S else np.nan) for t in TEAMS}
spr={t:(S[S.team==t].sp_rank.mean() if HAS_S and 'sp_rank' in S else np.nan) for t in TEAMS}
dev={t:(tal[t]-spr[t] if pd.notna(tal[t]) and pd.notna(spr[t]) else 0) for t in TEAMS}
dorder=sorted(TEAMS,key=lambda t:dev[t],reverse=True)
morder=sorted(TEAMS,key=lambda t:mgap(tot[t]),reverse=True)
ctx_rows=''.join(f"<tr{' class=hi' if t=='Texas A&M' else ''}><td>{H.escape(t)}</td><td>{fr(tal[t])}</td><td>{fr(spr[t])}</td><td>{fr(dev[t],'{:+.0f}')}</td><td>{tot[t]['w']}-{tot[t]['l']}</td><td>{tot[t]['sow']:.1f}</td><td>{tot[t]['xw']:.1f}</td><td>{luck(tot[t]):+.1f}</td><td>{mgap(tot[t]):+.1f}</td></tr>" for t in morder)
def dotplot():
    W,rh=720,30; L,R=150,30; Hh=rh*len(TEAMS)+50
    xmin,xmax=-4,4; X=lambda v:L+(v-xmin)/(xmax-xmin)*(W-L-R)
    s=[f'<svg viewBox="0 0 {W} {Hh}" class="chart" role="img" aria-label="Average beat-by margin by team">']
    for v in range(-4,5): s.append(f'<line x1="{X(v):.1f}" y1="10" x2="{X(v):.1f}" y2="{Hh-30}" class="{"zero" if v==0 else "grid"}"/><text x="{X(v):.1f}" y="{Hh-12}" class="tick" text-anchor="middle">{v:+d}</text>')
    for i,t in enumerate(order):
        y=20+i*rh; v=tot[t]['cm']; pct=tot[t]['pct']
        s.append(f'<text x="{L-10}" y="{y+5}" class="tname{" hi" if t=="Texas A&M" else ""}" text-anchor="end">{H.escape(t)}</text>')
        s.append(f'<line x1="{X(0):.1f}" y1="{y}" x2="{X(v):.1f}" y2="{y}" class="stem"/>')
        s.append(f'<circle cx="{X(v):.1f}" cy="{y}" r="7" fill="{COLORS[t]}" class="dot"><title>{H.escape(t)}: {rec(tot[t])} ATS, {pct:.0f}%, avg {v:+.2f}</title></circle>')
        s.append(f'<text x="{X(v)+(12 if v>=0 else -12):.1f}" y="{y+4}" class="tick" text-anchor="{"start" if v>=0 else "end"}">{v:+.1f}</text>')
    s.append(f'<text x="{(L+W-R)/2:.0f}" y="{Hh-0}" class="axis" text-anchor="middle"></text></svg>'); return ''.join(s)

def favdog():
    W,rh=720,30; L,R=150,30; Hh=rh*len(TEAMS)+50; xmin,xmax=20,80; X=lambda v:L+(v-xmin)/(xmax-xmin)*(W-L-R)
    s=[f'<svg viewBox="0 0 {W} {Hh}" class="chart" role="img" aria-label="Cover rate as favorite versus underdog">']
    for v in range(20,81,10): s.append(f'<line x1="{X(v):.1f}" y1="10" x2="{X(v):.1f}" y2="{Hh-30}" class="{"zero" if v==50 else "grid"}"/><text x="{X(v):.1f}" y="{Hh-12}" class="tick" text-anchor="middle">{v}%</text>')
    for i,t in enumerate(sorted(TEAMS,key=lambda t:fav[t]['pct'],reverse=True)):
        y=20+i*rh; f=fav[t]['pct']; u=dog[t]['pct']
        s.append(f'<text x="{L-10}" y="{y+5}" class="tname{" hi" if t=="Texas A&M" else ""}" text-anchor="end">{H.escape(t)}</text>')
        s.append(f'<line x1="{X(f):.1f}" y1="{y}" x2="{X(u):.1f}" y2="{y}" class="stem"/>')
        s.append(f'<circle cx="{X(f):.1f}" cy="{y}" r="6" fill="{COLORS[t]}"><title>{H.escape(t)} as favorite: {rec(fav[t])} ({f:.0f}%)</title></circle>')
        s.append(f'<circle cx="{X(u):.1f}" cy="{y}" r="6" fill="none" stroke="{COLORS[t]}" stroke-width="2.5"><title>{H.escape(t)} as underdog: {rec(dog[t])} ({u:.0f}%)</title></circle>')
    s.append('</svg>'); return ''.join(s)

def xwplot():
    W,rh=720,30; L,R=150,30; Hh=rh*len(TEAMS)+50; xmin,xmax=-8,8; X=lambda v:L+(v-xmin)/(xmax-xmin)*(W-L-R)
    s=[f'<svg viewBox="0 0 {W} {Hh}" class="chart" role="img" aria-label="Wins above expectation by team">']
    for v in range(-8,9,2): s.append(f'<line x1="{X(v):.1f}" y1="10" x2="{X(v):.1f}" y2="{Hh-30}" class="{"zero" if v==0 else "grid"}"/><text x="{X(v):.1f}" y="{Hh-12}" class="tick" text-anchor="middle">{v:+d}</text>')
    for i,t in enumerate(xorder):
        y=20+i*rh; v=dw(tot[t])
        s.append(f'<text x="{L-10}" y="{y+5}" class="tname{" hi" if t=="Texas A&M" else ""}" text-anchor="end">{H.escape(t)}</text>')
        s.append(f'<line x1="{X(0):.1f}" y1="{y}" x2="{X(v):.1f}" y2="{y}" class="stem"/>')
        s.append(f'<circle cx="{X(v):.1f}" cy="{y}" r="7" fill="{COLORS[t]}" class="dot"><title>{H.escape(t)}: {tot[t]["w"]}-{tot[t]["l"]} actual, {xrec(tot[t])} expected</title></circle>')
        s.append(f'<text x="{X(v)+(12 if v>=0 else -12):.1f}" y="{y+4}" class="tick" text-anchor="{"start" if v>=0 else "end"}">{v:+.1f}</text>')
    s.append('</svg>'); return ''.join(s)

def quad():
    W,Hh=720,540; L,R,T,B=56,20,24,48
    pts={t:(luck(tot[t]),mgap(tot[t])) for t in TEAMS}
    m=max(6,math.ceil(max(max(abs(x),abs(y)) for x,y in pts.values())+0.5))
    X=lambda v:L+(v+m)/(2*m)*(W-L-R); Y=lambda v:T+(m-v)/(2*m)*(Hh-T-B)
    s=[f'<svg viewBox="0 0 {W} {Hh}" class="chart" role="img" aria-label="Overrated versus underrated and overperforming versus underperforming">']
    step=2 if m<=8 else 4
    for v in range(-m,m+1,step):
        s.append(f'<line x1="{X(v):.1f}" y1="{T}" x2="{X(v):.1f}" y2="{Hh-B}" class="{"zero" if v==0 else "grid"}"/><text x="{X(v):.1f}" y="{Hh-B+18}" class="tick" text-anchor="middle">{v:+d}</text>')
        s.append(f'<line x1="{L}" y1="{Y(v):.1f}" x2="{W-R}" y2="{Y(v):.1f}" class="{"zero" if v==0 else "grid"}"/><text x="{L-8}" y="{Y(v)+4:.1f}" class="tick" text-anchor="end">{v:+d}</text>')
    for x,y,a,txt in [(L+8,T+14,'start','Overrated, underperformed'),(W-R-8,T+14,'end','Overrated, overperformed'),(L+8,Hh-B-8,'start','Underrated, underperformed'),(W-R-8,Hh-B-8,'end','Underrated, overperformed')]:
        s.append(f'<text x="{x}" y="{y}" class="lbl faint" text-anchor="{a}">{txt}</text>')
    s.append(f'<text x="{(L+W-R)/2:.0f}" y="{Hh-8}" class="axis" text-anchor="middle">Actual wins minus deserved wins (overperformed to the right)</text>')
    s.append(f'<text transform="translate(14 {(T+Hh-B)/2:.0f}) rotate(-90)" class="axis" text-anchor="middle">Market-expected minus deserved wins (overrated is up)</text>')
    for t in sorted(TEAMS,key=lambda t:pts[t][1]):
        x,y=pts[t]; s.append(f'<circle cx="{X(x):.1f}" cy="{Y(y):.1f}" r="7" fill="{COLORS[t]}" class="dot"><title>{H.escape(t)}: won {tot[t]["w"]}, deserved {tot[t]["sow"]:.1f}, market expected {tot[t]["xw"]:.1f}</title></circle>')
        s.append(f'<text x="{X(x)+10:.1f}" y="{Y(y)+4:.1f}" class="tname{" hi" if t=="Texas A&M" else ""}" style="font-size:12px">{H.escape(t)}</text>')
    s.append('</svg>'); return ''.join(s)

def devplot():
    W,rh=720,30; L,R=150,30; Hh=rh*len(TEAMS)+50; m=30; X=lambda v:L+(v+m)/(2*m)*(W-L-R)
    s=[f'<svg viewBox="0 0 {W} {Hh}" class="chart" role="img" aria-label="Talent rank minus SP+ rank by team">']
    for v in range(-m,m+1,10): s.append(f'<line x1="{X(v):.1f}" y1="10" x2="{X(v):.1f}" y2="{Hh-30}" class="{"zero" if v==0 else "grid"}"/><text x="{X(v):.1f}" y="{Hh-12}" class="tick" text-anchor="middle">{v:+d}</text>')
    for i,t in enumerate(dorder):
        y=20+i*rh; v=max(-m,min(m,dev[t]))
        s.append(f'<text x="{L-10}" y="{y+5}" class="tname{" hi" if t=="Texas A&M" else ""}" text-anchor="end">{H.escape(t)}</text>')
        s.append(f'<line x1="{X(0):.1f}" y1="{y}" x2="{X(v):.1f}" y2="{y}" class="stem"/>')
        s.append(f'<circle cx="{X(v):.1f}" cy="{y}" r="7" fill="{COLORS[t]}" class="dot"><title>{H.escape(t)}: avg talent rank {tal[t]:.0f}, avg SP+ rank {spr[t]:.0f}</title></circle>')
        s.append(f'<text x="{X(v)+(12 if v>=0 else -12):.1f}" y="{y+4}" class="tick" text-anchor="{"start" if v>=0 else "end"}">{dev[t]:+.0f}</text>')
    s.append('</svg>'); return ''.join(s)

def heat():
    yrs=[2021,2022,2023,2024,2025]; cw=100; L=150; W=L+cw*5+20; rh=30; Hh=rh*len(TEAMS)+40
    s=[f'<svg viewBox="0 0 {W} {Hh}" class="chart" role="img" aria-label="Cover rate by team and season">']
    for j,y in enumerate(yrs): s.append(f'<text x="{L+j*cw+cw/2}" y="20" class="tick" text-anchor="middle">{y}</text>')
    for i,t in enumerate(order):
        y=30+i*rh; s.append(f'<text x="{L-10}" y="{y+19}" class="tname{" hi" if t=="Texas A&M" else ""}" text-anchor="end">{H.escape(t)}</text>')
        for j,yr in enumerate(yrs):
            st=stats(d[(d.team==t)&(d.season==yr)]); p=st['pct']; a=min(1,abs(p-50)/30)
            fill=f'rgba(80,0,0,{a:.2f})' if p>=50 else f'rgba(184,168,143,{a:.2f})'
            s.append(f'<rect x="{L+j*cw+2}" y="{y+2}" width="{cw-4}" height="{rh-4}" fill="{fill}" class="cell"><title>{H.escape(t)} {yr}: {rec(st)} ATS, {st["w"]}-{st["l"]} SU, avg {st["cm"]:+.1f}</title></rect>')
            s.append(f'<text x="{L+j*cw+cw/2}" y="{y+19}" class="cellt" text-anchor="middle">{rec(st)}</text>')
    s.append('</svg>'); return ''.join(s)

conf_rows=''.join(f"<tr{' class=hi' if t=='Texas A&M' else ''}><td>{H.escape(t)}</td><td>{tot[t]['w']}-{tot[t]['l']}</td><td>{rec(tot[t])}</td><td>{tot[t]['pct']:.0f}%</td><td>{tot[t]['cm']:+.1f}</td><td>{fav[t]['pct']:.0f}%</td><td>{dog[t]['pct']:.0f}%</td><td>{mvs[t]:+.2f}</td></tr>" for t in order)
allst=stats(d); am=tot['Texas A&M']; rank=order.index('Texas A&M')+1; xrank=xorder.index('Texas A&M')+1
xw_rows=''.join(f"<tr{' class=hi' if t=='Texas A&M' else ''}><td>{H.escape(t)}</td><td>{tot[t]['w']}-{tot[t]['l']}</td><td>{xrec(tot[t])}</td><td>{dw(tot[t]):+.1f}</td><td>{tot[t]['fw']}-{tot[t]['fl']}</td><td>{tot[t]['uw']}-{tot[t]['ul']}</td></tr>" for t in xorder)
sd=d.groupby('team').cover_margin.mean().std()
opts=''.join(f'<option value="{slug(t)}">{H.escape(t)}</option>' for t in TEAMS)

lorder=sorted(TEAMS,key=lambda t:luck(tot[t]),reverse=True)
mrank=morder.index('Texas A&M')+1; lrank=lorder.index('Texas A&M')+1; drank=dorder.index('Texas A&M')+1
conf=f'''<section class="team" id="sec" style="--accent:#1c1a1a">
<h1>The SEC, 2021 through 2025</h1>
<p class="sub">Sixteen current SEC programs, {len(d):,} team-games, every one with a closing line. Texas and Oklahoma's Big 12 seasons are included so each program has the same five-year window.</p>
<div class="big"><div><b>{am['w']}-{am['l']}</b><span>Texas A&amp;M won-lost</span></div><div><b>{mgap(am):+.1f}</b><span>market expected minus play deserved, {mrank} of 16</span></div><div><b>{luck(am):+.1f}</b><span>won minus play deserved, {lrank} of 16</span></div><div><b>{fr(dev['Texas A&M'],'{:+.0f}')}</b><span>talent rank minus SP+ rank, {drank} of 16</span></div></div>
{INTRO_SEC}
{GLOSS}
<h2>Overrated, underrated, lucky, unlucky</h2>
<p>Up and down is what the market expected minus what the play deserved: up is overrated. Left and right is actual wins minus deserved wins: right is overperforming, usually close games and turnover luck. Five-season totals. A team can be overrated and unlucky at the same time; that is the top-left corner.</p>
{quad()}
<h2>Playing above or below the roster</h2>
<p>Average talent-composite rank minus average SP+ rank across the five seasons. Positive means the program has played better than its recruiting rankings would predict; negative means the roster has been better than the play. Ranks are among all FBS programs.</p>
{devplot() if HAS_S else ''}
<div class="wrap"><table><tr><th>Team</th><th>Talent rank</th><th>SP+ rank</th><th>Talent&minus;SP+</th><th>Record</th><th>Play deserved</th><th>Market expected</th><th>Won vs deserved</th><th>Market vs deserved</th></tr>{ctx_rows}</table></div>
<h2>Wins versus expectation</h2>
<p>Actual wins minus the wins the market expected, five-season totals. Positive means the program won more often than it was priced to. This mixes the first two questions together; the quadrant chart above pulls them apart.</p>
{xwplot()}
<div class="wrap"><table><tr><th>Team</th><th>Record</th><th>Market expected</th><th>Won vs market</th><th>As favorite</th><th>As underdog</th></tr>{xw_rows}</table></div>
<h2>Appendix: against the number</h2>
<p>For readers who follow the lines.</p>
<div class="big"><div><b>{allst['pct']:.1f}%</b><span>league-wide beat-the-number rate</span></div><div><b>{am['pct']:.0f}%</b><span>Texas A&amp;M beat-the-number rate</span></div><div><b>{rank} of 16</b><span>A&amp;M rank by beat-by average</span></div></div>
<h3>Beat the number by, on average</h3>
<p>Positive means the program beat its closing number on average; negative means the market was consistently too generous. The whole league spans under {sd*2:.0f} points end to end, so small differences here are mostly noise.</p>
{dotplot()}
<h3>Favorites and underdogs</h3>
<p>Filled dot is the beat-the-number rate as a favorite, open circle as an underdog. A team far to the left on the filled dot but to the right on the open one is a program the public overbuys when it's expected to win.</p>
{favdog()}
<h3>Season by season</h3>
<p>Record against the number per team-season. Maroon shading is above 50%, tan is below; deeper color is further from even.</p>
{heat()}
<h3>All sixteen</h3>
<p>Line move is the average change from opening to closing line from the team's perspective; negative means bettors pushed the number further in the team's favor. About half of games have an opening line on file.</p>
<div class="wrap"><table><tr><th>Team</th><th>Won-lost</th><th>Vs the number</th><th>Beat %</th><th>Beat by, avg</th><th>Beat % as fav</th><th>Beat % as dog</th><th>Line move</th></tr>{conf_rows}</table></div>
<p class="note">Data: CollegeFootballData.com games and lines endpoints, closing line from consensus or DraftKings where available. Lines are from the listed team's side, negative = favored. Beat by = actual margin + line. Conference games appear once for each side, so the league-wide beat-by average nets to roughly zero by construction; per-team numbers are unaffected. Expected wins convert each closing line to a win probability with a normal model (standard deviation {SIG:.1f} points, fitted to this data) and sum them. Deserved wins sum CFBD's postgame win probability per game; where CFBD has no play-by-play for a game ({int(d.post_wp.isna().sum())} of {len(d)}), the line-implied probability stands in. Talent composite, recruiting ranks, SP+, and AP polls are CFBD's season tables.</p>
<p class="more"><a href="#texas-am">Texas A&amp;M's page</a></p>
</section>'''

page=f'''<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>The SEC, 2021 through 2025: expectations, luck, and talent</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;700&family=Barlow:wght@400;600&display=swap">
<style>
:root{{box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);
--bg:#f7f5f2;--ink:#1c1a1a;--mute:#6b6360;--rule:#dcd6d0;--nocover:#b8a88f;--push:#8e8e8e;--panel:#ffffff}}
@media (prefers-color-scheme:dark){{:root:not([data-theme="light"]){{--bg:#171414;--ink:#f1ecea;--mute:#a59d99;--rule:#332c2c;--nocover:#5e5750;--push:#7a7a7a;--panel:#211c1c}}}}
:root[data-theme="dark"]{{--bg:#171414;--ink:#f1ecea;--mute:#a59d99;--rule:#332c2c;--nocover:#5e5750;--push:#7a7a7a;--panel:#211c1c}}
html{{scroll-padding-top:env(safe-area-inset-top,0px)}}
body{{margin:0;background:var(--bg);color:var(--ink);font-family:Barlow,"Helvetica Neue",Arial,sans-serif;line-height:1.5}}
main{{max-width:760px;margin:0 auto;padding:20px 18px 60px}}
nav{{position:sticky;top:env(safe-area-inset-top,0px);background:var(--bg);padding:10px 0 12px;border-bottom:1px solid var(--rule);margin-bottom:22px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;z-index:2}}
nav label{{color:var(--mute);font-size:14px}}
select{{font:inherit;font-size:16px;padding:6px 10px;background:var(--panel);color:var(--ink);border:1px solid var(--rule);border-radius:4px}}
select:focus{{outline:2px solid var(--accent,#500000);outline-offset:1px}}
h1{{font-family:"Barlow Condensed","Arial Narrow",Arial,sans-serif;font-weight:700;font-size:clamp(38px,8vw,64px);line-height:.95;margin:0 0 6px;letter-spacing:-.01em}}
h2{{font-family:"Barlow Condensed","Arial Narrow",Arial,sans-serif;font-weight:700;font-size:26px;margin:44px 0 4px}}
h3{{font-family:"Barlow Condensed","Arial Narrow",Arial,sans-serif;font-weight:700;font-size:19px;margin:24px 0 0}}
.intro{{border:1px solid var(--rule);background:var(--panel);padding:4px 16px;margin:22px 0 10px}} .intro p{{max-width:none}}
.gloss{{font-size:14px;color:var(--mute);margin:0 0 8px}} .gloss summary{{cursor:pointer;font-weight:600;color:var(--ink)}} .gloss dl{{margin:6px 0 0}} .gloss dt{{font-weight:600;color:var(--ink);margin-top:8px}} .gloss dd{{margin:0}}
.key i.open{{background:transparent;border:2px solid var(--accent);box-sizing:border-box}} .key i.sq{{border-radius:0;opacity:.5}}
.more{{margin-top:36px;font-weight:600}} a{{color:inherit}}
.sub{{color:var(--mute);margin:0 0 26px;max-width:60ch}} p{{max-width:64ch}}
.big{{display:flex;gap:20px;flex-wrap:wrap;margin:10px 0 6px;border-top:2px solid var(--accent);padding-top:12px}}
.big div{{min-width:110px;max-width:130px}} .big b{{font-family:"Barlow Condensed",Arial,sans-serif;font-size:44px;line-height:1;display:block}} .big span{{color:var(--mute);font-size:14px}}
.chart{{width:100%;height:auto;display:block;background:var(--panel);border:1px solid var(--rule);padding:8px;box-sizing:border-box}}
.grid{{stroke:var(--rule);stroke-width:1}} .zero{{stroke:var(--mute);stroke-width:1.2}} .stem{{stroke:var(--rule);stroke-width:2}}
.fair{{stroke:var(--ink);stroke-width:1.5;stroke-dasharray:6 5}}
.tick,.lbl,.axis,.oppl,.seasonstat,.tname,.cellt{{font-family:Barlow,Arial,sans-serif;fill:var(--mute);font-size:12px}}
.lbl{{fill:var(--ink);font-weight:600}} .lbl.faint{{fill:var(--mute);font-weight:400}} .axis{{font-size:13px}} .oppl{{font-size:10.5px}}
.tname{{fill:var(--ink);font-size:14px}} .tname.hi{{font-weight:600}} .cellt{{fill:var(--ink);font-size:12px}}
.seasonlbl{{font-family:"Barlow Condensed",Arial,sans-serif;font-size:22px;font-weight:700;fill:var(--ink)}}
.pt{{stroke:var(--panel);stroke-width:1.2}} .pt.cover,.bar.cover{{fill:var(--accent)}} .pt.nocover,.bar.nocover{{fill:var(--nocover)}} .pt.push,.bar.push{{fill:var(--push)}}
.key{{display:flex;gap:18px;flex-wrap:wrap;font-size:13px;color:var(--mute);margin:8px 0 0}} .key i{{display:inline-block;width:12px;height:12px;border-radius:50%;vertical-align:-1px;margin-right:6px}}
table{{width:100%;border-collapse:collapse;font-size:15px;margin-top:10px}} th,td{{text-align:right;padding:8px 6px;border-bottom:1px solid var(--rule);white-space:nowrap}} th:first-child,td:first-child{{text-align:left}}
th{{font-weight:600;color:var(--mute)}} tr.hi td{{font-weight:600;background:rgba(80,0,0,.06)}} .wrap{{overflow-x:auto}}
.note{{font-size:14px;color:var(--mute);border-left:3px solid var(--nocover);padding-left:12px;margin-top:28px}}
@media (prefers-reduced-motion:no-preference){{.pt{{transition:r .15s}} .pt:hover{{r:8.5}}}}
</style></head><body><main>
<nav><label for="pick">Show</label><select id="pick"><option value="sec">SEC overview</option>{opts}</select></nav>
{conf}
{''.join(team_section(t) for t in TEAMS)}
</main>
<script>
(function(){{var sel=document.getElementById('pick');function show(id){{document.querySelectorAll('section.team').forEach(function(s){{s.hidden=s.id!==id}});sel.value=id;window.scrollTo(0,0)}}
function fromHash(){{var h=location.hash.slice(1);return (h&&document.getElementById(h))?h:null}}
sel.addEventListener('change',function(){{history.replaceState(null,'','#'+sel.value);show(sel.value)}});
window.addEventListener('hashchange',function(){{var h=fromHash();if(h)show(h)}});
window.addEventListener('load',function(){{window.scrollTo(0,0)}});
show(fromHash()||'texas-am')}})();
</script></body></html>'''
open('cfbanalysis.html','w',encoding='utf-8').write(page)
print(len(page)//1024,'KB'); print(pd.DataFrame({t:tot[t] for t in order}).T[['n','c','nc','p','pct','cm']].round(1).to_string())
print('season file:',HAS_S,'post_wp missing:',int(d.post_wp.isna().sum()),'to_margin missing:',int(d.to_margin.isna().sum()))
print('sigma',round(SIG,2),'A&M W/xW',tot['Texas A&M']['w'],round(tot['Texas A&M']['xw'],1))
print('fav/dog A&M',fav['Texas A&M']['pct'],dog['Texas A&M']['pct'],'move',mvs['Texas A&M'])

