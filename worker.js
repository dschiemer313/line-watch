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
  nhl:   { path: 'hockey/nhl', label: 'NHL' },
  nfl:   { path: 'football/nfl', label: 'NFL' },
  ncaab: { path: 'basketball/mens-college-basketball', label: 'NCAAB', groups: '50' },
  ncaaf: { path: 'football/college-football', label: 'NCAAF', groups: '80' },
  mlb:   { path: 'baseball/mlb', label: 'MLB' },
  wnba:  { path: 'basketball/wnba', label: 'WNBA' },
  mls:   { path: 'soccer/usa.1', label: 'MLS' },
  epl:   { path: 'soccer/eng.1', label: 'EPL' },
};

// Regulation structure, for "only alert until <point in the game>".
// clock = countdown periods (len in minutes); minute = soccer match minute; baseball = inning/half/outs.
export const GAME_CLOCK = {
  nba: { kind: 'clock', periods: 4, len: 12, tag: 'Q' }, wnba: { kind: 'clock', periods: 4, len: 10, tag: 'Q' },
  ncaab: { kind: 'clock', periods: 2, len: 20, tag: 'H' }, nfl: { kind: 'clock', periods: 4, len: 15, tag: 'Q' },
  ncaaf: { kind: 'clock', periods: 4, len: 15, tag: 'Q' }, nhl: { kind: 'clock', periods: 3, len: 20, tag: 'P' },
  mls: { kind: 'minute' }, epl: { kind: 'minute' }, mlb: { kind: 'baseball' },
};
const ord = n => n + ([11, 12, 13].includes(n % 100) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'));
const mmss = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
export function untilLabel(league, u) {
  if (!u) return 'any time';
  const c = GAME_CLOCK[league] || {};
  if (c.kind === 'clock') return u.left ? `${c.tag}${u.p} with ${mmss(u.left)} left` : `end of ${c.tag}${u.p}`;
  if (c.kind === 'minute') return `${u.min}' (match minute)`;
  if (c.kind === 'baseball') return u.outs >= 3 ? `end of ${u.half === 'top' ? 'top' : 'bottom'} ${ord(u.inn)}`
    : u.outs === 0 ? `start of ${u.half === 'top' ? 'top' : 'bottom'} ${ord(u.inn)}` : `${u.outs} out${u.outs === 1 ? '' : 's'} in the ${u.half === 'top' ? 'top' : 'bottom'} ${ord(u.inn)}`;
  return '?';
}
// How far into the game we are, in the same units as cutoffOf(). null = can't tell.
export function progressOf(league, g) {
  const c = GAME_CLOCK[league];
  if (!c || g.state !== 'in') return null;
  if (c.kind === 'clock') {
    if (!g.period) return null;
    if (g.period > c.periods) return Infinity;                       // overtime
    const left = typeof g.clockSec === 'number' ? g.clockSec : null;
    return (g.period - 1) * c.len * 60 + (left === null ? 0 : Math.max(0, c.len * 60 - left));
  }
  if (c.kind === 'minute') {
    const m = parseInt(String(g.clock || ''), 10);
    if (Number.isFinite(m)) return m;
    return typeof g.clockSec === 'number' ? Math.floor(g.clockSec / 60) : null;
  }
  if (c.kind === 'baseball') {
    const inn = g.period, d = String(g.detail || '');
    if (!inn) return null;
    const outs = typeof g.outs === 'number' ? g.outs : 0;
    if (/^mid/i.test(d)) return (inn - 1) * 6 + 3;
    if (/^end/i.test(d)) return inn * 6;
    // + 0.5: a half-inning in progress is past the moment its last out was recorded
    if (/^bot/i.test(d)) return (inn - 1) * 6 + 3 + outs + 0.5;
    return (inn - 1) * 6 + outs + 0.5;                                // top of the inning
  }
  return null;
}
export function cutoffOf(league, u) {
  const c = GAME_CLOCK[league];
  if (!c || !u) return Infinity;
  if (c.kind === 'clock') return (u.p - 1) * c.len * 60 + (c.len * 60 - (u.left || 0));
  if (c.kind === 'minute') return u.min;
  if (c.kind === 'baseball') return (u.inn - 1) * 6 + (u.half === 'top' ? 0 : 3) + Math.min(u.outs ?? 3, 3);
  return Infinity;
}
// true = still inside the window (pre-game always counts); false = past the cutoff.
export function inWindow(w, g) {
  if (!w.until || g.state === 'pre') return true;
  const p = progressOf(w.league, g);
  if (p === null) return true;               // unknown clock: don't block the alert
  return p <= cutoffOf(w.league, w.until);
}

// Two kinds of alert: point spread, or moneyline (American odds). "Better" always means a bigger payout
// for the team you'd bet on. Moneylines compare on a cents scale so -110 → -105 → +100 → +110 is smooth.
const REARM_GAP_ML = 20;          // moneyline re-arm gap, in cents
export const scale = (x, market) => market === 'ml' ? (x >= 100 ? x - 100 : x <= -100 ? x + 100 : 0) : x;
export const unscale = (s, market) => market === 'ml' ? (s >= 0 ? s + 100 : s - 100) : s;
// "Swing" watches: target = line at tip-off + swing (negative = moves against the team). Live only.
export const fromSwing = (base, swing, market) => unscale(scale(base, market) + swing, market);
export const fmtVal = (x, market) => market !== 'ml' ? fmtLine(x)
  : (x === null || x === undefined) ? '—' : (x > 0 ? '+' + x : String(x));

const FAST_EVERY_SEC = 4;         // during games, re-check this often inside each 1-minute cron run (slows itself
                                  // down automatically if many watched games would exceed the free plan's request limit)
const RUN_BUDGET = 46;            // free plan: 50 outbound requests per run, keep a few spare for the push alert
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

// Cloudflare's free plan allows 50 outbound requests per run. runMinute sets a budget (alerts are checked
// before recording, so they get first claim) and resets these per-pass caches so a feed is fetched once per pass.
let BUDGET = Infinity;
const PASS_CACHE = new Map();
export function newPass() { PASS_CACHE.clear(); }
export function setBudget(n) { BUDGET = n; }
export const budgetLeft = () => BUDGET;
const cached = (key, fn) => { if (!PASS_CACHE.has(key)) PASS_CACHE.set(key, fn()); return PASS_CACHE.get(key); };

async function getJSON(url, fresh = false) {
  if (BUDGET-- <= 0) throw new Error('request budget for this minute used up');
  // fresh: add a throwaway param so neither Cloudflare nor ESPN's CDN hands back an older copy
  // (ESPN caches the live-odds feed for up to 4 minutes otherwise)
  if (fresh) url += (url.includes('?') ? '&' : '?') + '_=' + Math.floor(Date.now() / 2000);
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
    const mlRaw = o.moneyline || {};
    const ml = side => {
      const f = v => { const n = parseLine(v); return n === 0 ? 100 : n; };   // "EVEN" = +100
      return { cur: f(mlRaw[side]?.close?.odds), open: f(mlRaw[side]?.open?.odds) };
    };
    let link = null;
    try {
      const href = ps.home?.close?.link?.href || o.link?.href || '';
      const pre = new URL(href).searchParams.get('preurl');
      if (pre && pre.includes('draftkings.com/event/')) link = pre.split('?')[0];
    } catch { /* no link */ }
    odds = { provider: o.provider?.name || 'Sportsbook', details: o.details || null, overUnder: o.overUnder ?? null,
             home: { cur: homeCur, open: homeOpen, ml: ml('home') }, away: { cur: awayCur, open: awayOpen, ml: ml('away') }, link };
  }
  return {
    id: e.id, name: e.name, shortName: e.shortName, start: e.date,
    state: st.type.state, completed: !!st.type.completed, detail: st.type.shortDetail || st.type.detail,
    period: st.period, clock: st.displayClock, clockSec: typeof st.clock === 'number' ? st.clock : null,
    outs: typeof c.situation?.outs === 'number' ? c.situation.outs : null, home, away, odds,
  };
}

