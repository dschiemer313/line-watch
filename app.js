// Line Watch — phone app. Browses games straight from ESPN's public feed and manages watches
// stored in your Cloudflare Worker (which does the minute-by-minute checking and sends alerts).
'use strict';

// market: what the Games list shows by default (hockey/baseball/soccer spreads barely move; moneylines do).
const LEAGUES = {
  nba:   { path: 'basketball/nba', label: 'NBA', market: 'spread' },
  nhl:   { path: 'hockey/nhl', label: 'NHL', market: 'ml' },
  nfl:   { path: 'football/nfl', label: 'NFL', market: 'spread' },
  ncaab: { path: 'basketball/mens-college-basketball', label: 'NCAAB', groups: '50', market: 'spread' },
  ncaaf: { path: 'football/college-football', label: 'NCAAF', groups: '80', market: 'spread' },
  mlb:   { path: 'baseball/mlb', label: 'MLB', market: 'ml' },
  wnba:  { path: 'basketball/wnba', label: 'WNBA', market: 'spread' },
  mls:   { path: 'soccer/usa.1', label: 'MLS', market: 'ml' },
  epl:   { path: 'soccer/eng.1', label: 'EPL', market: 'ml' },
};
// Regulation structure for "only alert until…" (same as the watcher's GAME_CLOCK).
const GAME_CLOCK = {
  nba: { kind: 'clock', periods: 4, len: 12, tag: 'Q' }, wnba: { kind: 'clock', periods: 4, len: 10, tag: 'Q' },
  ncaab: { kind: 'clock', periods: 2, len: 20, tag: 'H' }, nfl: { kind: 'clock', periods: 4, len: 15, tag: 'Q' },
  ncaaf: { kind: 'clock', periods: 4, len: 15, tag: 'Q' }, nhl: { kind: 'clock', periods: 3, len: 20, tag: 'P' },
  mls: { kind: 'minute' }, epl: { kind: 'minute' }, mlb: { kind: 'baseball' },
};
const ord = n => n + ([11, 12, 13].includes(n % 100) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'));
const mmss = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
function untilLabel(league, u) {
  if (!u) return 'any time';
  const c = GAME_CLOCK[league] || {};
  if (c.kind === 'clock') return u.left ? `${c.tag}${u.p} with ${mmss(u.left)} left` : `end of ${c.tag}${u.p}`;
  if (c.kind === 'minute') return `${u.min}' (match minute)`;
  if (c.kind === 'baseball') return u.outs >= 3 ? `end of ${u.half === 'top' ? 'top' : 'bottom'} ${ord(u.inn)}`
    : u.outs === 0 ? `start of ${u.half === 'top' ? 'top' : 'bottom'} ${ord(u.inn)}` : `${u.outs} out${u.outs === 1 ? '' : 's'} in the ${u.half === 'top' ? 'top' : 'bottom'} ${ord(u.inn)}`;
  return '';
}
function defaultUntil(league) {
  const c = GAME_CLOCK[league];
  if (!c) return null;
  if (c.kind === 'clock') return { p: Math.min(2, c.periods), left: 0 };   // through the end of the 2nd period/quarter
  if (c.kind === 'minute') return { min: 45 };
  return { inn: 5, half: 'bot', outs: 3 };
}
function pastCutoff(league, g, u) {          // is a live game already beyond the cutoff?
  const c = GAME_CLOCK[league];
  if (!u || !c || g.state !== 'in') return false;
  if (c.kind === 'clock') {
    if (!g.period) return false;
    if (g.period > c.periods) return true;
    const p = (g.period - 1) * c.len * 60 + Math.max(0, c.len * 60 - (g.clockSec ?? c.len * 60));
    return p > (u.p - 1) * c.len * 60 + (c.len * 60 - u.left);
  }
  if (c.kind === 'minute') return (parseInt(g.clock, 10) || 0) > u.min;
  if (c.kind === 'baseball') return (g.period || 0) > u.inn;
  return false;
}

// Moneylines on a smooth "cents" scale: -120 → -20, ±100 → 0, +150 → 50 (bigger = better payout).
const scale = (x, m) => m === 'ml' ? (x >= 100 ? x - 100 : x <= -100 ? x + 100 : 0) : x;
const unscale = (s, m) => m === 'ml' ? (s >= 0 ? s + 100 : s - 100) : s;
const fmtVal = (x, m) => m !== 'ml' ? fmtLine(x) : (x === null || x === undefined) ? '—' : (x > 0 ? '+' + x : String(x));
const lineOf = (o, m, which = 'cur') => o ? ((m === 'ml' ? o.ml?.[which] : o[which]) ?? null) : null;

// ---------- storage (never required; app still works if it's blocked) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('lw.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('lw.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

const S = {
  tab: 'games',
  league: store.get('league', 'nba'),
  day: 0,
  games: [], gamesErr: null, gamesLoading: false,
  watches: [], heartbeat: null, watchErr: null,
  cfg: { url: store.get('url', ''), key: store.get('key', '') },
};

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtLine = x => (x === null || x === undefined || Number.isNaN(x)) ? '—' : x === 0 ? 'PK' : (x > 0 ? '+' + x : String(x));
function parseLine(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toUpperCase();
  if (s === 'PK' || s === 'EVEN' || s === 'PICK') return 0;
  const n = parseFloat(s); return Number.isFinite(n) ? n : null;
}
const ymd = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const dayDate = off => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + off); return d; };
const timeStr = iso => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const ago = ms => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} hr ago` : `${Math.round(m / 1440)} d ago`; };

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}

// ---------- ESPN (direct; it allows browser requests) ----------
function simplifyEvent(e) {
  const c = e.competitions[0], st = c.status || e.status;
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
    let hc = parseLine(ps.home?.close?.line), ho = parseLine(ps.home?.open?.line);
    let ac = parseLine(ps.away?.close?.line), ao = parseLine(ps.away?.open?.line);
    if (hc === null && typeof o.spread === 'number') hc = o.spread;
    if (ac === null && hc !== null) ac = -hc;
    if (ho === null && ao !== null) ho = -ao;
    if (ao === null && ho !== null) ao = -ho;
    const mlRaw = o.moneyline || {};
    const ml = side => { const f = v => { const n = parseLine(v); return n === 0 ? 100 : n; };
      return { cur: f(mlRaw[side]?.close?.odds), open: f(mlRaw[side]?.open?.odds) }; };
    odds = { provider: o.provider?.name || 'Sportsbook', home: { cur: hc, open: ho, ml: ml('home') }, away: { cur: ac, open: ao, ml: ml('away') } };
  }
  return { id: e.id, start: e.date, state: st.type.state, detail: st.type.shortDetail || st.type.detail, home, away, odds,
           period: st.period, clock: st.displayClock, clockSec: typeof st.clock === 'number' ? st.clock : null };
}

async function loadGames() {
  const L = LEAGUES[S.league];
  const q = new URLSearchParams({ dates: ymd(dayDate(S.day)) });
  if (L.groups) { q.set('groups', L.groups); q.set('limit', '400'); }
  S.gamesLoading = true; softRender();
  try {
    const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${L.path}/scoreboard?${q}`);
    if (!r.ok) throw new Error('ESPN ' + r.status);
    const d = await r.json();
    S.games = (d.events || []).map(simplifyEvent)
      .sort((a, b) => ({ in: 0, pre: 1, post: 2 }[a.state] - { in: 0, pre: 1, post: 2 }[b.state]) || a.start.localeCompare(b.start));
    S.gamesErr = null;
    await Promise.all(S.games.filter(g => g.state === 'in').slice(0, 40).map(g => attachLiveOdds(L, g)));
  } catch (e) { S.gamesErr = e.message; }
  S.gamesLoading = false; softRender();
}

