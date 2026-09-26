"""
Build the SEC against-the-spread page.
    pip install pandas numpy
    python build_cfbanalysis.py      (reads sec_games_2021_2025.csv, writes cfbanalysis.html)
Rename/copy cfbanalysis.html to public/cfbanalysis/index.html in the web app.
"""
import pandas as pd, numpy as np, html as H, math
d=pd.read_csv('sec_games_2021_2025.csv',encoding='latin-1')
d['res']=np.where(d.cover_margin>0,'Cover',np.where(d.cover_margin<0,'No Cover','Push'))
d['fav']=np.where(d.close_spread<0,'Favorite',np.where(d.close_spread>0,'Underdog','Pick'))
d['move']=d.close_spread-d.open_spread  # negative = line moved toward team (team became bigger fav)
d['su']=np.where(d.actual_margin>0,'W','L')
SIG=d.cover_margin.std()  # observed std dev of (actual margin - spread); ~15 points in this data
d['p']=[0.5*(1+math.erf(-sp/(SIG*math.sqrt(2)))) for sp in d.close_spread]  # spread-implied pre-game win probability
COLORS={"Alabama":"#9E1B32","Arkansas":"#9D2235","Auburn":"#0C2340","Florida":"#0021A5","Georgia":"#BA0C2F","Kentucky":"#0033A0","LSU":"#461D7C","Mississippi State":"#5D1725","Missouri":"#F1B82D","Oklahoma":"#841617","Ole Miss":"#14213D","South Carolina":"#73000A","Tennessee":"#FF8200","Texas":"#BF5700","Texas A&M":"#500000","Vanderbilt":"#866D4B"}
TEAMS=sorted(COLORS)
def slug(t): return t.lower().replace(' ','-').replace('&','')
def stats(g):
    n=len(g); c=(g.res=='Cover').sum(); nc=(g.res=='No Cover').sum(); p=(g.res=='Push').sum()
    fv=g[g.fav=='Favorite']; ud=g[g.fav=='Underdog']
    return dict(n=n,c=c,nc=nc,p=p,pct=(c+0.5*p)/n*100 if n else np.nan,cm=g.cover_margin.mean() if n else np.nan,
                w=(g.su=='W').sum(),l=(g.su=='L').sum(),xw=g.p.sum() if n else np.nan,
                fw=(fv.su=='W').sum(),fl=(fv.su=='L').sum(),uw=(ud.su=='W').sum(),ul=(ud.su=='L').sum())
def rec(s): return f"{s['c']}-{s['nc']}-{s['p']}"
def xrec(s): return f"{s['xw']:.1f}-{s['n']-s['xw']:.1f}"
def dw(s): return s['w']-s['xw']

# ---------- charts
def scatter(g,color):
    W,Hh=720,540; L,R,T,B=56,20,20,48
    xmin,xmax=-60,40; ymin,ymax=-45,65
    X=lambda v:L+(v-xmin)/(xmax-xmin)*(W-L-R); Y=lambda v:T+(ymax-v)/(ymax-ymin)*(Hh-T-B)
    s=[f'<svg viewBox="0 0 {W} {Hh}" class="chart" role="img" aria-label="Closing spread versus actual margin">']
    for v in range(-60,41,10): s.append(f'<line x1="{X(v):.1f}" y1="{T}" x2="{X(v):.1f}" y2="{Hh-B}" class="grid"/><text x="{X(v):.1f}" y="{Hh-B+18}" class="tick" text-anchor="middle">{v:+d}</text>')
    for v in range(-40,66,10): s.append(f'<line x1="{L}" y1="{Y(v):.1f}" x2="{W-R}" y2="{Y(v):.1f}" class="grid"/><text x="{L-8}" y="{Y(v)+4:.1f}" class="tick" text-anchor="end">{v:+d}</text>')
    s.append(f'<line x1="{X(xmin):.1f}" y1="{Y(0):.1f}" x2="{X(xmax):.1f}" y2="{Y(0):.1f}" class="zero"/>')
    s.append(f'<line x1="{X(-60):.1f}" y1="{Y(60):.1f}" x2="{X(40):.1f}" y2="{Y(-40):.1f}" class="fair"/>')
    s.append(f'<text x="{X(-57):.1f}" y="{Y(58)-6:.1f}" class="lbl">Books exactly right</text>')
    s.append(f'<text x="{X(-45):.1f}" y="{Y(50):.1f}" class="lbl faint">Covered ↑</text><text x="{X(14):.1f}" y="{Y(-36):.1f}" class="lbl faint">↓ Did not cover</text>')
    s.append(f'<text x="{(L+W-R)/2:.0f}" y="{Hh-8}" class="axis" text-anchor="middle">Closing spread (negative = favored)</text>')
    s.append(f'<text transform="translate(14 {(T+Hh-B)/2:.0f}) rotate(-90)" class="axis" text-anchor="middle">Actual margin</text>')
    for _,r in g.iterrows():
        cls={'Cover':'cover','No Cover':'nocover','Push':'push'}[r.res]
        loc={'H':'vs','A':'at','N':'vs (N)'}[r.site]
        tip=f"{r.season} {loc} {r.opponent}: {r.su} {r.team_pts}-{r.opp_pts}, line {r.close_spread:+g}, cover margin {r.cover_margin:+g}"
        s.append(f'<circle cx="{X(r.close_spread):.1f}" cy="{Y(r.actual_margin):.1f}" r="5.5" class="pt {cls}"><title>{H.escape(tip)}</title></circle>')
    s.append('</svg>'); return ''.join(s)