// ---------- The Odds API fallback (free tier) ----------
// Official odds API that allows server requests. Free tier ≈ 500 credits/month, 1 credit per market per call,
// one call covers every game in a league. Used only for live watched games when ESPN's feed is refused,
// and spaced out (every OA_EVERY_MIN minutes, slower when the month's credits run low) so the quota lasts.
const OA_SPORT = { nba: 'basketball_nba', ncaab: 'basketball_ncaab', nfl: 'americanfootball_nfl', ncaaf: 'americanfootball_ncaaf',
  nhl: 'icehockey_nhl', mlb: 'baseball_mlb', wnba: 'basketball_wnba', mls: 'soccer_usa_mls', epl: 'soccer_epl' };
const OA_EVERY_MIN = 2;
const OA_MEM = new Map();
const normName = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export async function oddsApi(env, league, markets) {
  if (!env.ODDS_API_KEY || !OA_SPORT[league]) return null;
  const key = `oa:${league}`;
  let st = OA_MEM.get(key) || (await env.WATCH.get(key, 'json'));
  const left = st?.remaining ?? 500;
  const every = left < 10 ? Infinity : left < 60 ? 10 : OA_EVERY_MIN;       // stretch the quota when it's low
  const fresh = st && now() - st.at < every * 60000 && markets.split(',').every(x => (st.markets || '').split(',').includes(x));
  if (fresh || left < 10) { if (st) OA_MEM.set(key, st); return st; }
  if (BUDGET-- <= 0) return st;
  const url = `https://api.the-odds-api.com/v4/sports/${OA_SPORT[league]}/odds?apiKey=${encodeURIComponent(env.ODDS_API_KEY)}`
    + `&regions=us&bookmakers=draftkings&markets=${markets}&oddsFormat=american`;
  try {
    const r = await fetch(url);
    const remaining = Number(r.headers.get('x-requests-remaining'));
    if (!r.ok) {
      st = { ...(st || {}), at: now(), markets, error: `${r.status}`, remaining: Number.isFinite(remaining) ? remaining : st?.remaining ?? null };
    } else {
      const events = await r.json();
      st = { at: now(), markets, error: null, remaining: Number.isFinite(remaining) ? remaining : null,
        events: events.map(e => {
          const dk = (e.bookmakers || [])[0];
          const mk = k => (dk?.markets || []).find(x => x.key === k)?.outcomes || [];
          return { home: e.home_team, away: e.away_team, start: e.commence_time, updated: dk?.last_update || null,
            spreads: Object.fromEntries(mk('spreads').map(o => [normName(o.name), o.point])),
            ml: Object.fromEntries(mk('h2h').map(o => [normName(o.name), o.price])) };
        }) };
    }
  } catch (e) { st = { ...(st || {}), at: now(), markets, error: e.message }; }
  OA_MEM.set(key, st);
  await env.WATCH.put(key, JSON.stringify(st));
  return st;
}
// Fill g.odds from an Odds API snapshot (matched by team names). Returns false if the game isn't in it.
export function attachOddsApi(st, g) {
  const hn = normName(g.home.name), an = normName(g.away.name);
  const same = (a, b) => a === b || a.includes(b) || b.includes(a);
  const e = (st?.events || []).find(x => same(normName(x.home), hn) && same(normName(x.away), an));
  if (!e) return false;
  const side = (t) => { const k = normName(t); const s = e.spreads[k] ?? null; const m = e.ml[k] ?? null;
    return { cur: s, open: null, tip: null, ml: { cur: m === 0 ? 100 : m, open: null, tip: null } }; };
  g.odds = { ...(g.odds || {}), provider: 'DraftKings via The Odds API', live: true, viaOddsApi: true,
    updated: e.updated, home: side(e.home), away: side(e.away) };
  return g.odds.home.cur !== null || g.odds.home.ml.cur !== null;
}

