"""Measure how far real DraftKings live spreads move, from CSVs downloaded in Line Watch (Setup → Record live lines).

For every live moment where a team that was favored at tip has fallen behind its expected pace, compare:
    real move   = live spread - tip spread                       (what DraftKings actually did)
    full move   = point-for-point estimate - tip spread          (textbook model, K = 1)
K = real move / full move. K < 1 means the book keeps giving the favorite credit; K = 1 means point-for-point.

Usage:
    python calibrate.py live-lines-nba-20261124.csv [more.csv ...]
Then:
    python backtest.py --team bos --k <the K printed below>
"""
import csv, sys, statistics as st
from collections import defaultdict

QLEN, PERIODS = 720, 4            # NBA


def load(paths):
    games = defaultdict(list)
    finals = {}
    for p in paths:
        for r in csv.DictReader(open(p, encoding='utf-8')):
            key = (r['date'], r['game_id'])
            num = lambda v: float(v) if v not in ('', None) else None
            games[key].append(dict(period=int(r['period']), clock=num(r['clock_sec']), hs=num(r['home_score']),
                                   as_=num(r['away_score']), spread=num(r['home_spread']), name=r['game']))
            if r.get('final_home'):
                finals[key] = (num(r['final_home']), num(r['final_away']))
    return games, finals


def main(paths):
    games, finals = load(paths)
    ratios = defaultdict(list)
    live_moves, frozen = 0, 0
    for key, pts in games.items():
        pre = [p for p in pts if p['period'] == 0 and p['spread'] is not None]
        live = [p for p in pts if p['period'] >= 1 and p['spread'] is not None and p['clock'] is not None]
        if not pre or not live:
            continue
        tip = pre[-1]['spread']                             # home spread at tip-off
        if len({p['spread'] for p in live}) > 1:
            live_moves += 1
        else:
            frozen += 1
        for p in live:
            if p['period'] > PERIODS:
                continue
            left = ((PERIODS - p['period']) * QLEN + p['clock']) / (PERIODS * QLEN)
            if left < 0.08 or left > 0.98:
                continue
            for side, sgn in (('home', 1), ('away', -1)):
                t = tip * sgn                               # this side's tip spread
                if t >= -2:
                    continue                                # only teams favored by 2+ at tip
                margin = (p['hs'] - p['as_']) * sgn
                full = -(margin + (-t) * left)
                real = p['spread'] * sgn
                if full - t >= 3:                           # favorite has fallen behind its pace by 3+
                    q = 'Q1' if left > .75 else 'Q2' if left > .5 else 'Q3' if left > .25 else 'Q4'
                    ratios[q].append((real - t) / (full - t))
    print(f"Games recorded: {len(games)}.  Live spread changed during the game in {live_moves}; frozen in {frozen}.")
    if frozen and not live_moves:
        print("ESPN's feed did not update DraftKings' line during games, so it can't be used for live lines.")
        return
    allr = [x for v in ratios.values() for x in v]
    if not allr:
        print("Not enough moments where a favorite fell behind yet. Record more games."); return
    print("\nShare of a point-for-point move that DraftKings actually made (K), favorite behind its pace:")
    for q in ('Q1', 'Q2', 'Q3', 'Q4'):
        r = ratios.get(q)
        if r:
            print(f"  {q}: K = {st.median(r):.2f}   ({len(r)} moments)")
    print(f"  Overall: K = {st.median(allr):.2f}  →  python backtest.py --team bos --k {st.median(allr):.2f}")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(1)
    main(sys.argv[1:])