def strip(g):
    W=720; rowh=118; seasons=sorted(g.season.unique()); Hh=rowh*len(seasons)+10
    s=[f'<svg viewBox="0 0 {W} {Hh}" class="chart" role="img" aria-label="Cover margin by game">']
    for i,yr in enumerate(seasons):
        y0=i*rowh+10; base=y0+62; rs=g[g.season==yr]; st=stats(rs)
        s.append(f'<text x="0" y="{y0+14}" class="seasonlbl">{yr}</text>')
        s.append(f'<text x="{W}" y="{y0+14}" class="seasonstat" text-anchor="end">{rec(st)} ATS · {st["w"]}-{st["l"]} SU · avg cover margin {st["cm"]:+.1f}</text>')
        s.append(f'<line x1="70" y1="{base}" x2="{W-10}" y2="{base}" class="zero"/>')
        gap=(W-90)/max(len(rs),14)
        for j,(_,r) in enumerate(rs.iterrows()):
            x=80+j*gap+gap/2; yv=base-(max(-40,min(40,r.cover_margin))/40)*40
            cls={'Cover':'cover','No Cover':'nocover','Push':'push'}[r.res]
            tip=f"{r.opponent} ({ {'H':'home','A':'away','N':'neutral'}[r.site]}): {r.su} {r.team_pts}-{r.opp_pts}, line {r.close_spread:+g}, cover margin {r.cover_margin:+g}"
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
        s.append(f'<circle cx="{X(a):.1f}" cy="{y}" r="6" fill="{color}"><title>{yr} actual: {a}-{st["l"]}</title></circle>')
        s.append(f'<text x="{W-R+14}" y="{y+4}" class="tick">{a}-{st["l"]}, {a-e:+.1f} vs expected</text>')
    s.append(f'<text x="{(L+W-R)/2:.0f}" y="{Hh-0}" class="axis" text-anchor="middle">Wins</text></svg>'); return ''.join(s)

def surprises(g):
    def row(r):
        loc={'H':'vs','A':'at','N':'vs (N)'}[r.site]
        return f"<tr><td>{r.season} {loc} {H.escape(r.opponent)}</td><td>{r.su} {r.team_pts}-{r.opp_pts}</td><td>{r.close_spread:+g}</td><td>{r.p*100:.0f}%</td></tr>"
    hdr="<tr><th>Game</th><th>Result</th><th>Line</th><th>Win prob.</th></tr>"
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
    return "<div class='wrap'><table><tr><th>Split</th><th>Games</th><th>Straight up</th><th>ATS</th><th>Cover %</th><th>Avg cover margin</th></tr>"+''.join(rows)+"</table></div>"