// The watched team's number for a market: which = 'cur' or 'open'.
export function pickLine(g, isHome, market, which = 'cur') {   // which: 'cur' | 'open' | 'tip'
  const side = g.odds?.[isHome ? 'home' : 'away'];
  if (!side) return null;
  return (market === 'ml' ? side.ml?.[which] : side[which]) ?? null;
}

async function fetchGames(league, date, fresh = false) {
  const go = async () => (await getJSON(scoreboardUrl(league, date), fresh)).events?.map(simplifyEvent) || [];
  return fresh ? cached(`sb|${league}|${date}`, go) : go();
}

// ESPN drops odds from the scoreboard once a game starts. The live line is in the odds feed under a
// separate provider ("DraftKings - Live Odds"); the regular provider there holds the pre-game (tip-off) line.
function oddsSide(it, home) {
  const t = (home ? it?.homeTeamOdds : it?.awayTeamOdds) || {};
  const sp = (o) => parseLine(o?.pointSpread?.american ?? o?.pointSpread?.alternateDisplayValue);
  const ml = (o, fallback) => { const v = parseLine(o?.moneyLine?.american ?? fallback); return v === 0 ? 100 : v; };
  return { spread: sp(t.current), open: sp(t.open), ml: ml(t.current, t.moneyLine), mlOpen: ml(t.open) };
}
export async function coreOdds(league, eventId) {
  return cached(`core|${league}|${eventId}`, async () => {
    const d = await getJSON(coreOddsUrl(league, eventId), true);
    const items = d.items || [];
    const live = items.find(i => /live/i.test(i.provider?.name || ''));
    const pre = items.find(i => i.provider?.id === '100') || items.find(i => !/live/i.test(i.provider?.name || ''));
    const pack = it => it && { provider: it.provider?.name || 'Sportsbook', home: oddsSide(it, true), away: oddsSide(it, false) };
    return { live: pack(live), pre: pack(pre) };
  });
}
// ESPN refuses its live-odds feed to Cloudflare's servers (403). Once seen in a run, stop asking (saves requests).
let ESPN_BLOCKED = false;
export function resetEspnBlocked() { ESPN_BLOCKED = false; }