// ESPN removes odds from the scoreboard once a game starts. The live line is in its odds feed under
// "DraftKings - Live Odds" (the regular DraftKings entry there = the tip-off line). The feed is cached by
// ESPN for minutes, so add a throwaway parameter to get the current number.
// Returns { live, pre } with { home: {spread, ml}, away: {...} } each, or null. Works from the phone.
async function fetchCoreOdds(L, id) {
  try {
    const [sport, lg] = L.path.split('/');
    const r = await fetch(`https://sports.core.api.espn.com/v2/sports/${sport}/leagues/${lg}/events/${id}/competitions/${id}/odds?_=${Date.now()}`);
    if (!r.ok) return null;
    const items = (await r.json()).items || [];
    const live = items.find(i => /live/i.test(i.provider?.name || ''));
    const pre = items.find(i => i.provider?.id === '100') || items.find(i => !/live/i.test(i.provider?.name || ''));
    const f = (it, s) => {
      const t = (s === 'home' ? it?.homeTeamOdds : it?.awayTeamOdds) || {};
      const ml = parseLine(t.current?.moneyLine?.american ?? t.moneyLine);
      return { spread: parseLine(t.current?.pointSpread?.american), ml: ml === 0 ? 100 : ml };
    };
    const pack = it => it && { provider: it.provider?.name, home: f(it, 'home'), away: f(it, 'away') };
    return { live: pack(live), pre: pack(pre) };
  } catch { return null; }
}
async function attachLiveOdds(L, g) {
  const o = await fetchCoreOdds(L, g.id);
  if (!o) return;
  if (!o.live) { g.odds = { live: true, none: true, home: {}, away: {} }; return; }
  const side = s => ({ cur: o.live[s].spread, tip: o.pre ? o.pre[s].spread : null, open: null,
    ml: { cur: o.live[s].ml, tip: o.pre ? o.pre[s].ml : null, open: null } });
  g.odds = { provider: o.live.provider, live: true, home: side('home'), away: side('away') };
}

// ---------- phone-side live checking (while Line Watch is open) ----------
// ESPN won't give the cloud watcher its live-odds feed, but it answers this phone. While the app is open,
// check every armed watch whose game has started, every 4 s. On a hit: alert here (screen + sound) and
// ask the watcher to send the push so the Apple Watch / lock screen gets it too.
const PHONE_EVERY_MS = 4000;
S.phone = { fired: new Set(), live: {}, checking: 0, lastAt: 0 };
function liveWatches() {
  const t = Date.now();
  return S.watches.filter(w => w.status === 'armed' && Date.parse(w.start) <= t + 60000 && t - Date.parse(w.start) < 5 * 3600e3);
}
async function phoneCheck() {
  if (!configured() || document.visibilityState !== 'visible') return;
  const ws = liveWatches();
  S.phone.checking = ws.length;
  if (!ws.length) { releaseWake(); return; }
  keepAwake();
  const byGame = {};
  for (const w of ws) (byGame[w.league + '|' + w.eventId] ||= []).push(w);
  await Promise.all(Object.entries(byGame).map(async ([k, list]) => {
    const [lg, id] = k.split('|');
    const o = await fetchCoreOdds(LEAGUES[lg], id);
    if (!o?.live) return;                                    // not live yet, or DraftKings has pulled the line
    for (const w of list) {
      const s = w.isHome ? 'home' : 'away', m = w.market || 'spread';
      const line = m === 'ml' ? o.live[s].ml : o.live[s].spread;
      if (line === null || line === undefined) continue;
      const tip = w.tipLine ?? (o.pre ? (m === 'ml' ? o.pre[s].ml : o.pre[s].spread) : null);
      const target = w.target ?? (typeof w.swing === 'number' && tip !== null ? fromSwing(tip, w.swing, m) : null);
      S.phone.live[w.id] = { line, tip, target, at: Date.now() };
      if (target === null) continue;
      const met = w.dir === 'down' ? scale(line, m) <= scale(target, m) : scale(line, m) >= scale(target, m);
      if (met && !S.phone.fired.has(w.id)) {
        S.phone.fired.add(w.id);
        showHit(w, line, tip, target, m);
        api('/api/fire', { method: 'POST', body: JSON.stringify({ id: w.id, line, tipLine: tip }) })
          .then(() => loadWatches()).catch(() => {});
      }
    }
  }));
  S.phone.lastAt = Date.now();
  if (S.tab === 'watching') render();
}