def team_section(t):
    g=d[d.team==t].sort_values('date'); st=stats(g); col=COLORS[t]
    seasons=''.join(f"<tr><td>{yr}</td><td>{s['w']}-{s['l']}</td><td>{rec(s)}</td><td>{s['pct']:.0f}%</td><td>{s['cm']:+.1f}</td></tr>" for yr,s in ((yr,stats(g[g.season==yr])) for yr in sorted(g.season.unique())))
    xseasons=''.join(f"<tr><td>{yr}</td><td>{s['w']}-{s['l']}</td><td>{xrec(s)}</td><td>{dw(s):+.1f}</td><td>{s['fw']}-{s['fl']}</td><td>{s['uw']}-{s['ul']}</td></tr>" for yr,s in ((yr,stats(g[g.season==yr])) for yr in sorted(g.season.unique())))
    mv=g.dropna(subset=['move']); mvtxt=''
    if len(mv)>20:
        toward=mv[mv.move<0]; away=mv[mv.move>0]
        mvtxt=f"<p>Of {len(mv)} games with an opening line, the number moved toward {t} in {len(toward)} ({stats(toward)['pct']:.0f}% cover rate when it did) and away in {len(away)} ({stats(away)['pct']:.0f}% cover rate). Average movement {mv.move.mean():+.2f} points; negative means bettors pushed the line further in the team's favor.</p>"
    return f'''<section class="team" id="{slug(t)}" style="--accent:{col}" hidden>
<h1>{H.escape(t)} against the spread</h1>
<p class="sub">Every game from 2021 through 2025 with a closing line, from the {t} side of the number.</p>
<div class="big"><div><b>{rec(st)}</b><span>ATS record, {st['n']} games</span></div><div><b>{st['pct']:.0f}%</b><span>cover rate (52.4% breaks even)</span></div><div><b>{st['cm']:+.1f}</b><span>avg cover margin, points</span></div><div><b>{st['w']}-{st['l']}</b><span>straight up</span></div></div>
<h2>Where the market missed</h2>
<p>Each dot is one game. Left-right is the closing spread; up-down is the final margin. Dots above the dashed line covered, dots below did not.</p>
{scatter(g,col)}
<div class="key"><span><i style="background:var(--accent)"></i>Covered</span><span><i style="background:var(--nocover)"></i>Did not cover</span><span><i style="background:var(--push)"></i>Push</span></div>
<h2>Game by game</h2>
{strip(g)}
<h2>Season by season</h2>
<div class="wrap"><table><tr><th>Season</th><th>Straight up</th><th>ATS</th><th>Cover %</th><th>Avg cover margin</th></tr>{seasons}</table></div>
<h2>Splits</h2>
{split_table(g)}
{mvtxt}
<h2>Wins versus expectation</h2>
<p>Each closing spread implies a win probability; adding those up gives the number of wins the market expected. {H.escape(t)} won {st['w']} of {st['n']} games against an expectation of {st['xw']:.1f}, {abs(dw(st)):.1f} wins {'above' if dw(st)>=0 else 'below'} the market. Filled dot is actual wins, open circle is expected.</p>
{xwchart(g,col)}
<div class="wrap"><table><tr><th>Season</th><th>Record</th><th>Expected</th><th>&plusmn;</th><th>As favorite</th><th>As underdog</th></tr>{xseasons}</table></div>
{surprises(g)}
</section>'''

# ---------- conference page
tot={t:stats(d[d.team==t]) for t in TEAMS}
fav={t:stats(d[(d.team==t)&(d.fav=='Favorite')]) for t in TEAMS}
dog={t:stats(d[(d.team==t)&(d.fav=='Underdog')]) for t in TEAMS}
mvs={t:d[(d.team==t)].move.mean() for t in TEAMS}
order=sorted(TEAMS,key=lambda t:tot[t]['cm'],reverse=True)
xorder=sorted(TEAMS,key=lambda t:dw(tot[t]),reverse=True)
def dotplot():
    W,rh=720,30; L,R=150,30; Hh=rh*len(TEAMS)+50
    xmin,xmax=-4,4; X=lambda v:L+(v-xmin)/(xmax-xmin)*(W-L-R)
    s=[f'<svg viewBox="0 0 {W} {Hh}" class="chart" role="img" aria-label="Average cover margin by team">']
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