// Fill g.odds for a live game from the live feed: cur = live number, tip = pre-game (closing) number.
export async function attachLiveOdds(league, g) {
  if (ESPN_BLOCKED) return false;
  let co;
  try { co = await coreOdds(league, g.id); }
  catch (e) { if (/\b403\b/.test(e.message)) ESPN_BLOCKED = true; throw e; }
  if (!co.live) return false;
  const side = s => ({
    cur: co.live[s].spread, open: co.pre?.[s].open ?? g.odds?.[s]?.open ?? null, tip: co.pre?.[s].spread ?? null,
    ml: { cur: co.live[s].ml, open: co.pre?.[s].mlOpen ?? null, tip: co.pre?.[s].ml ?? null },
  });
  g.odds = { ...(g.odds || {}), provider: co.live.provider, live: true, home: side('home'), away: side('away') };
  return true;
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
// line = the watched team's spread (negative = favored) or moneyline. Met when line is target or better.
export function evaluate(w, g, line) {
  const out = { met: false, fire: false, rearm: false, warnings: [] };
  if (line === null || line === undefined) return out;
  const m = w.market || 'spread', s = x => scale(x, m);
  const gap = m === 'ml' ? REARM_GAP_ML : REARM_GAP;
  // dir 'down' = alert when the line moves AGAINST the team (target or worse)
  const down = w.dir === 'down';
  out.met = down ? s(line) <= s(w.target) + 1e-9 : s(line) >= s(w.target) - 1e-9;
  if (w.status === 'armed' && out.met) out.fire = true;
  if (w.status === 'fired' && w.repeat && (down ? s(line) >= s(w.target) + gap : s(line) <= s(w.target) - gap)) out.rearm = true;
  if (down) return out;   // the injury heuristics below are about a team's number getting better

  const isHome = g.home.id === w.teamId;
  const me = isHome ? g.home : g.away, opp = isHome ? g.away : g.home;
  // Reference points we trust more than ESPN's "open" (which is occasionally wrong):
  // baseLine = the line when you set the watch; pregameLine = last line seen before tip-off.
  const base = w.baseLine ?? w.openLine ?? null;
  const pre = w.pregameLine ?? base;
  if (m === 'ml') {
    if (g.state === 'pre' && base !== null && s(line) - s(base) >= 40) {
      out.warnings.push(`Moneyline moved from ${fmtVal(base, m)} to ${fmtVal(line, m)} before the game. Pre-game moves are usually injury/lineup news (in hockey, often the starting goalie).`);
    }
    return out;   // the score-vs-line check only makes sense for point spreads
  }
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
  const m = w.market || 'spread', ml = m === 'ml' ? ' ML' : '';
  const title = typeof w.swing === 'number' && w.tipLine != null
    ? `${me.abbr} ${fmtVal(line, m)}${ml}: moved ${w.swing > 0 ? '+' : ''}${w.swing}${m === 'ml' ? '¢' : ''} from ${w.from === 'now' ? '' : 'tip-off '}${fmtVal(w.tipLine, m)}${w.from === 'now' ? ' (when you set it)' : ''}`
    : `${me.abbr} ${fmtVal(line, m)}${ml}: target hit (opened ${fmtVal(w.openLine, m)})`;
  const lines = [];
  if (g.state === 'in') {
    lines.push(`${me.abbr} ${me.score ?? 0} - ${opp.abbr} ${opp.score ?? 0} · ${g.detail || ''}`.trim());
  } else if (g.state === 'pre') {
    lines.push(`Pre-game · ${g.detail || ''} vs ${opp.abbr}`);
  }
  lines.push(`Your target: ${fmtVal(w.target, m)}${ml} or ${w.dir === 'down' ? 'worse' : 'better'}${w.until ? ` (until ${untilLabel(w.league, w.until)})` : ''} · ${provider || 'DraftKings'} via ESPN`);
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
  newPass();                                       // fresh feeds for every check (the recorder reuses them this pass)
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
    if (!inWindow(w, g)) {
      u.status = 'done'; u.final = `Window closed: past ${untilLabel(w.league, w.until)}`;
      updates.set(w.id, u); log.push(`${w.teamAbbr}: past ${untilLabel(w.league, w.until)}, watch closed`); continue;
    }
    const isHome = g.home.id === w.teamId;
    const m = w.market || 'spread';
    // Live games: the scoreboard has no odds. Try ESPN's live feed; if it's refused, use The Odds API (spaced out).
    if (g.state === 'in') {
      let ok = false;
      try { ok = await attachLiveOdds(w.league, g); } catch (e) { if (pass === 0) log.push(`${w.teamAbbr}: ESPN live feed ${e.message.split(' ')[0]}`); }
      if (!ok) {
        const mk = active.some(x => x.league === w.league && x.market === 'ml') ? 'spreads,h2h' : 'spreads';
        const st = await oddsApi(env, w.league, mk);
        if (st && attachOddsApi(st, g)) ok = true;
        else if (pass === 0) log.push(`${w.teamAbbr}: ${env.ODDS_API_KEY ? `Odds API ${st?.error ? 'error ' + st.error : 'has no line'}` : 'no ODDS_API_KEY set'}`);
      }
    }
    const line = pickLine(g, isHome, m);
    const provider = g.odds?.provider || null;
    if (line === null) { log.push(`${w.teamAbbr}: no line posted (books pull it during reviews/timeouts)`); continue; }

    if (w.openLine === null || w.openLine === undefined) {
      u.openLine = pickLine(g, isHome, m, 'open') ?? line;
    }
    const isSwing = typeof w.swing === 'number';
    // Swing watch: at the first live check, lock in the tip-off line (last pre-game line seen) and set the target.
    if (isSwing && g.state === 'in' && (w.tipLine === null || w.tipLine === undefined)) {
      u.tipLine = w.pregameLine ?? pickLine(g, isHome, m, 'tip') ?? line;
      u.target = fromSwing(u.tipLine, w.swing, m);
      log.push(`${w.teamAbbr}: tip-off line ${fmtVal(u.tipLine, m)} → target ${fmtVal(u.target, m)}`);
    }
    const wNow = { ...w, ...u };
    const ev = isSwing && g.state !== 'in' ? { fire: false, rearm: false, warnings: [] }   // swing watches are live-only
      : evaluate(wNow, g, line);
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
        log.push(`${w.teamAbbr}: ALERT sent at ${fmtVal(line, m)}`);
      } catch (e) { log.push(`${w.teamAbbr}: alert failed ${e.message}`); }
    } else if (ev.rearm) {
      u.status = 'armed'; log.push(`${w.teamAbbr}: re-armed (line back to ${fmtVal(line, m)})`);
    } else {
      log.push(`${w.teamAbbr}${m === 'ml' ? ' ML' : ''}: ${fmtVal(line, m)} (target ${isSwing && wNow.target == null
        ? `tip-off ${w.swing > 0 ? '+' : ''}${w.swing}` : fmtVal(wNow.target, m)}) ${w.status}`);
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
  const start = now(), memo = new Map(), rec = { books: {}, dirty: new Set(), rr: 0 };
  resetEspnBlocked();                              // re-test ESPN once per minute in case it lets us back in
  let pass = 0, r, every = FAST_EVERY_SEC * 1000, next = start;
  setBudget(RUN_BUDGET);
  do {
    const before = budgetLeft();
    r = await runCheck(env, { memo, pass });
    const alertCost = before - budgetLeft();         // requests one alert check needs (scoreboard + live feeds)
    // Pace so the alert checks alone can run all minute inside the budget: 4 s with 1-2 live watches, slower with more.
    if (pass === 0 && alertCost > 0) {
      const passesAffordable = Math.max(1, Math.floor(RUN_BUDGET / alertCost));
      every = Math.max(FAST_EVERY_SEC * 1000, Math.ceil(FAST_WINDOW_SEC * 1000 / passesAffordable));
    }
    // The recorder only gets requests the remaining alert checks this minute won't need.
    rec.reserve = alertCost * Math.max(0, Math.ceil((start + FAST_WINDOW_SEC * 1000 - now()) / every) - 1);
    const recLive = await recordPass(env, rec).catch(e => { console.log('record failed', e.message); return false; });
    pass++;
    if (!r.fast && !recLive) break;
    next += every;
    const wait = next - now();
    if (now() + Math.max(wait, 0) > start + FAST_WINDOW_SEC * 1000) break;
    if (wait > 0) await sleep(wait);
  } while (true);
  // One KV write per recorded league-day per minute, only if something changed (stays inside free KV limits).
  for (const key of rec.dirty) await env.WATCH.put(key, JSON.stringify(rec.books[key]));
  setBudget(Infinity);
  return pass;
}