// Full-screen alert + sound while the app is open.
let AUDIO = null;
function unlockAudio() {           // iPhone only allows sound after a tap; any tap in the app unlocks it
  try { AUDIO = AUDIO || new (window.AudioContext || window.webkitAudioContext)(); AUDIO.resume?.(); } catch { /* no audio */ }
}
function beep() {
  if (!AUDIO) return;
  [0, 0.35, 0.7, 1.4, 1.75, 2.1].forEach(t => {
    const o = AUDIO.createOscillator(), g = AUDIO.createGain();
    o.frequency.value = 880; g.gain.value = 0.25;
    o.connect(g); g.connect(AUDIO.destination);
    o.start(AUDIO.currentTime + t); o.stop(AUDIO.currentTime + t + 0.22);
  });
}
function showHit(w, line, tip, target, m) {
  const sw = typeof w.swing === 'number'
    ? `moved ${signed(w.swing, m)}${m === 'ml' ? '' : ' pts'} from ${w.from === 'now' ? '' : 'tip-off '}${fmtVal(tip, m)}${w.from === 'now' ? ' (when you set it)' : ''}`
    : `target ${fmtVal(target, m)}`;
  const el = document.createElement('div');
  el.className = 'hit';
  el.innerHTML = `<div class="hit-card"><div class="hit-tag">🚨 LINE ALERT</div>
    <div class="hit-line">${esc(w.teamAbbr)} ${fmtVal(line, m)}${m === 'ml' ? ' ML' : ''}</div>
    <div class="hit-sub">${esc(w.teamAbbr)} ${w.isHome ? 'vs' : '@'} ${esc(w.oppAbbr)} · ${esc(sw)}</div>
    <a class="btn" href="https://sportsbook.draftkings.com/" target="_blank" rel="noopener">Open DraftKings</a>
    <button class="btn secondary" data-hitclose>Dismiss</button>
    <div class="note" style="margin-top:8px">Confirm the line in DraftKings before betting.</div></div>`;
  document.body.appendChild(el);
  beep();
  try { navigator.vibrate?.([400, 150, 400, 150, 400]); } catch { /* iPhone ignores this */ }
}

// Keep the screen awake while the phone is checking live games (otherwise iOS pauses the app).
let WAKE = null;
async function keepAwake() {
  if (WAKE || !('wakeLock' in navigator)) return;
  try { WAKE = await navigator.wakeLock.request('screen'); WAKE.addEventListener('release', () => { WAKE = null; }); } catch { /* not allowed */ }
}
function releaseWake() { try { WAKE?.release(); } catch { /* ignore */ } WAKE = null; }

// ---------- Worker API ----------
const configured = () => !!(S.cfg.url && S.cfg.key);
async function api(path, opts = {}) {
  const base = S.cfg.url.replace(/\/+$/, '');
  const r = await fetch(base + path, {
    ...opts, headers: { 'content-type': 'application/json', 'x-key': S.cfg.key, ...(opts.headers || {}) },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status));
  return body;
}
async function loadWatches() {
  if (!configured()) return;
  try {
    const d = await api('/api/watches');
    S.watches = d.watches || []; S.heartbeat = d.heartbeat; S.watchErr = null;
  } catch (e) { S.watchErr = e.message; }
  softRender();
}

// ---------- rendering ----------
// Background refreshes must not redraw the Setup tab: that would wipe what you've typed or ticked.
function softRender() {
  if (S.tab !== 'settings') return render();
  const active = S.watches.filter(w => w.status !== 'done').length;
  const b = $('#watch-count'); b.hidden = !active; b.textContent = active;
}
function render() {
  const active = S.watches.filter(w => w.status !== 'done').length;
  const b = $('#watch-count'); b.hidden = !active; b.textContent = active;
  document.querySelectorAll('.tabbar button').forEach(x => x.classList.toggle('active', x.dataset.tab === S.tab));
  $('#hdr-title').textContent = { games: 'Games', watching: 'Watching', settings: 'Setup' }[S.tab];
  $('#view').innerHTML = S.tab === 'games' ? renderGames() : S.tab === 'watching' ? renderWatching() : renderSettings();
}

function setupNudge() {
  return configured() ? '' : `<div class="card warn-card"><b>Alerts aren't connected yet.</b>
    <div class="note">You can browse lines now. To get phone alerts, finish the one-time setup on the <a href="#" data-go="settings">Setup tab</a>.</div></div>`;
}

function renderGames() {
  const leagueChips = Object.entries(LEAGUES).map(([k, L]) =>
    `<button class="chip ${k === S.league ? 'on' : ''}" data-league="${k}">${L.label}</button>`).join('');
  const dayChips = [0, 1, 2, 3].map(o => {
    const lbl = o === 0 ? 'Today' : o === 1 ? 'Tomorrow' : dayDate(o).toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' });
    return `<button class="chip ${o === S.day ? 'on' : ''}" data-day="${o}">${lbl}</button>`;
  }).join('');
  let body;
  if (S.gamesLoading && !S.games.length) body = `<div class="empty">Loading lines…</div>`;
  else if (S.gamesErr) body = `<div class="card"><span class="bad">Couldn't load games:</span> ${esc(S.gamesErr)}</div>`;
  else if (!S.games.length) body = `<div class="empty"><div class="big">🗓️</div>No ${LEAGUES[S.league].label} games this day.</div>`;
  else body = S.games.map(gameCard).join('');
  return `${setupNudge()}<div class="chips">${leagueChips}</div><div class="chips">${dayChips}</div>
    <div class="note" style="margin:0 4px 10px">${LEAGUES[S.league].market === 'ml' ? 'Moneylines' : 'Spreads'}: DraftKings via ESPN. Tap a game to set an alert.</div>${body}`;
}

function gameCard(g) {
  const watched = S.watches.some(w => w.eventId === g.id && w.status !== 'done');
  const top = g.state === 'in' ? `<span class="live-dot">LIVE · ${esc(g.detail)}</span>`
    : g.state === 'post' ? `<span>${esc(g.detail)}</span>` : `<span>${timeStr(g.start)}</span>`;
  const m = LEAGUES[S.league].market;
  const isLive = !!g.odds?.live;
  const row = (t, side) => {
    const o = g.odds?.[side], cur = lineOf(o, m), ref = lineOf(o, m, isLive ? 'tip' : 'open');
    const moved = ref !== null && cur !== null && ref !== cur;
    const ln = cur !== null
      ? `<span class="${moved ? 'moved' : ''}">${fmtVal(cur, m)}</span>${ref !== null ? `<small>${isLive ? 'tip' : 'open'} ${fmtVal(ref, m)}</small>` : ''}`
      : `<span class="muted">${g.state === 'in' ? 'no live line' : 'no line'}</span>`;
    return `<div class="team-row"><img src="${esc(t.logo)}" alt="" loading="lazy"><div class="nm">${esc(t.short)}</div>
      <div class="sc">${g.state === 'pre' ? '' : (t.score ?? '')}</div><div class="ln">${ln}</div></div>`;
  };
  return `<div class="card game" data-game="${g.id}"><div class="game-top">${top}${watched ? '<span class="watch-tag">🔔 Watching</span>' : ''}</div>
    ${row(g.away, 'away')}${row(g.home, 'home')}</div>`;
}