conf=f'''<section class="team" id="sec" style="--accent:#1c1a1a">
<h1>The SEC against the spread</h1>
<p class="sub">Sixteen current SEC programs, 2021 through 2025: {len(d):,} team-games, every one with a closing line. Texas and Oklahoma's Big 12 seasons are included so each program has the same five-year window.</p>
<div class="big"><div><b>{allst['pct']:.1f}%</b><span>league-wide cover rate</span></div><div><b>{am['pct']:.0f}%</b><span>Texas A&amp;M cover rate</span></div><div><b>{rank} of 16</b><span>A&amp;M rank by avg cover margin</span></div><div><b>{dw(am):+.1f}</b><span>A&amp;M wins vs expected, {xrank} of 16</span></div></div>
<h2>Who the market gets wrong</h2>
<p>Average cover margin per team. Positive means the program beat its closing number on average; negative means the market was consistently too generous. The spread of the whole league is under {sd*2:.0f} points end to end, so small differences here are mostly noise.</p>
{dotplot()}
<h2>Favorites and underdogs</h2>
<p>Filled dot is cover rate as a favorite, open circle as an underdog. A team far to the left on the filled dot but to the right on the open one is a program the public overbuys when it's expected to win.</p>
{favdog()}
<h2>Season by season</h2>
<p>ATS record per team-season. Maroon shading is above 50%, tan is below; deeper color is further from even.</p>
{heat()}
<h2>Wins versus expectation</h2>
<p>Covering is one question; winning is another. Each closing spread implies a pre-game win probability (a normal curve centered on the spread with a {SIG:.0f}-point standard deviation, the observed scatter of outcomes in this data), and summing those over five years gives the wins the market expected. Positive means the program won more often than it was priced to. A team can sit high here while covering rarely if it keeps winning close as a favorite.</p>
{xwplot()}
<div class="wrap"><table><tr><th>Team</th><th>Record</th><th>Expected</th><th>&plusmn;</th><th>As favorite</th><th>As underdog</th></tr>{xw_rows}</table></div>
<h2>All sixteen</h2>
<p>Line move is the average change from opening to closing spread from the team's perspective; negative means bettors pushed the number further in the team's favor. About half of games have an opening line on file.</p>
<div class="wrap"><table><tr><th>Team</th><th>SU</th><th>ATS</th><th>Cover %</th><th>Avg cover margin</th><th>As fav</th><th>As dog</th><th>Line move</th></tr>{conf_rows}</table></div>
<p class="note">Data: CollegeFootballData.com games and lines endpoints, closing spread from consensus or DraftKings where available. Spreads are from the listed team's side, negative = favored. Cover margin = actual margin + spread. Conference games appear once for each side, so league-wide cover margin nets to roughly zero by construction; per-team numbers are unaffected. Expected wins convert each closing spread to a win probability with a normal model (standard deviation {SIG:.1f} points, fitted to this data) and sum them.</p>
</section>'''

page=f'''<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>SEC against the spread, 2021–2025</title>
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
.sub{{color:var(--mute);margin:0 0 26px;max-width:60ch}} p{{max-width:64ch}}
.big{{display:flex;gap:28px;flex-wrap:wrap;margin:10px 0 6px;border-top:2px solid var(--accent);padding-top:12px}}
.big div{{min-width:120px}} .big b{{font-family:"Barlow Condensed",Arial,sans-serif;font-size:44px;line-height:1;display:block}} .big span{{color:var(--mute);font-size:14px}}
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
(function(){{var sel=document.getElementById('pick');function show(id){{document.querySelectorAll('section.team').forEach(function(s){{s.hidden=s.id!==id}});sel.value=id;try{{localStorage.setItem('secpick',id)}}catch(e){{}}window.scrollTo(0,0)}}
sel.addEventListener('change',function(){{show(sel.value)}});
var h=location.hash.slice(1),saved=null;try{{saved=localStorage.getItem('secpick')}}catch(e){{}}
var init=(h&&document.getElementById(h))?h:'sec';show(init)}})();
</script></body></html>'''
open('cfbanalysis.html','w',encoding='utf-8').write(page)
print(len(page)//1024,'KB'); print(pd.DataFrame({t:tot[t] for t in order}).T[['n','c','nc','p','pct','cm']].round(1).to_string())
print('sigma',round(SIG,2),'A&M W/xW',tot['Texas A&M']['w'],round(tot['Texas A&M']['xw'],1))
print('fav/dog A&M',fav['Texas A&M']['pct'],dog['Texas A&M']['pct'],'move',mvs['Texas A&M'])

