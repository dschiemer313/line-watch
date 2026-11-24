// Simulates a live game against the real worker code: real ESPN data for the game shape,
// then fake scores/lines minute by minute, a fake KV store, and a captured ntfy push.
// Run: node worker/test.mjs
import worker, { runCheck, runMinute, evaluate, parseLine, inWindow, cleanUntil, untilLabel } from './worker.js';
import assert from 'node:assert/strict';

const realFetch = globalThis.fetch;
const date = process.argv[2] || (() => { const d = new Date(Date.now() + 86400000); return d.toISOString().slice(0, 10).replace(/-/g, ''); })();

// --- fake KV ---
const kv = new Map();
const env = {
  APP_KEY: 'test-key', NTFY_TOPIC: 'test-topic',
  WATCH: {
    async get(k, type) { const v = kv.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { kv.set(k, v); writes++; },
  },
};
let writes = 0;

// --- grab a real scoreboard, then control it ---
const sb = await (await realFetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${date}`)).json();
const ev = sb.events.find(e => e.competitions[0].odds?.[0]?.pointSpread);
assert.ok(ev, 'need a game with odds on ' + date);
const comp = ev.competitions[0];
const homeC = comp.competitors.find(c => c.homeAway === 'home'), awayC = comp.competitors.find(c => c.homeAway === 'away');
console.log(`Using real game: ${ev.name} (${ev.id}), DK ${comp.odds[0].details}`);

function setGame({ state, homeScore, awayScore, homeLine, detail = 'Q2 4:12' }) {
  comp.status = { ...comp.status, period: 2, displayClock: '4:12', type: { ...comp.status.type, state, completed: state === 'post', shortDetail: detail } };
  homeC.score = String(homeScore); awayC.score = String(awayScore);
  const ps = comp.odds[0].pointSpread;
  ps.home.close.line = String(homeLine); ps.away.close.line = String(-homeLine);
}

const pushes = [];
globalThis.fetch = async (url, opts) => {
  url = String(url);
  if (url.includes('/scoreboard')) return new Response(JSON.stringify(sb));
  if (url.includes('sports.core.api.espn.com')) return new Response(JSON.stringify({ items: [] })); // no separate live provider
  if (url.includes('ntfy')) { pushes.push(JSON.parse(opts.body)); return new Response('{}'); }
  return realFetch(url, opts);  // summary (injuries) stays real
};
const call = (method, path, body) => worker.fetch(new Request('https://w.test' + path, {
  method, headers: { 'x-key': 'test-key', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env).then(r => r.json());

// Make the home team a 10-pt favorite before the game; watch it for -2 or better.
setGame({ state: 'pre', homeScore: 0, awayScore: 0, homeLine: -10, detail: '7:30 PM' });
comp.odds[0].pointSpread.home.open.line = '-10'; comp.odds[0].pointSpread.away.open.line = '+10';
ev.date = new Date(Date.now() - 3600000).toISOString(); // "started" an hour ago so every minute counts

// auth check
const unauth = await worker.fetch(new Request('https://w.test/api/watches'), env);
assert.equal(unauth.status, 401);

const w = await call('POST', '/api/watches', { league: 'nba', date, eventId: ev.id, teamId: homeC.team.id, target: -2, repeat: true });
console.log(`Watch created: ${w.teamAbbr} target ${w.target}, open ${w.openLine}, injury baseline ${w.injuryBaseline.length}`);
assert.equal(w.openLine, -10);
// pretend one listed player wasn't on the report when the watch was set, so the "NEW" flag shows
const stored = JSON.parse(kv.get('watches')); stored[0].injuryBaseline = stored[0].injuryBaseline.slice(1); kv.set('watches', JSON.stringify(stored));

const step = async (label, g) => { setGame(g); const r = await runCheck(env, { force: true }); console.log(`  ${label.padEnd(34)} → ${r.log.join(' | ')}`); return r; };

console.log('\nSimulated game:');
await step('Q1: home up 4, line -10', { state: 'in', homeScore: 20, awayScore: 16, homeLine: -10 });
await step('Q2: away 12-0 run, line -5', { state: 'in', homeScore: 30, awayScore: 34, homeLine: -5 });
assert.equal(pushes.length, 0);
await step('Q2: home down 9, line -2', { state: 'in', homeScore: 40, awayScore: 49, homeLine: -2 });
assert.equal(pushes.length, 1, 'should alert at -2');
await step('Q2: line -1.5 (still met)', { state: 'in', homeScore: 40, awayScore: 51, homeLine: -1.5 });
assert.equal(pushes.length, 1, 'no duplicate alert');
await step('Q3: home rallies, line -4', { state: 'in', homeScore: 60, awayScore: 58, homeLine: -4 });
await step('Q3: another run, line -2', { state: 'in', homeScore: 62, awayScore: 70, homeLine: -2 });
assert.equal(pushes.length, 2, 're-armed and alerted again');
await step('Final', { state: 'post', homeScore: 101, awayScore: 99, homeLine: -2, detail: 'Final' });
assert.equal(JSON.parse(kv.get('watches'))[0].status, 'done');

console.log('\nFirst alert as it would appear on the phone:\n---');
console.log(pushes[0].title + '\n' + pushes[0].message + '\n(tap opens: ' + pushes[0].click + ')\n---');

// Suspicious move: line jumps 9 but the team is only down 2
const g = { state: 'in', home: { id: '1', abbr: 'BOS', score: 50 }, away: { id: '2', abbr: 'MIA', score: 52 } };
const ev2 = evaluate({ status: 'armed', target: -2, teamId: '1', openLine: 99, baseLine: -10, pregameLine: -10 }, g, -1);
assert.ok(ev2.fire && ev2.warnings.length === 1); console.log('\nInjury-suspicion check:', ev2.warnings[0]);
// normal run: down 9 and the line moved 8 -> no warning
assert.equal(evaluate({ status: 'armed', target: -2, teamId: '1', baseLine: -10, pregameLine: -10 }, { ...g, home: { ...g.home, score: 43 } }, -2).warnings.length, 0);
const ev3 = evaluate({ status: 'armed', target: -2, teamId: '1', openLine: 99, baseLine: -10 }, { ...g, state: 'pre' }, -6);
assert.ok(!ev3.fire && ev3.warnings.length === 1); console.log('Pre-game move check:  ', ev3.warnings[0]);
assert.equal(parseLine('PK'), 0); assert.equal(parseLine('+3.5'), 3.5);

// Moneyline: "better" = bigger payout, smooth across ±100
const mw = { status: 'armed', target: 150, teamId: '1', market: 'ml', baseLine: 110, repeat: true };
assert.equal(evaluate(mw, g, 140).fire, false);
assert.equal(evaluate(mw, g, 150).fire, true);
assert.equal(evaluate(mw, g, 175).fire, true);
assert.equal(evaluate({ ...mw, target: -105 }, g, -110).fire, false);
assert.equal(evaluate({ ...mw, target: -105 }, g, 100).fire, true);
assert.equal(evaluate({ ...mw, target: -105 }, g, -105).fire, true);
assert.equal(evaluate({ ...mw, status: 'fired' }, g, 135).rearm, false);
assert.equal(evaluate({ ...mw, status: 'fired' }, g, 130).rearm, true);
assert.equal(evaluate(mw, { ...g, state: 'in' }, 200).warnings.length, 0, 'no score heuristic for moneylines');
// Negative swing: BOS opened -10, alert if it moves 2 AGAINST them (to -12 or worse)
const dw = { status: 'armed', target: -12, teamId: '1', dir: 'down', openLine: -10, repeat: true };
assert.equal(evaluate(dw, g, -10).fire, false, 'at the opener: no alert');
assert.equal(evaluate(dw, g, -11.5).fire, false);
assert.equal(evaluate(dw, g, -12).fire, true);
assert.equal(evaluate(dw, g, -14).fire, true);
assert.equal(evaluate({ ...dw, status: 'fired' }, g, -11).rearm, false);
assert.equal(evaluate({ ...dw, status: 'fired' }, g, -10.5).rearm, true);
console.log('Against-the-team (-2) checks: -10 no, -11.5 no, -12 yes, -14 yes, re-arm at -10.5');
console.log('Moneyline checks:     +140 no, +150 yes, -110 vs -105 no, EVEN vs -105 yes, re-arm at +130');

console.log(`\nKV writes during simulated game: ${writes}`);

// --- fast loop: one cron minute, line drops partway through, should alert on that pass, once ---
kv.clear(); pushes.length = 0;
setGame({ state: 'pre', homeScore: 0, awayScore: 0, homeLine: -10, detail: '7:30 PM' });
await call('POST', '/api/watches', { league: 'nba', date, eventId: ev.id, teamId: homeC.team.id, target: -2, repeat: false });
const realNow = Date.now; let clock = realNow(); Date.now = () => clock;
let fetches = 0;
const lines = [-6, -5, -4, -2, -1.5, -1, -2, -3];          // what ESPN shows on each successive check
const prevFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('/scoreboard')) { setGame({ state: 'in', homeScore: 40, awayScore: 49, homeLine: lines[Math.min(fetches++, lines.length - 1)] }); }
  return prevFetch(url, opts);
};
const passes = await runMinute(env, async ms => { clock += ms; });
Date.now = realNow; globalThis.fetch = prevFetch;
console.log(`\nFast loop: ${passes} checks in one minute (every ${Math.round(50 / (passes - 1))}s-ish); alert on check #4 of ${fetches}; pushes sent: ${pushes.length}`);
assert.ok(passes >= 6, 'should check about every 8s');
assert.equal(pushes.length, 1, 'exactly one alert even though the line stayed at/through target for several checks');

// Moneyline watch end-to-end on the real game's real moneyline data
kv.clear(); pushes.length = 0;
const mlNow = (await (await realFetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${date}`)).json())
  .events.find(e => e.id === ev.id).competitions[0].odds[0].moneyline;
comp.odds[0].moneyline = JSON.parse(JSON.stringify(mlNow));
const homeML = Number(mlNow.home.close.odds);
const mlw = await call('POST', '/api/watches', { league: 'nba', date, eventId: ev.id, teamId: homeC.team.id, target: homeML + 30, market: 'ml' });
assert.equal(mlw.market, 'ml'); assert.equal(mlw.lastLine, homeML);
setGame({ state: 'in', homeScore: 30, awayScore: 44, homeLine: -2 });
comp.odds[0].moneyline.home.close.odds = String(homeML + 10);
let r1 = await runCheck(env, { force: true });
comp.odds[0].moneyline.home.close.odds = '+250';
let r2 = await runCheck(env, { force: true });
console.log(`\nMoneyline watch: ${r1.log[0]}  →  ${r2.log[0]}`);
assert.equal(pushes.length, 1); console.log('  alert title:', pushes[0].title);
// --- swing from the tip-off line (live only) ---
for (const [swing, path, wantFireAt] of [
  [9.5, [['pre', -10], ['pre', -11], ['in', -11], ['in', -5], ['in', -1.5], ['in', -2]], 4],      // tip -11 → target -1.5
  [-2, [['pre', -10], ['pre', -10.5], ['in', -10.5], ['in', -12], ['in', -12.5]], 4],            // tip -10.5 → target -12.5
]) {
  kv.clear(); pushes.length = 0;
  setGame({ state: 'pre', homeScore: 0, awayScore: 0, homeLine: path[0][1], detail: '7:30 PM' });
  const sw = await call('POST', '/api/watches', { league: 'nba', date, eventId: ev.id, teamId: homeC.team.id, swing });
  assert.equal(sw.target, null); assert.equal(sw.dir, swing < 0 ? 'down' : 'up');
  const logs = [];
  for (let i = 0; i < path.length; i++) {
    const [state, ln] = path[i];
    setGame({ state, homeScore: 40, awayScore: 44, homeLine: ln, detail: state === 'pre' ? '7:30 PM' : 'Q2 4:12' });
    if (state === 'in') { comp.status.period = 2; comp.status.clock = 250; }
    const r = await runCheck(env, { force: true });
    logs.push(r.log.join(' | '));
    if (i + 1 < wantFireAt) assert.equal(pushes.length, 0, `no alert yet at step ${i}: ${logs.at(-1)}`);
  }
  assert.equal(pushes.length, 1, 'exactly one alert');
  const st = JSON.parse(kv.get('watches'))[0];
  console.log(`\nSwing ${swing > 0 ? '+' : ''}${swing} from tip-off: tip ${st.tipLine} → target ${st.target}`);
  logs.forEach((l, i) => console.log(`  ${path[i][0]} ${String(path[i][1]).padStart(5)}: ${l}`));
  console.log('  alert:', pushes[0].title);
}

// --- "only alert until" cutoffs ---
const at = (league, until, game) => inWindow({ league, until }, { state: 'in', ...game });
const q2 = { p: 2, left: 0 }, q2_2min = { p: 2, left: 120 };
const cases = [
  ['NBA until end of Q2', 'nba', q2, { period: 2, clockSec: 30 }, true],
  ['  halftime (Q2 0:00)', 'nba', q2, { period: 2, clockSec: 0 }, true],
  ['  Q3 11:50', 'nba', q2, { period: 3, clockSec: 710 }, false],
  ['  overtime', 'nba', q2, { period: 5, clockSec: 200 }, false],
  ['NBA until Q2 2:00 left, at 3:00', 'nba', q2_2min, { period: 2, clockSec: 180 }, true],
  ['  at 1:59', 'nba', q2_2min, { period: 2, clockSec: 119 }, false],
  ['NHL until end of P2, P2 5:00', 'nhl', q2, { period: 2, clockSec: 300 }, true],
  ['  P3 19:00', 'nhl', q2, { period: 3, clockSec: 1140 }, false],
  ['NCAAB until end of H1, H1 1:00', 'ncaab', { p: 1, left: 0 }, { period: 1, clockSec: 60 }, true],
  ['  H2 19:30', 'ncaab', { p: 1, left: 0 }, { period: 2, clockSec: 1170 }, false],
  ["Soccer until 60', at 59'", 'epl', { min: 60 }, { clock: "59'" }, true],
  ["  at 61'", 'epl', { min: 60 }, { clock: "61'" }, false],
  ['MLB until end of bot 5th, Bot 5th 2 outs', 'mlb', { inn: 5, half: 'bot', outs: 3 }, { period: 5, detail: 'Bot 5th', outs: 2 }, true],
  ['  End 5th', 'mlb', { inn: 5, half: 'bot', outs: 3 }, { period: 5, detail: 'End 5th' }, true],
  ['  Top 6th 0 outs', 'mlb', { inn: 5, half: 'bot', outs: 3 }, { period: 6, detail: 'Top 6th', outs: 0 }, false],
  ['MLB until 1 out in top 3rd, Top 3rd 0 outs', 'mlb', { inn: 3, half: 'top', outs: 1 }, { period: 3, detail: 'Top 3rd', outs: 0 }, true],
  ['  Top 3rd 1 out', 'mlb', { inn: 3, half: 'top', outs: 1 }, { period: 3, detail: 'Top 3rd', outs: 1 }, false],
];
console.log('\nCutoff checks:');
for (const [label, lg, u, gm, want] of cases) {
  assert.equal(at(lg, u, gm), want, label);
  console.log(`  ${(label + ' (' + untilLabel(lg, u) + ')').padEnd(70)} → ${want ? 'alert allowed' : 'too late'}`);
}
assert.equal(inWindow({ league: 'nba', until: q2 }, { state: 'pre' }), true, 'pre-game always allowed');
assert.deepEqual(cleanUntil('nba', { p: 9, left: 9999 }), { p: 4, left: 720 }, 'clamped to the sport');
assert.equal(cleanUntil('nba', null), null);

// Line hits target in Q3 on a "until end of Q2" watch → no alert, watch closes
kv.clear(); pushes.length = 0;
setGame({ state: 'pre', homeScore: 0, awayScore: 0, homeLine: -10, detail: '7:30 PM' });
await call('POST', '/api/watches', { league: 'nba', date, eventId: ev.id, teamId: homeC.team.id, target: -2, until: { p: 2, left: 0 } });
setGame({ state: 'in', homeScore: 50, awayScore: 52, homeLine: -5 }); comp.status.period = 2; comp.status.clock = 100;
const c1 = await runCheck(env, { force: true });
setGame({ state: 'in', homeScore: 55, awayScore: 64, homeLine: -1 }); comp.status.period = 3; comp.status.clock = 600;
const c2 = await runCheck(env, { force: true });
console.log(`\nUntil-Q2 watch: ${c1.log[0]}  →  ${c2.log[0]}`);
assert.equal(pushes.length, 0); assert.equal(JSON.parse(kv.get('watches'))[0].status, 'done');

console.log('\nALL TESTS PASSED');