function statusLabel(w) {
  return w.status === 'armed' ? 'Armed' : w.status === 'fired' ? 'Alert sent' : 'Done';
}
function renderWatching() {
  if (!configured()) return setupNudge();
  if (S.watchErr) return `<div class="card"><span class="bad">Can't reach your watcher:</span> ${esc(S.watchErr)}<div class="note">Check the URL and key on the Setup tab.</div></div>`;
  const list = [...S.watches].sort((a, b) => (a.status === 'done') - (b.status === 'done') || a.start.localeCompare(b.start));
  if (!list.length) return `<div class="empty"><div class="big">🔔</div>Nothing yet. Go to <a href="#" data-go="games">Games</a>, tap a game, and set a target line.</div>`;
  const n = liveWatches().length;
  const phone = n ? `<div class="card phone-on"><b>📱 This phone is checking ${n} live alert${n === 1 ? '' : 's'} every 4 seconds.</b>
      <div class="note">Keep Line Watch open on this screen during the game (the screen stays on). Alerts show here with a sound, and go to your Apple Watch / lock screen too. Tap anywhere once so the sound can play.</div></div>` : '';
  return phone + list.map(watchCard).join('');
}

function watchCard(w) {
  const when = new Date(w.start).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const alert = w.lastAlert && w.status !== 'armed'
    ? `<div class="alert-box"><b>${esc(w.lastAlert.title)}</b>\n${esc(w.lastAlert.message)}</div>` : '';
  const fin = w.status === 'done' && w.final ? ` · Final ${esc(w.final)}` : '';
  const m = w.market || 'spread';
  const pl = S.phone.live[w.id];                       // what this phone saw on ESPN's live feed just now
  if (pl && w.status === 'armed') w = { ...w, lastLine: pl.line, tipLine: w.tipLine ?? pl.tip, target: w.target ?? pl.target };
  return `<div class="card watch">
    <div class="watch-head"><div><div class="t">${esc(w.teamAbbr)} ${w.isHome ? 'vs' : '@'} ${esc(w.oppAbbr)}</div>
      <div class="s">${esc(LEAGUES[w.league]?.label || '')} · ${m === 'ml' ? 'Moneyline' : 'Spread'} · ${when}${fin}</div>
      ${w.until ? `<div class="s">⏱ Only until ${esc(untilLabel(w.league, w.until))}</div>` : ''}</div>
      <span class="status ${w.status}">${statusLabel(w)}</span></div>
    <div class="nums">
      ${typeof w.swing === 'number'
        ? `<div class="num"><div class="k">${w.from === 'now' ? 'When set' : 'Tip-off'}</div><div class="v">${w.tipLine != null ? fmtVal(w.tipLine, m) : '—'}</div></div>`
        : `<div class="num"><div class="k">Opened</div><div class="v">${fmtVal(w.openLine, m)}</div></div>`}
      <div class="num"><div class="k">Now</div><div class="v">${fmtVal(w.lastLine, m)}</div></div>
      <div class="num"><div class="k">Target</div><div class="v" style="color:var(--good-text)">${w.target == null ? 'At tip' : fmtVal(w.target, m)}</div>
        ${typeof w.swing === 'number' ? `<div class="k" style="text-transform:none">${signed(w.swing, m)}${m === 'ml' ? '' : ' pts'} from ${w.from === 'now' ? 'when set' : 'tip'}${w.tipLine != null ? ` (${fmtVal(w.tipLine, m)})` : ''}</div>` : ''}</div>
    </div>
    ${spark(w)}
    <div class="note">${pl && w.status === 'armed' ? `Live line checked ${Math.max(0, Math.round((Date.now() - pl.at) / 1000))}s ago by this phone` : w.lastLineAt ? 'Line last moved ' + ago(w.lastLineAt) : ''}${w.repeat ? ' · alerts again if it bounces back' : ' · alerts once'}</div>
    ${alert}
    <div class="actions">
      ${w.status === 'fired' ? `<button class="mini" data-rearm="${w.id}">Re-arm</button>` : ''}
      ${w.status !== 'done' ? `<button class="mini" data-edit="${w.id}">Edit alert</button>` : ''}
      <button class="mini danger" data-del="${w.id}">Remove</button>
    </div></div>`;
}

