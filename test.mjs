// Simulates a live game against the real worker code: real ESPN data for the game shape,
// then fake scores/lines minute by minute, a fake KV store, and a captured ntfy push.
// Run: node worker/test.mjs
import worker, { runCheck, runMinute, evaluate, parseLine } from './worker.js';
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
console.log('\nALL TESTS PASSED');
