"""Line Watch backtest: "bet TEAM when the live spread moves SWING points toward them from tip-off".

Live lines aren't stored anywhere free, so they're estimated from the score and clock:
    full-adjustment estimate  = -(current margin + tip-off expected margin x share of regulation left)
    live line                 = tip line + K x (full estimate - tip line)
K is how much of a point-for-point move the sportsbook actually makes. K = 1 is the textbook (Stern) model.
Measure K from real recorded DraftKings lines with calibrate.py, then pass it here with --k.

Usage:
    python backtest.py --team bos --seasons 2025 2026 2027 --k 1.0 0.8 0.7
    python backtest.py --team bos --k 0.72          # e.g. the K that calibrate.py measured
Data (ESPN public API) is cached in your temp folder (line-watch-bt-cache). One $100 bet per game at -110, team favored at tip, live only.
"""
import argparse, json, os, tempfile, urllib.request
from concurrent.futures import ThreadPoolExecutor

WIN = 100 * 100 / 110
# ~1 MB per game, so keep it out of synced folders; override with LINE_WATCH_CACHE
CACHE = os.environ.get('LINE_WATCH_CACHE') or os.path.join(tempfile.gettempdir(), 'line-watch-bt-cache')


def get(url, path):
    if os.path.exists(path):
        return json.load(open(path, encoding='utf-8'))
    try:
        d = json.load(urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'}), timeout=30))
    except Exception as ex:
        d = {'_err': str(ex)}
    json.dump(d, open(path, 'w', encoding='utf-8'))
    return d


def num(s):
    s = str(s).strip().upper()
    return 0.0 if s in ('PK', 'EVEN') else float(s)


def secs(t):
    if ':' in t:
        m, s = t.split(':'); return int(m) * 60 + float(s)
    return float(t or 0)


def schedule(team, seasons):
    games = []
    for season in seasons:
        for st in (2, 3):
            url = f'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/{team}/schedule?season={season}&seasontype={st}'
            # schedules aren't cached (the current season keeps adding games)
            s = json.load(urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'}), timeout=30))
            for e in s.get('events', []):
                if e['competitions'][0]['status']['type']['completed']:
                    games.append({'id': e['id'], 'date': e['date'][:10], 'season': season})
    return games


def tip_line(g, sm, side):
    """Closing (tip-off) spread for the team: DraftKings from ESPN's summary, else ESPN's odds feed."""
    pc = (sm.get('pickcenter') or [{}])[0]
    ps = (pc.get('pointSpread') or {}).get(side)
    if ps and ps.get('close', {}).get('line'):
        return num(ps['close']['line'])
    co = get(f"https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/events/{g['id']}/competitions/{g['id']}/odds",
             os.path.join(CACHE, f"odds_{g['id']}.json"))
    for it in co.get('items', []):
        if 'live' in it['provider']['name'].lower():
            continue
        t = it.get('homeTeamOdds' if side == 'home' else 'awayTeamOdds', {})
        c = ((t.get('close') or {}).get('pointSpread') or (t.get('current') or {}).get('pointSpread') or {}).get('american')
        if c:
            return num(c)
    return None


def load(g, team):
    sm = get(f"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event={g['id']}",
             os.path.join(CACHE, f"{g['id']}.json"))
    if '_err' in sm or not sm.get('plays'):
        return None
    comp = sm['header']['competitions'][0]
    side = next((c['homeAway'] for c in comp['competitors'] if c['team']['abbreviation'].lower() == team.lower()), None)
    if not side:
        return None
    tip = tip_line(g, sm, side)
    if tip is None:
        return None
    final = {c['homeAway']: int(c['score']) for c in comp['competitors']}
    fm = final[side] - final['away' if side == 'home' else 'home']
    tl = []
    for p in sm['plays']:
        per, clk = p['period']['number'], p['clock']['displayValue']
        if per > 4:
            continue
        left = ((4 - per) * 720 + secs(clk)) / 2880
        me = p['homeScore'] if side == 'home' else p['awayScore']
        op = p['awayScore'] if side == 'home' else p['homeScore']
        tl.append((left, me - op))
    return dict(g, tip=tip, final=fm, tl=tl)


def grade(line, margin):
    r = margin + line
    return 'W' if r > 0 else 'P' if r == 0 else 'L'


def run(data, k, swing):
    out = []
    for d in data:
        tip = d['tip']
        if tip >= 0:
            continue
        for left, m in d['tl']:
            if left >= 1:
                continue
            full = -(m + (-tip) * left)
            live = tip + k * (full - tip)
            if (swing > 0 and live >= tip + swing) or (swing < 0 and live <= tip + swing):
                line = round(live * 2) / 2
                r = grade(line, d['final'])
                out.append((d['season'], r, WIN if r == 'W' else 0 if r == 'P' else -100))
                break
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--team', default='bos')
    ap.add_argument('--seasons', nargs='+', type=int, default=[2025, 2026, 2027])
    ap.add_argument('--k', nargs='+', type=float, default=[1.0, 0.8, 0.7, 0.6])
    ap.add_argument('--swings', nargs='+', type=float, default=[3, 4, 5, 6, 7, 8, 9, 10, 12])
    a = ap.parse_args()
    os.makedirs(CACHE, exist_ok=True)
    games = schedule(a.team, a.seasons)
    with ThreadPoolExecutor(8) as ex:
        data = [d for d in ex.map(lambda g: load(g, a.team), games) if d]
    fav = [d for d in data if d['tip'] < 0]
    print(f"{a.team.upper()}: {len(data)} games with lines, favored at tip in {len(fav)}. $100/bet at -110, live only.\n")
    print('Swing  ' + ''.join(f'| K={k:<4}'.ljust(24) for k in a.k))
    for sw in a.swings:
        cells = []
        for k in a.k:
            rows = run(fav, k, sw)
            w = sum(r[1] == 'W' for r in rows); l = sum(r[1] == 'L' for r in rows); p = sum(r[1] == 'P' for r in rows)
            cells.append(f'| {len(rows):3d}: {w}-{l}-{p} {sum(r[2] for r in rows):+6.0f}'.ljust(24))
        print(f'{sw:+5}  ' + ''.join(cells))


if __name__ == '__main__':
    main()
