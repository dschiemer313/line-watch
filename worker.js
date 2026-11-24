// Line Watch — Cloudflare Worker (free plan).
// Every minute it checks the games you're watching and sends a push alert through ntfy
// when a team's spread reaches your target. Lines come from ESPN's public feed (DraftKings numbers).
//
// Cloudflare setup (see SETUP.md):
//   KV namespace bound as  WATCH
//   Secrets / variables:   APP_KEY     (any long random string; the phone app sends it)
//                          NTFY_TOPIC  (your private ntfy topic name)
//                          NTFY_SERVER (optional, default https://ntfy.sh)
//   Cron trigger:          * * * * *

const LEAGUES = {
  nba:   { path: 'basketball/nba', label: 'NBA' },
  wnba:  { path: 'basketball/wnba', label: 'WNBA' },
  ncaab: { path: 'basketball/mens-college-basketball', label: 'NCAAB', groups: '50' },
  nfl:   { path: 'football/nfl', label: 'NFL' },
  ncaaf: { path: 'football/college-football', label: 'NCAAF', groups: '80' },
};

const FAST_EVERY_SEC = 8;         // during games, re-check this often inside each 1-minute cron run
const FAST_WINDOW_SEC = 50;       // stop before the next cron run starts
const PREGAME_LEAD_MIN = 30;      // fast checks from 30 min before start
const PREGAME_EVERY_MIN = 15;     // before that, check every 15 min (catches injury-news moves)
const REARM_GAP = 1.5;            // "alert again" re-arms once the line falls this far back past the target
const MAX_HISTORY = 240;
const SUSPICIOUS_EXTRA = 3;       // line moved this many points more than the score explains -> warning

// ---------- small helpers ----------
const now = () => Date.now();
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...CORS } });
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type,x-key',
};