// ---------- live-line recorder ----------
// For every game in the chosen leagues, saves each change in DraftKings' line or the score, with the clock:
// point = [time, period (0 = pre-game), clock seconds, home score, away score, home spread, home ML, away ML].
// Used to measure how far real live lines move when a team falls behind (see worker/calibrate.py).
const MAX_POINTS = 3000;
const REC_LIVE_PER_PASS = 4;      // live games whose live line is fetched per pass (rotates; keeps inside the request budget)
const etParts = t => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric',
  month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(t).map(p => [p.type, p.value]));
export const etDate = (t = now()) => { const p = etParts(t); return p.year + p.month + p.day; };
export const recKey = (league, date) => `rec:${league}:${date}`;

export async function recordPass(env, rec) {
  if (!rec.cfg) rec.cfg = (await env.WATCH.get('record', 'json')) || { leagues: [] };
  let busy = false;
  for (const lg of rec.cfg.leagues || []) {
    if (!LEAGUES[lg]) continue;
    const dates = [etDate()];
    if (Number(etParts(now()).hour) < 4) dates.push(etDate(now() - 86400000));   // late games past midnight ET
    for (const date of dates) {
      const key = recKey(lg, date);
      const spare = () => budgetLeft() - 1 >= (rec.reserve || 0);
      if (!PASS_CACHE.has(`sb|${lg}|${date}`) && !spare()) continue;   // alerts come first
      let games;
      try { games = await fetchGames(lg, date, true); } catch { continue; }
      const book0 = rec.books[key];
      const relevant = games.filter(g => g.state === 'in'
        || (g.state === 'pre' && Date.parse(g.start) - now() < PREGAME_LEAD_MIN * 60000)
        || (g.state === 'post' && book0?.games[g.id] && !book0.games[g.id].final));
      if (!relevant.length) continue;
      if (relevant.some(g => g.state !== 'post')) busy = true;
      if (!rec.books[key]) rec.books[key] = (await env.WATCH.get(key, 'json')) || { league: lg, date, games: {} };
      const book = rec.books[key];
      // Live games need a separate live-feed request each; take a few per pass, rotating through them.
      const liveGames = relevant.filter(g => g.state === 'in');
      const pick = new Set();
      for (let i = 0; i < Math.min(REC_LIVE_PER_PASS, liveGames.length); i++) pick.add(liveGames[(rec.rr + i) % liveGames.length].id);
      rec.rr += REC_LIVE_PER_PASS;
      for (const g of relevant) {
        const e = book.games[g.id] ||= { name: g.shortName || g.name, home: g.home.abbr, away: g.away.abbr, start: g.start, points: [] };
        if (g.state === 'post') { e.final = [g.home.score, g.away.score]; rec.dirty.add(key); continue; }
        if (g.state === 'in') {
          if (!pick.has(g.id)) continue;                 // not this pass's turn
          if (!PASS_CACHE.has(`core|${lg}|${g.id}`) && !spare()) continue;
          try { if (!(await attachLiveOdds(lg, g))) continue; } catch { continue; }
        }
        const pt = [now(), g.state === 'in' ? g.period : 0, g.clockSec, g.home.score ?? 0, g.away.score ?? 0,
          g.odds?.home?.cur ?? null, g.odds?.home?.ml?.cur ?? null, g.odds?.away?.ml?.cur ?? null];
        const last = e.points[e.points.length - 1];
        const changed = !last || [1, 3, 4, 5, 6, 7].some(i => pt[i] !== last[i]);   // the clock alone doesn't count
        if (changed && e.points.length < MAX_POINTS) { e.points.push(pt); rec.dirty.add(key); }
      }
    }
  }
  return busy;
}