// Tiny line chart of the spread over time with the target as a dashed line.
function spark(w) {
  const m = w.market || 'spread';
  const h = (w.history || []).filter(p => p[1] !== null).map(p => [p[0], scale(p[1], m)]);
  if (h.length < 2) return '';
  const W = 320, H = 64, pad = 6, tgt = w.target == null ? null : scale(w.target, m);
  const ys = h.map(p => p[1]).concat(tgt === null ? [] : [tgt]);
  const lo = Math.min(...ys), hi = Math.max(...ys), span = Math.max(hi - lo, 1);
  const t0 = h[0][0], t1 = Math.max(h[h.length - 1][0], Date.now() - 1), ts = Math.max(t1 - t0, 1);
  const x = t => pad + (t - t0) / ts * (W - pad * 2), y = v => pad + (hi - v) / span * (H - pad * 2);
  let d = `M${x(h[0][0]).toFixed(1)},${y(h[0][1]).toFixed(1)}`;
  for (let i = 1; i < h.length; i++) d += ` H${x(h[i][0]).toFixed(1)} V${y(h[i][1]).toFixed(1)}`;
  d += ` H${x(t1).toFixed(1)}`;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Line history">
    ${tgt === null ? '' : `<line x1="0" x2="${W}" y1="${y(tgt)}" y2="${y(tgt)}" stroke="var(--target)" stroke-dasharray="4 4" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`}
    <path d="${d}" fill="none" stroke="var(--line)" stroke-width="2.2" vector-effect="non-scaling-stroke"/></svg>`;
}

function renderSettings() {
  const hb = S.heartbeat ? `<div class="note">Watcher last checked in ${ago(S.heartbeat.at)}.</div>` : '';
  return `<div class="card">
    <b>Connect your watcher</b>
    <div class="note">Paste the two values from your Cloudflare setup (SETUP.md, steps 3–4). They're saved only on this phone.</div>
    <label class="f" for="cfg-url">Worker URL</label>
    <input type="url" id="cfg-url" placeholder="https://line-watch.yourname.workers.dev" value="${esc(S.cfg.url)}" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false">
    <label class="f" for="cfg-key">App key</label>
    <input type="text" id="cfg-key" placeholder="the APP_KEY you set" value="${esc(S.cfg.key)}" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false">
    <button class="btn" id="cfg-save">Save</button>
    <div id="cfg-status" class="note" style="margin-top:8px">${configured() ? (S.watchErr ? `<span class="bad">${esc(S.watchErr)}</span>` : '<span class="ok">Connected ✓</span>') : '<span class="bad">Not connected yet. Fill in both boxes and tap Save.</span>'}</div>
    ${hb}
  </div>
  <div class="card">
    <b>Test it</b>
    <div class="note">Sends a test push through ntfy. If it doesn't show on your lock screen, check that ntfy notifications are on in iPhone Settings and that you're subscribed to your topic in the ntfy app.</div>
    <button class="btn" id="test-btn" ${configured() ? '' : 'disabled'}>Send test alert</button>
    <button class="btn secondary" id="check-btn" ${configured() ? '' : 'disabled'}>Run a check now</button>
    <pre id="check-log" class="note" style="white-space:pre-wrap;margin:10px 0 0"></pre>
  </div>
  ${recordCard()}
  <div class="card note">
    <b style="color:var(--text)">How it works</b><br>
    Your Cloudflare watcher checks about every 8 seconds from 30 min before the start until the final (every 15 min before that). When the team's spread or moneyline reaches your target or better, it pushes an alert with the score, the injury report, and a warning if the line moved more than the score explains. It never places bets.
  </div>`;
}

// ---------- live-line recorder (Setup tab) ----------
async function loadRecord() {
  if (!configured()) return;
  try { S.record = await api('/api/record'); } catch (e) { S.record = { error: e.message }; }
  if (S.tab === 'settings') render();
}
function recordCard() {
  if (!configured()) return '';
  const r = S.record;
  if (!r) return `<div class="card note">Loading recorder…</div>`;
  if (r.error) return `<div class="card note"><span class="bad">Recorder: ${esc(r.error)}</span></div>`;
  const on = new Set(r.cfg?.leagues || []);
  const boxes = Object.entries(LEAGUES).map(([k, L]) =>
    `<label class="rec-box"><input type="checkbox" data-rec="${k}" ${on.has(k) ? 'checked' : ''}> ${L.label}</label>`).join('');
  const days = (r.days || []).slice(0, 14).map(d => {
    const [lg, date] = d.split(':');
    return `<button class="mini" data-recdl="${esc(d)}">⬇ ${esc(LEAGUES[lg]?.label || lg)} ${date.slice(4, 6)}/${date.slice(6)}</button>`;
  }).join('');
  return `<div class="card">
    <b>Record live lines</b>
    <div class="note">Saves every DraftKings live-line change, with the score and clock, for every game in the leagues you tick. This shows how far real live lines move when a team falls behind, so the backtest can be calibrated to them. It records from 30 min before each game to the final.</div>
    <div class="rec-boxes">${boxes}</div>
    <button class="btn secondary" id="rec-save">Save recorder settings</button>
    ${days ? `<div class="note" style="margin-top:12px">Recorded nights (tap to download a CSV):</div><div class="actions">${days}</div>` : '<div class="note" style="margin-top:10px">Nothing recorded yet.</div>'}
  </div>`;
}
async function downloadRecord(day) {
  const [lg, date] = day.split(':');
  const data = await api(`/api/record/${lg}/${date}`);
  const head = 'league,date,game_id,game,home,away,time_utc,period,clock_sec,home_score,away_score,home_spread,home_ml,away_ml,final_home,final_away';
  const rows = [head];
  for (const [id, g] of Object.entries(data.games || {})) {
    for (const p of g.points) {
      rows.push([lg, date, id, `"${g.name}"`, g.home, g.away, new Date(p[0]).toISOString(), ...p.slice(1).map(v => v ?? ''),
        g.final?.[0] ?? '', g.final?.[1] ?? ''].join(','));
    }
  }
  const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `live-lines-${lg}-${date}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`Saved ${rows.length - 1} rows`);
}

// ---------- the "set alert" sheet ----------
const sheet = { el: null };
function openSheet(html) {
  const s = $('#sheet'); s.innerHTML = '<div class="grabber"></div>' + html; s.hidden = false; $('#sheet-backdrop').hidden = false;
}
function closeSheet() { $('#sheet').hidden = true; $('#sheet-backdrop').hidden = true; sheet.state = null; }

// "When" section, shared by the new-alert and edit sheets. league + until (null = any time).
function whenPicker(league, u, g) {
  const c = GAME_CLOCK[league];
  if (!c) return '';
  let body = '';
  if (u) {
    if (c.kind === 'clock') {
      const chips = Array.from({ length: c.periods }, (_, i) => i + 1)
        .map(p => `<button class="chip ${u.p === p ? 'on' : ''}" data-up="${p}">${c.tag}${p}</button>`).join('');
      body = `<div class="chips" style="justify-content:center;margin-top:8px">${chips}</div>
        <div class="stepper small"><button data-left="-30" aria-label="Less time left">−</button>
          <div class="val">${mmss(u.left)} <small>left</small></div><button data-left="30" aria-label="More time left">+</button></div>`;
    } else if (c.kind === 'minute') {
      body = `<div class="stepper small"><button data-min="-5">−</button><div class="val">${u.min}'</div><button data-min="5">+</button></div>`;
    } else {
      const chips = Array.from({ length: 9 }, (_, i) => i + 1)
        .map(n => `<button class="chip ${u.inn === n ? 'on' : ''}" data-inn="${n}">${n}</button>`).join('');
      body = `<div class="chips" style="justify-content:center;margin-top:8px">${chips}</div>
        <div class="seg"><button data-half="top" class="${u.half === 'top' ? 'on' : ''}">Top</button><button data-half="bot" class="${u.half !== 'top' ? 'on' : ''}">Bottom</button></div>
        <div class="stepper small"><button data-outs="-1">−</button><div class="val">${u.outs} <small>out${u.outs === 1 ? '' : 's'}</small></div><button data-outs="1">+</button></div>`;
    }
  }
  const past = u && g && pastCutoff(league, g, u);
  return `<label class="f" style="text-align:center;margin-top:18px">When to alert</label>
    <div class="seg" style="margin-top:4px"><button data-when="any" class="${u ? '' : 'on'}">Any time</button><button data-when="until" class="${u ? 'on' : ''}">Only until…</button></div>
    ${body}
    <div class="explain">${u ? `Alerts before the game or until <b>${esc(untilLabel(league, u))}</b>; after that the watch closes.` : 'Alerts whenever it hits, pre-game or live.'}
    ${past ? '<br><span class="bad">The game is already past that point.</span>' : ''}</div>`;
}
function adjustUntil(league, u, d) {
  const c = GAME_CLOCK[league];
  if (d.up) u.p = +d.up;
  if (d.left) u.left = Math.min(c.len * 60, Math.max(0, u.left + +d.left));
  if (d.min) u.min = Math.min(120, Math.max(5, u.min + +d.min));
  if (d.inn) u.inn = +d.inn;
  if (d.half) u.half = d.half;
  if (d.outs) u.outs = Math.min(3, Math.max(0, u.outs + +d.outs));
}