export function parseLine(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toUpperCase();
  if (s === 'PK' || s === 'EVEN' || s === 'PICK') return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
export const fmtLine = x => (x === null || x === undefined) ? '—' : x === 0 ? 'PK' : (x > 0 ? '+' + x : String(x));

function scoreboardUrl(league, date) {
  const L = LEAGUES[league];
  const q = new URLSearchParams({ dates: date });
  if (L.groups) q.set('groups', L.groups);
  if (L.groups) q.set('limit', '400');
  return `https://site.api.espn.com/apis/site/v2/sports/${L.path}/scoreboard?${q}`;
}
const summaryUrl = (league, id) => `https://site.api.espn.com/apis/site/v2/sports/${LEAGUES[league].path}/summary?event=${id}`;
const coreOddsUrl = (league, id) => {
  const [sport, lg] = LEAGUES[league].path.split('/');
  return `https://sports.core.api.espn.com/v2/sports/${sport}/leagues/${lg}/events/${id}/competitions/${id}/odds`;
};

async function getJSON(url, fresh = false) {
  // fresh: add a throwaway param so neither Cloudflare nor ESPN's CDN hands back an older copy
  if (fresh) url += (url.includes('?') ? '&' : '?') + '_=' + Math.floor(Date.now() / 4000);
  const r = await fetch(url, { headers: { 'user-agent': 'line-watch/1.0' }, cache: 'no-store' });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

// Turn one ESPN scoreboard event into the compact shape the app and the checker use.
export function simplifyEvent(e) {
  const c = e.competitions[0];
  const st = c.status || e.status;
  const team = side => {
    const t = c.competitors.find(x => x.homeAway === side);
    return { id: t.team.id, abbr: t.team.abbreviation, name: t.team.displayName, short: t.team.shortDisplayName || t.team.name,
             logo: t.team.logo, score: t.score !== undefined && t.score !== '' ? Number(t.score) : null };
  };
  const home = team('home'), away = team('away');
  let odds = null;
  const o = (c.odds || [])[0];
  if (o) {
    const ps = o.pointSpread || {};
    let homeCur = parseLine(ps.home?.close?.line), homeOpen = parseLine(ps.home?.open?.line);
    let awayCur = parseLine(ps.away?.close?.line), awayOpen = parseLine(ps.away?.open?.line);
    if (homeCur === null && typeof o.spread === 'number') homeCur = o.spread;
    if (awayCur === null && homeCur !== null) awayCur = -homeCur;
    if (homeOpen === null && awayOpen !== null) homeOpen = -awayOpen;
    if (awayOpen === null && homeOpen !== null) awayOpen = -homeOpen;
    let link = null;
    try {
      const href = ps.home?.close?.link?.href || o.link?.href || '';
      const pre = new URL(href).searchParams.get('preurl');
      if (pre && pre.includes('draftkings.com/event/')) link = pre.split('?')[0];
    } catch { /* no link */ }
    odds = { provider: o.provider?.name || 'Sportsbook', details: o.details || null, overUnder: o.overUnder ?? null,
             home: { cur: homeCur, open: homeOpen }, away: { cur: awayCur, open: awayOpen }, link };
  }
  return {
    id: e.id, name: e.name, shortName: e.shortName, start: e.date,
    state: st.type.state, completed: !!st.type.completed, detail: st.type.shortDetail || st.type.detail,
    period: st.period, clock: st.displayClock, home, away, odds,
  };
}

async function fetchGames(league, date, fresh = false) {
  const d = await getJSON(scoreboardUrl(league, date), fresh);
  return (d.events || []).map(simplifyEvent);
}

// During a live game ESPN sometimes lists a separate "live" provider; prefer it when present.
async function liveLineFromCore(league, eventId, isHome) {
  try {
    const d = await getJSON(coreOddsUrl(league, eventId));
    const items = d.items || [];
    const pick = items.find(i => /live/i.test(i.provider?.name || '')) || items.find(i => i.provider?.id === '100') || items[0];
    if (!pick) return null;
    const side = isHome ? pick.homeTeamOdds : pick.awayTeamOdds;
    let line = parseLine(side?.current?.pointSpread?.american ?? side?.current?.pointSpread?.alternateDisplayValue);
    if (line === null && typeof pick.spread === 'number') line = isHome ? pick.spread : -pick.spread;
    return line === null ? null : { line, provider: pick.provider?.name || 'Sportsbook', providers: items.map(i => i.provider?.name) };
  } catch { return null; }
}

async function fetchInjuries(league, eventId, teamId) {
  try {
    const s = await getJSON(summaryUrl(league, eventId));
    const t = (s.injuries || []).find(x => x.team?.id === teamId);
    return (t?.injuries || []).map(i => ({ name: i.athlete?.displayName || '?', pos: i.athlete?.position?.abbreviation || '',
      status: i.status || i.type?.description || '', what: i.details?.type || '' }));
  } catch { return null; }
}

// ---------- the decision logic (pure, tested in test.mjs) ----------
// line = the watched team's spread (negative = favored). Met when line >= target ("target or better").
export function evaluate(w, g, line) {
  const out = { met: false, fire: false, rearm: false, warnings: [] };
  if (line === null || line === undefined) return out;
  out.met = line >= w.target - 1e-9;
  if (w.status === 'armed' && out.met) out.fire = true;
  if (w.status === 'fired' && w.repeat && line <= w.target - REARM_GAP) out.rearm = true;

  const isHome = g.home.id === w.teamId;
  const me = isHome ? g.home : g.away, opp = isHome ? g.away : g.home;
  // Reference points we trust more than ESPN's "open" (which is occasionally wrong):
  // baseLine = the line when you set the watch; pregameLine = last line seen before tip-off.
  const base = w.baseLine ?? w.openLine ?? null;
  const pre = w.pregameLine ?? base;
  if (g.state === 'pre' && base !== null && line - base >= 2) {
    out.warnings.push(`Moved ${line - base} pts before tip-off. Pre-game moves are usually injury/lineup news, so check who's playing.`);
  }
  if (g.state === 'in' && pre !== null) {
    const lineGain = line - pre;                      // + = better number for the watched team
    const deficit = Math.max(0, (opp.score ?? 0) - (me.score ?? 0));
    if (lineGain > deficit + SUSPICIOUS_EXTRA) {
      out.warnings.push(`Line moved ${lineGain} pts but ${me.abbr} is only down ${deficit}. The market may know something (injury?).`);
    }
  }
  return out;
}

export function buildAlert(w, g, line, provider, injuries, warnings) {
  const isHome = g.home.id === w.teamId;
  const me = isHome ? g.home : g.away, opp = isHome ? g.away : g.home;
  const title = `${me.abbr} ${fmtLine(line)}: target hit (opened ${fmtLine(w.openLine)})`;
  const lines = [];
  if (g.state === 'in') {
    lines.push(`${me.abbr} ${me.score ?? 0} - ${opp.abbr} ${opp.score ?? 0} · ${g.detail || ''}`.trim());
  } else if (g.state === 'pre') {
    lines.push(`Pre-game · ${g.detail || ''} vs ${opp.abbr}`);
  }
  lines.push(`Your target: ${fmtLine(w.target)} or better · ${provider || 'DraftKings'} via ESPN`);
  for (const x of warnings) lines.push('⚠️ ' + x);
  if (injuries) {
    const baseline = new Set((w.injuryBaseline || []).map(i => i.name));
    const serious = injuries.filter(i => /out|doubt|question|day-to-day/i.test(i.status));
    const fresh = serious.filter(i => !baseline.has(i.name));
    if (fresh.length) lines.push('🚑 NEW since you set this: ' + fresh.map(i => `${i.name} (${i.status})`).join(', '));
    const known = serious.filter(i => baseline.has(i.name));
    lines.push(known.length ? 'Injury report: ' + known.slice(0, 4).map(i => `${i.name} (${i.status})`).join(', ') : 'Injury report: nothing listed for ' + me.abbr);
  }
  lines.push('ESPN lines can lag the book by up to a minute. Confirm in DraftKings.');
  return { title, message: lines.join('\n'), click: g.odds?.link || 'https://sportsbook.draftkings.com/' };
}

async function notify(env, { title, message, click, priority = 5, tags = ['rotating_light'] }) {
  if (!env.NTFY_TOPIC) throw new Error('NTFY_TOPIC not set');
  const server = (env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
  const r = await fetch(server + '/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: env.NTFY_TOPIC, title, message, priority, tags, click }),
  });
  if (!r.ok) throw new Error('ntfy ' + r.status + ' ' + (await r.text()).slice(0, 200));
}

// ---------- storage ----------
const loadWatches = async env => (await env.WATCH.get('watches', 'json')) || [];
const saveWatches = (env, list) => env.WATCH.put('watches', JSON.stringify(list));

// ---------- the minute-by-minute check ----------
// memo: changes made earlier in this same cron run (KV can be a moment behind its own writes,
// and we must never send the same alert twice). pass: 0 for the first check of the minute.
export async function runCheck(env, { force = false, memo = new Map(), pass = 0 } = {}) {
  const log = [];
  const watches = (await loadWatches(env)).map(w => memo.has(w.id) ? { ...w, ...memo.get(w.id) } : w);
  const active = watches.filter(w => w.status !== 'done');
  if (!active.length) return { log: ['no active watches'], changed: 0, fast: false };

  const t = now();
  const minute = Math.floor(t / 60000);
  const isFast = w => t >= Date.parse(w.start) - PREGAME_LEAD_MIN * 60000;
  const due = active.filter(w => force || isFast(w) || (pass === 0 && minute % PREGAME_EVERY_MIN === 0));
  const fast = active.some(isFast);
  if (!due.length) return { log: ['nothing due this minute'], changed: 0, fast };

  // One scoreboard call per league+date covers every watched game in it.
  const boards = {};
  for (const w of due) {
    const k = w.league + '|' + w.date;
    if (!boards[k]) boards[k] = fetchGames(w.league, w.date, true).catch(e => { log.push('scoreboard error ' + e.message); return []; });
  }

  const updates = new Map();
  for (const w of due) {
    const games = await boards[w.league + '|' + w.date];
    const g = games.find(x => x.id === w.eventId);
    if (!g) { log.push(`${w.teamAbbr}: game not on scoreboard`); continue; }
    const u = {};
    if (g.state === 'post' || g.completed) {
      u.status = 'done'; u.final = `${g.away.abbr} ${g.away.score} - ${g.home.abbr} ${g.home.score}`;
      updates.set(w.id, u); log.push(`${w.teamAbbr}: final, watch closed`); continue;
    }
    const isHome = g.home.id === w.teamId;
    let line = g.odds ? (isHome ? g.odds.home.cur : g.odds.away.cur) : null;
    let provider = g.odds?.provider || null;
    // The scoreboard (refreshed every ~7s) is the main source. Once a minute, see whether ESPN also
    // lists a dedicated live-odds provider; use it only if it exists (that feed is cached longer).
    if (g.state === 'in' && pass === 0) {
      const live = await liveLineFromCore(w.league, w.eventId, isHome);
      if (live && /live/i.test(live.provider)) { line = live.line; provider = live.provider; }
    }
    if (line === null) { log.push(`${w.teamAbbr}: no line posted (often pulled during reviews/timeouts)`); continue; }

    if (w.openLine === null || w.openLine === undefined) {
      const o = g.odds ? (isHome ? g.odds.home.open : g.odds.away.open) : null;
      u.openLine = o ?? line;
    }
    const wNow = { ...w, ...u };
    const ev = evaluate(wNow, g, line);
    const me = isHome ? g.home : g.away, opp = isHome ? g.away : g.home;

    if (line !== w.lastLine) {
      const hist = (w.history || []).concat([[t, line, me.score, opp.score, g.state === 'in' ? g.detail : g.state]]);
      u.history = hist.slice(-MAX_HISTORY);
      u.lastLine = line; u.lastLineAt = t; u.provider = provider;
      if (g.state === 'pre') u.pregameLine = line;
    }
    if (ev.fire) {
      const injuries = await fetchInjuries(w.league, w.eventId, w.teamId);
      const alert = buildAlert(wNow, g, line, provider, injuries, ev.warnings);
      try {
        await notify(env, alert);
        u.status = 'fired'; u.firedAt = t; u.firedLine = line; u.lastAlert = alert;
        log.push(`${w.teamAbbr}: ALERT sent at ${fmtLine(line)}`);
      } catch (e) { log.push(`${w.teamAbbr}: alert failed ${e.message}`); }
    } else if (ev.rearm) {
      u.status = 'armed'; log.push(`${w.teamAbbr}: re-armed (line back to ${fmtLine(line)})`);
    } else {
      log.push(`${w.teamAbbr}: ${fmtLine(line)} (target ${fmtLine(w.target)}) ${w.status}`);
    }
    if (Object.keys(u).length) updates.set(w.id, u);
  }

  // Re-read before writing so edits made from the phone during this run aren't lost.
  if (updates.size) {
    for (const [id, u] of updates) memo.set(id, { ...(memo.get(id) || {}), ...u });
    const fresh = await loadWatches(env);
    for (const w of fresh) if (memo.has(w.id)) Object.assign(w, memo.get(w.id));
    await saveWatches(env, fresh);
  }
  // Heartbeat so the app can show the watcher is alive (≤ 1 write / 15 min to stay inside KV free limits).
  if (force || (pass === 0 && minute % 15 === 0)) await env.WATCH.put('heartbeat', JSON.stringify({ at: t, log }));
  return { log, changed: updates.size, fast };
}

// Cron fires once a minute; during games keep re-checking every few seconds until just before the next run.
export async function runMinute(env, sleep = ms => new Promise(r => setTimeout(r, ms))) {
  const start = now(), memo = new Map();
  let pass = 0, r;
  do {
    r = await runCheck(env, { memo, pass });
    pass++;
    if (!r.fast) break;
    const wait = start + pass * FAST_EVERY_SEC * 1000 - now();
    if (now() + Math.max(wait, 0) > start + FAST_WINDOW_SEC * 1000) break;
    if (wait > 0) await sleep(wait);
  } while (true);
  return pass;
}

// ---------- HTTP API for the phone app ----------
async function createWatch(env, body) {
  const { league, eventId, teamId, target, repeat = false, date } = body;
  if (!LEAGUES[league]) throw new Error('unknown league');
  if (typeof target !== 'number' || !Number.isFinite(target)) throw new Error('target must be a number');
  const games = await fetchGames(league, date);
  const g = games.find(x => x.id === String(eventId));
  if (!g) throw new Error('game not found for that date');
  const isHome = g.home.id === String(teamId);
  if (!isHome && g.away.id !== String(teamId)) throw new Error('team not in that game');
  const me = isHome ? g.home : g.away, opp = isHome ? g.away : g.home;
  const cur = g.odds ? (isHome ? g.odds.home.cur : g.odds.away.cur) : null;
  const open = g.odds ? (isHome ? g.odds.home.open : g.odds.away.open) : null;
  const injuries = await fetchInjuries(league, g.id, me.id);
  const w = {
    id: crypto.randomUUID().slice(0, 8), league, date, eventId: g.id, start: g.start,
    teamId: me.id, teamAbbr: me.abbr, teamName: me.name, oppAbbr: opp.abbr, isHome,
    target, repeat: !!repeat, status: 'armed', created: now(),
    openLine: open ?? cur, baseLine: cur, pregameLine: g.state === 'pre' ? cur : (open ?? cur), lastLine: cur, lastLineAt: now(), provider: g.odds?.provider || null,
    history: cur === null ? [] : [[now(), cur, me.score, opp.score, g.state === 'in' ? g.detail : g.state]],
    injuryBaseline: (injuries || []).filter(i => /out|doubt|question|day-to-day/i.test(i.status)),
  };
  const list = await loadWatches(env);
  list.push(w);
  await saveWatches(env, list);
  return w;
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, '');
    if (p === '' || p === '/') return json({ ok: true, app: 'line-watch' });
    if (!env.APP_KEY || req.headers.get('x-key') !== env.APP_KEY) return json({ error: 'bad or missing key' }, 401);
    try {
      if (p === '/api/games' && req.method === 'GET') {
        const league = url.searchParams.get('league') || 'nba';
        return json(await fetchGames(league, url.searchParams.get('date')));
      }
      if (p === '/api/watches' && req.method === 'GET') {
        return json({ watches: await loadWatches(env), heartbeat: await env.WATCH.get('heartbeat', 'json') });
      }
      if (p === '/api/watches' && req.method === 'POST') return json(await createWatch(env, await req.json()));
      const m = p.match(/^\/api\/watches\/([\w-]+)$/);
      if (m && req.method === 'PATCH') {
        const body = await req.json();
        const list = await loadWatches(env);
        const w = list.find(x => x.id === m[1]);
        if (!w) return json({ error: 'not found' }, 404);
        if (typeof body.target === 'number') w.target = body.target;
        if (typeof body.repeat === 'boolean') w.repeat = body.repeat;
        if (body.status === 'armed') w.status = 'armed';
        await saveWatches(env, list);
        return json(w);
      }
      if (m && req.method === 'DELETE') {
        await saveWatches(env, (await loadWatches(env)).filter(x => x.id !== m[1]));
        return json({ ok: true });
      }
      if (p === '/api/test' && req.method === 'POST') {
        await notify(env, { title: 'Line Watch test 🏀', message: 'Alerts are working. This is what a line alert will look like.', click: 'https://sportsbook.draftkings.com/' });
        return json({ ok: true });
      }
      if (p === '/api/check' && req.method === 'POST') return json(await runCheck(env, { force: true }));
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: e.message }, 400);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMinute(env).catch(e => console.log('check failed', e.message)));
  },
};