// ---------- HTTP API for the phone app ----------
// Accept only a well-formed cutoff for the league's clock type; anything else means "any time".
export function cleanUntil(league, u) {
  const c = GAME_CLOCK[league];
  if (!u || !c) return null;
  const int = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
  if (c.kind === 'clock') { const p = int(u.p, 1, c.periods), left = int(u.left ?? 0, 0, c.len * 60); return p ? { p, left } : null; }
  if (c.kind === 'minute') { const min = int(u.min, 1, 120); return min ? { min } : null; }
  if (c.kind === 'baseball') { const inn = int(u.inn, 1, 9); return inn ? { inn, half: u.half === 'top' ? 'top' : 'bot', outs: int(u.outs ?? 3, 0, 3) } : null; }
  return null;
}

async function createWatch(env, body) {
  const { league, eventId, teamId, target, repeat = false, date } = body;
  const market = body.market === 'ml' ? 'ml' : 'spread';
  if (!LEAGUES[league]) throw new Error('unknown league');
  const until = cleanUntil(league, body.until);
  const swing = typeof body.swing === 'number' && Number.isFinite(body.swing) && body.swing !== 0 ? Math.round(body.swing * 100) / 100 : null;
  if (swing === null && (typeof target !== 'number' || !Number.isFinite(target))) throw new Error('need a target or a swing');
  const games = await fetchGames(league, date);
  const g = games.find(x => x.id === String(eventId));
  if (!g) throw new Error('game not found for that date');
  const isHome = g.home.id === String(teamId);
  if (!isHome && g.away.id !== String(teamId)) throw new Error('team not in that game');
  const me = isHome ? g.home : g.away, opp = isHome ? g.away : g.home;
  if (g.state === 'in') { try { await attachLiveOdds(league, g); } catch { /* no live feed */ } }
  const cur = pickLine(g, isHome, market);
  const open = pickLine(g, isHome, market, 'open');
  // pre-game (closing) line; the phone sends what it sees when ESPN won't answer the watcher
  const num = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
  // from: 'now' = set during a live game, measured from the live line at the moment you tapped Watch
  const fromNow = g.state === 'in' && body.from === 'now';
  const tip = g.state !== 'in' ? null
    : fromNow ? (num(body.liveLine) ?? cur)
    : (pickLine(g, isHome, market, 'tip') ?? num(body.tipLine) ?? cur ?? num(body.liveLine));
  const injuries = await fetchInjuries(league, g.id, me.id);
  const w = {
    id: crypto.randomUUID().slice(0, 8), league, date, eventId: g.id, start: g.start,
    teamId: me.id, teamAbbr: me.abbr, teamName: me.name, oppAbbr: opp.abbr, isHome, market, until,
    dir: swing !== null ? (swing < 0 ? 'down' : 'up') : (body.dir === 'down' ? 'down' : 'up'),
    // swing watch set mid-game: measured from the real tip-off line (from the odds feed)
    swing, tipLine: swing !== null && g.state === 'in' ? tip : null, from: fromNow ? 'now' : 'tip',
    target: swing === null ? target : (g.state === 'in' && tip !== null ? fromSwing(tip, swing, market) : null),
    repeat: !!repeat, status: 'armed', created: now(),
    openLine: open ?? cur, baseLine: cur, pregameLine: g.state === 'pre' ? cur : (tip ?? open ?? cur), lastLine: cur, lastLineAt: now(), provider: g.odds?.provider || null,
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
        const oa = {};
        for (const lg of Object.keys(OA_SPORT)) {
          const st = OA_MEM.get(`oa:${lg}`) || (await env.WATCH.get(`oa:${lg}`, 'json'));
          if (st) oa[lg] = { at: st.at, remaining: st.remaining, error: st.error };
        }
        return json({ watches: await loadWatches(env), heartbeat: await env.WATCH.get('heartbeat', 'json'),
          oddsApi: { configured: !!env.ODDS_API_KEY, leagues: oa } });
      }
      // The phone (app open) saw a watch hit on ESPN's live feed: verify, send the push, mark it fired.
      if (p === '/api/fire' && req.method === 'POST') {
        const body = await req.json();
        const line = typeof body.line === 'number' ? body.line : null;
        const list = await loadWatches(env);
        const w = list.find(x => x.id === body.id);
        if (!w) return json({ error: 'not found' }, 404);
        if (w.status !== 'armed' || line === null) return json({ ok: false, status: w.status });
        const m = w.market || 'spread';
        if (typeof w.swing === 'number' && w.tipLine == null && typeof body.tipLine === 'number') {
          w.tipLine = body.tipLine; w.target = fromSwing(w.tipLine, w.swing, m);
        }
        if (w.target == null) return json({ ok: false, reason: 'no target yet' });
        const g = (await fetchGames(w.league, w.date, true)).find(x => x.id === w.eventId);
        if (g && !inWindow(w, g)) return json({ ok: false, reason: 'past the cutoff' });
        const ev = evaluate(w, g || { state: 'in', home: {}, away: {} }, line);
        if (!ev.met) return json({ ok: false, reason: 'not at target' });
        const injuries = g ? await fetchInjuries(w.league, w.eventId, w.teamId) : null;
        const alert = g ? buildAlert(w, g, line, 'DraftKings (seen by your phone)', injuries, ev.warnings)
          : { title: `${w.teamAbbr} ${fmtVal(line, m)}: target hit`, message: 'Seen by your phone.', click: 'https://sportsbook.draftkings.com/' };
        await notify(env, alert);
        Object.assign(w, { status: 'fired', firedAt: now(), firedLine: line, lastAlert: alert, lastLine: line, lastLineAt: now() });
        await saveWatches(env, list);
        return json({ ok: true, alert });
      }
      if (p === '/api/watches' && req.method === 'POST') return json(await createWatch(env, await req.json()));
      const m = p.match(/^\/api\/watches\/([\w-]+)$/);
      if (m && req.method === 'PATCH') {
        const body = await req.json();
        const list = await loadWatches(env);
        const w = list.find(x => x.id === m[1]);
        if (!w) return json({ error: 'not found' }, 404);
        if (typeof body.swing === 'number' && Number.isFinite(body.swing) && body.swing !== 0) {
          w.swing = Math.round(body.swing * 100) / 100; w.dir = w.swing < 0 ? 'down' : 'up';
          w.target = w.tipLine != null ? fromSwing(w.tipLine, w.swing, w.market || 'spread') : null;
        } else if (typeof body.target === 'number') {
          w.target = body.target; w.swing = null;                      // switched to an exact line
          if (body.dir === 'up' || body.dir === 'down') w.dir = body.dir;
        }
        if (typeof body.repeat === 'boolean') w.repeat = body.repeat;
        if ('until' in body) w.until = cleanUntil(w.league, body.until);
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
      // Recorder: GET config + saved days, POST {leagues: ['nba']} to turn on ([] = off), GET one day's data.
      if (p === '/api/record' && req.method === 'GET') {
        const keys = (await env.WATCH.list({ prefix: 'rec:' })).keys.map(k => k.name);
        return json({ cfg: (await env.WATCH.get('record', 'json')) || { leagues: [] }, days: keys.map(k => k.slice(4)).sort().reverse() });
      }
      if (p === '/api/record' && req.method === 'POST') {
        const body = await req.json();
        const leagues = (Array.isArray(body.leagues) ? body.leagues : []).filter(l => LEAGUES[l]);
        await env.WATCH.put('record', JSON.stringify({ leagues }));
        return json({ leagues });
      }
      const rm = p.match(/^\/api\/record\/(\w+)\/(\d{8})$/);
      if (rm && req.method === 'GET') return json((await env.WATCH.get(recKey(rm[1], rm[2]), 'json')) || { games: {} });
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: e.message }, 400);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMinute(env).catch(e => console.log('check failed', e.message)));
  },
};