const STEP = { spread: 0.5, ml: 5 };                      // one tap of − / + (moneyline in cents)
const SWING_QUICK = { spread: [-2, 8.5, 9.5, 10, 12.5], ml: [-20, 40, 60, 80, 100] };
const DEFAULT_SWING = { spread: 10, ml: 60 };               // from the 2-year Celtics backtest sweet spot
const dirOf = (target, ref, m) => ref !== null && ref !== undefined && scale(target, m) < scale(ref, m) ? 'down' : 'up';
const signed = (x, m) => (x > 0 ? '+' : '') + x + (m === 'ml' ? '¢' : '');
const stepTarget = (t, dir, m) => unscale(scale(t, m) + dir * STEP[m], m);
const fromSwing = (base, sw, m) => unscale(scale(base, m) + sw, m);

function explain(abbr, t, m = 'spread', dir = 'up') {
  const a = `<b>${esc(abbr)}</b>`, down = dir === 'down';
  if (m === 'ml') {
    const w = down ? 'worse' : 'better';
    if (t > 0) return `Alert when ${a} moneyline is <b>+${t}</b> or ${w}<br><small>($100 bet wins $${t})</small>`;
    return `Alert when ${a} moneyline is <b>${t}</b> or ${w}<br><small>(bet $${-t} to win $100)</small>`;
  }
  if (down) {
    if (t < 0) return `Alert when ${a} is favored by <b>${-t}</b> or more`;
    if (t === 0) return `Alert when ${a} is a pick'em or favored`;
    return `Alert when ${a} is getting <b>+${t}</b> or less`;
  }
  if (t < 0) return `Alert when ${a} is favored by <b>${-t}</b> or less`;
  if (t === 0) return `Alert when ${a} is a pick'em or an underdog`;
  return `Alert when ${a} is getting <b>+${t}</b> or more`;
}

// Two ways to set an alert: "Move from tip-off" (swing, live only) or "Exact line".
function modeSeg(mode, live = false) {
  return `<div class="seg"><button data-mode="swing" class="${mode === 'swing' ? 'on' : ''}">${live ? 'Move from now' : 'Move from tip-off'}</button>
    <button data-mode="exact" class="${mode === 'exact' ? 'on' : ''}">Exact line</button></div>`;
}
// ref = { line, label }: the number the swing is measured from (or a stand-in before tip-off)
function swingPreview(abbr, sw, m, ref) {
  if (!Number.isFinite(sw) || sw === 0) return '<span class="bad">Type how far it has to move, like +9.5 or -2.</span>';
  const dir = sw < 0 ? 'down' : 'up', move = `${signed(sw, m)}${m === 'ml' ? '' : ' pts'}`;
  if (ref.line === null || ref.line === undefined) return `Alerts once the line moves <b>${move}</b> from where it is at tip-off.`;
  return `${ref.label} <b>${fmtVal(ref.line, m)}</b> → ${explain(abbr, fromSwing(ref.line, sw, m), m, dir)}`;
}
function swingBody(abbr, sw, m, ref, live = false) {
  return `<label class="f" style="text-align:center">How far the live line has to move from ${live ? 'where it is now' : 'tip-off'}</label>
    <div class="swing-row"><input id="swing" type="text" inputmode="text" value="${Number.isFinite(sw) ? signed(sw, 'spread') : ''}" aria-label="Swing from tip-off" autocomplete="off">
      <span>${m === 'ml' ? '¢' : 'pts'}</span></div>
    <div class="note" style="text-align:center">+ = moves toward ${esc(abbr)} · − = moves against</div>
    <div class="quick">${SWING_QUICK[m].map(n => `<button class="mini ${n === sw ? 'on' : ''}" data-swing="${n}">${signed(n, m)}</button>`).join('')}</div>
    <div class="explain swing-preview">${swingPreview(abbr, sw, m, ref)}</div>
    <div class="note" style="text-align:center">${live ? 'Game is live: it measures from the live line at the moment you tap Watch.'
      : "Live only: pre-game moves don't count. The tip-off line locks in when the game starts."}</div>`;
}
function exactBody(abbr, target, m, cur) {
  const dir = dirOf(target, cur, m);
  const already = cur !== null && cur !== undefined && (dir === 'down' ? scale(cur, m) <= scale(target, m) : scale(cur, m) >= scale(target, m));
  return `<label class="f" style="text-align:center">Target ${m === 'ml' ? 'moneyline' : 'line'} for ${esc(abbr)}</label>
    <div class="stepper"><button data-step="-1" aria-label="Lower">−</button><div class="val">${fmtVal(target, m)}</div><button data-step="1" aria-label="Higher">+</button></div>
    <div class="explain">${explain(abbr, target, m, dir)}${already ? '<br><span class="bad">It\'s already there now, so this alerts on the next check.</span>' : ''}</div>`;
}
// Update the preview while typing, without redrawing (keeps the keyboard up).
function onSwingInput(v) {
  const s = sheet.state;
  if (!s) return;
  s.swing = v;
  const p = document.querySelector('#sheet .swing-preview');
  if (p) p.innerHTML = swingPreview(sheetAbbr(), v, s.market, sheetRef());
  document.querySelectorAll('#sheet [data-swing]').forEach(b => b.classList.toggle('on', +b.dataset.swing === v));
}

function openGameSheet(g) {
  const m = LEAGUES[S.league].market;
  // Start on the favorite (the "wait for a better number" case); one tap switches sides.
  const h = lineOf(g.odds?.home, m);
  const fav = h !== null ? (scale(h, m) <= 0 ? 'home' : 'away') : 'home';
  sheet.state = { g, side: fav, market: m, mode: 'swing', swing: DEFAULT_SWING[m], target: null, repeat: false, league: S.league, until: null };
  setDefaultTarget();
  drawGameSheet();
}
function curLine() { const s = sheet.state; return s.edit ? s.edit.lastLine : lineOf(s.g.odds?.[s.side], s.market); }
function sheetAbbr() { const s = sheet.state; return s.edit ? s.edit.teamAbbr : s.g[s.side].abbr; }
function sheetRef() {
  const s = sheet.state;
  if (s.edit) {
    const w = s.edit;
    if (w.tipLine !== null && w.tipLine !== undefined) return { line: w.tipLine, label: w.from === 'now' ? 'Line when you set it was' : 'Tip-off line was' };
    return { line: w.lastLine, label: 'If it tips at the current line' };
  }
  if (s.g.state === 'in') return { line: curLine(), label: 'Live line now' };
  return { line: curLine(), label: 'If it tips at the current line' };
}
function setDefaultTarget() {
  const c = curLine(), m = sheet.state.market;
  sheet.state.target = c === null || c === undefined ? (m === 'ml' ? 120 : -2) : fromSwing(c, DEFAULT_SWING[m], m);
}
function drawGameSheet() {
  const { g, side, target, repeat, market: m, mode, swing } = sheet.state;
  const team = g[side], c = curLine();
  const btn = sd => {
    const t = g[sd], cur = lineOf(g.odds?.[sd], m);
    return `<button data-side="${sd}" class="${sd === side ? 'on' : ''}"><img src="${esc(t.logo)}" alt=""><b>${esc(t.short)}</b>
      <span>${cur !== null ? (g.state === 'in' ? 'live ' : 'now ') + fmtVal(cur, m) : 'no line'}</span></button>`;
  };
  openSheet(`<h3>${esc(g.away.abbr)} @ ${esc(g.home.abbr)}</h3>
    <div class="note">${g.state === 'in' ? 'Live · ' + esc(g.detail) : timeStr(g.start)} · tap the team you'd bet on</div>
    <div class="seg"><button data-market="spread" class="${m === 'spread' ? 'on' : ''}">Spread</button><button data-market="ml" class="${m === 'ml' ? 'on' : ''}">Moneyline</button></div>
    <div class="pick">${btn('away')}${btn('home')}</div>
    ${modeSeg(mode, g.state === 'in')}
    ${mode === 'swing' ? swingBody(team.abbr, swing, m, sheetRef(), g.state === 'in') : exactBody(team.abbr, target, m, c)}
    ${whenPicker(sheet.state.league, sheet.state.until, g)}
    <label class="toggle"><span>Alert again if it bounces back<small>Re-arms after it moves ${m === 'ml' ? '20¢' : '1.5 pts'} back past your target</small></span>
      <input type="checkbox" id="repeat" ${repeat ? 'checked' : ''}></label>
    <button class="btn" id="save-watch" ${configured() ? '' : 'disabled'}>${configured() ? 'Watch this line' : 'Finish Setup to save alerts'}</button>
    <button class="btn secondary" id="close-sheet">Cancel</button>`);
}

function openEditSheet(w) {
  const m = w.market || 'spread', isSwing = typeof w.swing === 'number';
  sheet.state = { edit: w, market: m, mode: isSwing ? 'swing' : 'exact', swing: isSwing ? w.swing : DEFAULT_SWING[m],
    target: w.target ?? w.lastLine ?? 0, league: w.league, until: w.until ? { ...w.until } : null };
  drawEditSheet();
}
function drawEditSheet() {
  const { edit: w, target, market: m, mode, swing } = sheet.state;
  openSheet(`<h3>${esc(w.teamAbbr)} ${w.isHome ? 'vs' : '@'} ${esc(w.oppAbbr)}</h3>
    <div class="note">${m === 'ml' ? 'Moneyline' : 'Spread'} · now ${fmtVal(w.lastLine, m)}${w.tipLine != null ? ' · tip-off ' + fmtVal(w.tipLine, m) : ''}</div>
    ${modeSeg(mode)}
    ${mode === 'swing' ? swingBody(w.teamAbbr, swing, m, sheetRef()) : exactBody(w.teamAbbr, target, m, w.lastLine)}
    ${whenPicker(w.league, sheet.state.until, null)}
    <button class="btn" id="save-edit">Save and re-arm</button>
    <button class="btn secondary" id="close-sheet">Cancel</button>`);
}

// ---------- events ----------
document.addEventListener('click', async e => {
  unlockAudio();
  const t = e.target.closest('button, [data-game], [data-go]');
  if (!t) return;
  const d = t.dataset;
  if (t.hasAttribute('data-hitclose')) { t.closest('.hit')?.remove(); return; }
  if (d.tab) { S.tab = d.tab; render(); if (S.tab === 'watching') loadWatches(); if (S.tab === 'settings') loadRecord(); window.scrollTo(0, 0); return; }
  if (t.id === 'rec-save') {
    const leagues = [...document.querySelectorAll('[data-rec]')].filter(x => x.checked).map(x => x.dataset.rec);
    try { await api('/api/record', { method: 'POST', body: JSON.stringify({ leagues }) }); toast(leagues.length ? `Recording ${leagues.map(l => LEAGUES[l].label).join(', ')}` : 'Recorder off'); loadRecord(); }
    catch (err) { toast('Could not save: ' + err.message); }
    return;
  }
  if (d.recdl) { try { await downloadRecord(d.recdl); } catch (err) { toast('Download failed: ' + err.message); } return; }
  if (d.go) { e.preventDefault(); S.tab = d.go; render(); return; }
  if (d.league) { S.league = d.league; store.set('league', S.league); S.games = []; loadGames(); return; }
  if (d.day !== undefined) { S.day = +d.day; S.games = []; loadGames(); return; }
  if (d.game) { const g = S.games.find(x => x.id === d.game); if (g) openGameSheet(g); return; }
  if (d.side) { sheet.state.side = d.side; setDefaultTarget(); drawGameSheet(); return; }
  if (d.market) { sheet.state.market = d.market; sheet.state.swing = DEFAULT_SWING[d.market]; setDefaultTarget(); drawGameSheet(); return; }
  if (d.mode) { const s = sheet.state; s.mode = d.mode; s.edit ? drawEditSheet() : drawGameSheet(); return; }
  if (d.when || d.up || d.left || d.min || d.inn || d.half || d.outs) {
    const s = sheet.state;
    if (d.when) s.until = d.when === 'until' ? (s.until || defaultUntil(s.league)) : null;
    else if (s.until) adjustUntil(s.league, s.until, d);
    s.edit ? drawEditSheet() : drawGameSheet(); return;
  }
  if (d.step) { const s = sheet.state; s.target = stepTarget(s.target, +d.step, s.market); s.edit ? drawEditSheet() : drawGameSheet(); return; }
  if (d.swing) { const s = sheet.state; s.swing = +d.swing; s.edit ? drawEditSheet() : drawGameSheet(); return; }
  if (t.id === 'close-sheet') { closeSheet(); return; }
  if (t.id === 'save-watch') {
    const { g, side, target, market, until, mode, swing } = sheet.state;
    const repeat = $('#repeat').checked;
    if (mode === 'swing' && (!Number.isFinite(swing) || swing === 0)) { toast('Type a swing first, like +9.5 or -2'); return; }
    const body = { league: S.league, date: ymd(dayDate(S.day)), eventId: g.id, teamId: g[side].id, repeat, market, until };
    if (mode === 'swing') body.swing = swing; else { body.target = target; body.dir = dirOf(target, curLine(), market); }
    if (g.state === 'in') {                               // the watcher can't see live lines; send what this phone sees
      await attachLiveOdds(LEAGUES[S.league], g);         // the line right now, not from the last list refresh
      body.tipLine = lineOf(g.odds?.[side], market, 'tip'); body.liveLine = curLine();
      if (mode === 'swing') {
        if (body.liveLine === null) { toast('No live line right now (DraftKings may have pulled it). Try again in a moment.'); return; }
        body.from = 'now';                                   // measure from the live line at this moment
      }
    }
    t.disabled = true; t.textContent = 'Saving…';
    try {
      await api('/api/watches', { method: 'POST', body: JSON.stringify(body) });
      closeSheet();
      toast(mode === 'swing' ? `Watching ${g[side].abbr} for a ${signed(swing, market)}${market === 'ml' ? '' : ' pt'} move from ${body.from === 'now' ? fmtVal(body.liveLine, market) : 'tip-off'}`
        : `Watching ${g[side].abbr} for ${fmtVal(target, market)}${market === 'ml' ? ' ML' : ''} or ${body.dir === 'down' ? 'worse' : 'better'}`);
      await loadWatches();
    } catch (err) { toast('Could not save: ' + err.message); t.disabled = false; t.textContent = 'Watch this line'; }
    return;
  }
  if (t.id === 'save-edit') {
    const { edit, target, until, market, mode, swing } = sheet.state;
    if (mode === 'swing' && (!Number.isFinite(swing) || swing === 0)) { toast('Type a swing first, like +9.5 or -2'); return; }
    const body = mode === 'swing' ? { swing, until, status: 'armed' } : { target, until, dir: dirOf(target, edit.lastLine, market), status: 'armed' };
    try { await api('/api/watches/' + edit.id, { method: 'PATCH', body: JSON.stringify(body) }); closeSheet(); toast('Alert updated'); loadWatches(); }
    catch (err) { toast('Could not save: ' + err.message); }
    return;
  }
  if (d.rearm) { try { await api('/api/watches/' + d.rearm, { method: 'PATCH', body: JSON.stringify({ status: 'armed' }) }); toast('Re-armed'); loadWatches(); } catch (err) { toast(err.message); } return; }
  if (d.edit) { const w = S.watches.find(x => x.id === d.edit); if (w) openEditSheet(w); return; }
  if (d.del) {
    if (!confirm('Stop watching this line?')) return;
    try { await api('/api/watches/' + d.del, { method: 'DELETE' }); toast('Removed'); loadWatches(); } catch (err) { toast(err.message); }
    return;
  }
  if (t.id === 'cfg-save') {
    let url = $('#cfg-url').value.trim(), key = $('#cfg-key').value.trim();
    if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
    const status = $('#cfg-status');
    if (!url || !key) { status.innerHTML = `<span class="bad">${!url ? 'Worker URL is empty.' : 'App key is empty.'} Fill in both boxes, then Save.</span>`; return; }
    S.cfg.url = url; S.cfg.key = key;
    store.set('url', url); store.set('key', key);
    const persisted = store.get('url', '') === url && store.get('key', '') === key;
    status.textContent = 'Checking…';
    S.watchErr = null; await loadWatches(); render(); loadRecord();
    if (S.watchErr) toast('Could not connect: ' + S.watchErr, 5000);
    else toast(persisted ? 'Connected ✓' : 'Connected, but this browser won\'t remember it (Private mode?)', 5000);
    return;
  }
  if (t.id === 'test-btn') { try { await api('/api/test', { method: 'POST' }); toast('Test alert sent. Check your phone.'); } catch (err) { toast('Failed: ' + err.message, 4000); } return; }
  if (t.id === 'check-btn') {
    t.disabled = true;
    try { const r = await api('/api/check', { method: 'POST' }); $('#check-log').textContent = r.log.join('\n'); loadWatches(); }
    catch (err) { $('#check-log').textContent = 'Failed: ' + err.message; }
    t.disabled = false; return;
  }
  if (t.id === 'refresh-btn') {
    t.classList.add('spin'); await Promise.all([loadGames(), loadWatches()]); t.classList.remove('spin'); return;
  }
});
$('#sheet-backdrop').addEventListener('click', closeSheet);
document.addEventListener('input', e => { if (e.target.id === 'swing') onSwingInput(parseFloat(e.target.value)); });

// Keep it fresh while the app is open.
setInterval(() => { if (document.visibilityState === 'visible' && !sheet.state) { loadGames(); loadWatches(); } }, 30000);
setInterval(() => phoneCheck().catch(() => {}), PHONE_EVERY_MS);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { loadGames(); loadWatches(); } });

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
render(); loadGames(); loadWatches();
