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
  S.gamesLoading = true; render();
  try {
    const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${L.path}/scoreboard?${q}`);
    if (!r.ok) throw new Error('ESPN ' + r.status);
    const d = await r.json();
    S.games = (d.events || []).map(simplifyEvent)
      .sort((a, b) => ({ in: 0, pre: 1, post: 2 }[a.state] - { in: 0, pre: 1, post: 2 }[b.state]) || a.start.localeCompare(b.start));
    S.gamesErr = null;
  } catch (e) { S.gamesErr = e.message; }
  S.gamesLoading = false; render();
}

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
  render();
}

// ---------- rendering ----------
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
  const row = (t, side) => {
    const o = g.odds?.[side], cur = lineOf(o, m), open = lineOf(o, m, 'open');
    const moved = open !== null && cur !== null && open !== cur;
    const ln = cur !== null
      ? `<span class="${moved ? 'moved' : ''}">${fmtVal(cur, m)}</span>${open !== null ? `<small>open ${fmtVal(open, m)}</small>` : ''}`
      : `<span class="muted">no line</span>`;
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
  const hb = S.heartbeat ? `<div class="note" style="margin:0 4px 10px">Watcher last checked in ${ago(S.heartbeat.at)}.</div>` : '';
  return hb + list.map(watchCard).join('');
}

function watchCard(w) {
  const when = new Date(w.start).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const alert = w.lastAlert && w.status !== 'armed'
    ? `<div class="alert-box"><b>${esc(w.lastAlert.title)}</b>\n${esc(w.lastAlert.message)}</div>` : '';
  const fin = w.status === 'done' && w.final ? ` · Final ${esc(w.final)}` : '';
  const m = w.market || 'spread';
  return `<div class="card watch">
    <div class="watch-head"><div><div class="t">${esc(w.teamAbbr)} ${w.isHome ? 'vs' : '@'} ${esc(w.oppAbbr)}</div>
      <div class="s">${esc(LEAGUES[w.league]?.label || '')} · ${m === 'ml' ? 'Moneyline' : 'Spread'} · ${when}${fin}</div>
      ${w.until ? `<div class="s">⏱ Only until ${esc(untilLabel(w.league, w.until))}</div>` : ''}</div>
      <span class="status ${w.status}">${statusLabel(w)}</span></div>
    <div class="nums">
      <div class="num"><div class="k">Opened</div><div class="v">${fmtVal(w.openLine, m)}</div></div>
      <div class="num"><div class="k">Now</div><div class="v">${fmtVal(w.lastLine, m)}</div></div>
      <div class="num"><div class="k">Target</div><div class="v" style="color:var(--good-text)">${fmtVal(w.target, m)}</div>
        ${swingOf(w.target, w.openLine, m) !== null ? `<div class="k" style="text-transform:none">${swingOf(w.target, w.openLine, m)}${m === 'ml' ? '¢' : ' pts'} swing</div>` : ''}</div>
    </div>
    ${spark(w)}
    <div class="note">${w.lastLineAt ? 'Line last moved ' + ago(w.lastLineAt) : ''}${w.repeat ? ' · alerts again if it bounces back' : ' · alerts once'}</div>
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
  const W = 320, H = 64, pad = 6, tgt = scale(w.target, m);
  const ys = h.map(p => p[1]).concat([tgt]);
  const lo = Math.min(...ys), hi = Math.max(...ys), span = Math.max(hi - lo, 1);
  const t0 = h[0][0], t1 = Math.max(h[h.length - 1][0], Date.now() - 1), ts = Math.max(t1 - t0, 1);
  const x = t => pad + (t - t0) / ts * (W - pad * 2), y = v => pad + (hi - v) / span * (H - pad * 2);
  let d = `M${x(h[0][0]).toFixed(1)},${y(h[0][1]).toFixed(1)}`;
  for (let i = 1; i < h.length; i++) d += ` H${x(h[i][0]).toFixed(1)} V${y(h[i][1]).toFixed(1)}`;
  d += ` H${x(t1).toFixed(1)}`;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Line history">
    <line x1="0" x2="${W}" y1="${y(tgt)}" y2="${y(tgt)}" stroke="var(--target)" stroke-dasharray="4 4" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
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
  <div class="card note">
    <b style="color:var(--text)">How it works</b><br>
    Your Cloudflare watcher checks about every 8 seconds from 30 min before the start until the final (every 15 min before that). When the team's spread or moneyline reaches your target or better, it pushes an alert with the score, the injury report, and a warning if the line moved more than the score explains. It never places bets.
  </div>`;
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
const SWING_QUICK = { spread: [8.5, 9.5, 10, 12.5], ml: [40, 60, 80, 100] };
const DEFAULT_SWING = { spread: 10, ml: 60 };               // from the 2-year Celtics backtest sweet spot
const stepTarget = (t, dir, m) => unscale(scale(t, m) + dir * STEP[m], m);
const swingOf = (target, base, m) => base === null || base === undefined ? null : Math.round((scale(target, m) - scale(base, m)) * 100) / 100;
const fromSwing = (base, sw, m) => unscale(scale(base, m) + sw, m);

// "Swing from opener" box: type how far the line has to move from the opening number; the target follows.
function swingRow(base, target, m) {
  if (base === null || base === undefined) return '';
  const sw = swingOf(target, base, m), unit = m === 'ml' ? '¢' : 'pts';
  return `<label class="f" style="text-align:center">Swing from the opener (opened ${fmtVal(base, m)})</label>
    <div class="swing-row"><input id="swing" type="number" inputmode="decimal" step="${STEP[m]}" value="${sw}" aria-label="Swing from opener">
      <span>${unit} better</span></div>
    <div class="quick">${SWING_QUICK[m].map(n => `<button class="mini ${n === sw ? 'on' : ''}" data-swing="${n}">${n}${m === 'ml' ? '¢' : ''}</button>`).join('')}</div>`;
}
// Update the target display while typing, without redrawing (keeps the keyboard up).
function onSwingInput(v) {
  const s = sheet.state;
  if (!s || s.base === null || s.base === undefined || !Number.isFinite(v)) return;
  s.target = fromSwing(s.base, v, s.market);
  const val = document.querySelector('#sheet .stepper .val');
  if (val) val.textContent = fmtVal(s.target, s.market);
  const ex = document.querySelector('#sheet .explain');
  if (ex) ex.innerHTML = explain(s.edit ? s.edit.teamAbbr : s.g[s.side].abbr, s.target, s.market);
  document.querySelectorAll('#sheet [data-swing]').forEach(b => b.classList.toggle('on', +b.dataset.swing === v));
}

function openGameSheet(g) {
  const m = LEAGUES[S.league].market;
  // Start on the favorite (the "wait for a better number" case); one tap switches sides.
  const h = lineOf(g.odds?.home, m);
  const fav = h !== null ? (scale(h, m) <= 0 ? 'home' : 'away') : 'home';
  sheet.state = { g, side: fav, market: m, target: null, repeat: false, league: S.league, until: null };
  setDefaultTarget();
  drawGameSheet();
}
function curLine() { const s = sheet.state; return lineOf(s.g.odds?.[s.side], s.market); }
function openLine() { const s = sheet.state; return lineOf(s.g.odds?.[s.side], s.market, 'open') ?? curLine(); }
function setDefaultTarget() {
  const b = openLine(), m = sheet.state.market;
  // opener + the default swing (10 pts / 60¢)
  sheet.state.target = b === null ? (m === 'ml' ? 120 : -2) : fromSwing(b, DEFAULT_SWING[m], m);
}
function explain(abbr, t, m = 'spread') {
  const a = `<b>${esc(abbr)}</b>`;
  if (m === 'ml') {
    if (t > 0) return `Alert when ${a} moneyline is <b>+${t}</b> or better<br><small>($100 bet wins $${t})</small>`;
    return `Alert when ${a} moneyline is <b>${t}</b> or better<br><small>(bet $${-t} to win $100)</small>`;
  }
  if (t < 0) return `Alert when ${a} is favored by <b>${-t}</b> or less`;
  if (t === 0) return `Alert when ${a} is a pick'em or an underdog`;
  return `Alert when ${a} is getting <b>+${t}</b> or more`;
}
function drawGameSheet() {
  const { g, side, target, repeat, market: m } = sheet.state;
  const team = g[side], c = curLine();
  const btn = sd => {
    const t = g[sd], cur = lineOf(g.odds?.[sd], m), open = lineOf(g.odds?.[sd], m, 'open');
    return `<button data-side="${sd}" class="${sd === side ? 'on' : ''}"><img src="${esc(t.logo)}" alt=""><b>${esc(t.short)}</b>
      <span>${cur !== null ? fmtVal(cur, m) : 'no line'}${open !== null ? ` · open ${fmtVal(open, m)}` : ''}</span></button>`;
  };
  const already = c !== null && scale(c, m) >= scale(target, m);
  sheet.state.base = openLine();
  openSheet(`<h3>${esc(g.away.abbr)} @ ${esc(g.home.abbr)}</h3>
    <div class="note">${g.state === 'in' ? 'Live · ' + esc(g.detail) : timeStr(g.start)} · tap the team you'd bet on</div>
    <div class="seg"><button data-market="spread" class="${m === 'spread' ? 'on' : ''}">Spread</button><button data-market="ml" class="${m === 'ml' ? 'on' : ''}">Moneyline</button></div>
    <div class="pick">${btn('away')}${btn('home')}</div>
    ${swingRow(sheet.state.base, target, m)}
    <label class="f" style="text-align:center">Target ${m === 'ml' ? 'moneyline' : 'line'} for ${esc(team.abbr)}</label>
    <div class="stepper"><button data-step="-1" aria-label="Lower">−</button><div class="val">${fmtVal(target, m)}</div><button data-step="1" aria-label="Higher">+</button></div>
    <div class="explain">${explain(team.abbr, target, m)}${already ? '<br><span class="bad">It\'s already there now, so this alerts on the next check.</span>' : ''}</div>
    ${whenPicker(sheet.state.league, sheet.state.until, g)}
    <label class="toggle"><span>Alert again if it bounces back<small>Re-arms after it moves ${m === 'ml' ? '20¢' : '1.5 pts'} back past your target</small></span>
      <input type="checkbox" id="repeat" ${repeat ? 'checked' : ''}></label>
    <button class="btn" id="save-watch" ${configured() ? '' : 'disabled'}>${configured() ? 'Watch this line' : 'Finish Setup to save alerts'}</button>
    <button class="btn secondary" id="close-sheet">Cancel</button>`);
}

function openEditSheet(w) {
  sheet.state = { edit: w, target: w.target, market: w.market || 'spread', league: w.league, until: w.until ? { ...w.until } : null };
  drawEditSheet();
}
function drawEditSheet() {
  const { edit: w, target, market: m } = sheet.state;
  sheet.state.base = w.openLine ?? w.lastLine ?? null;
  openSheet(`<h3>${esc(w.teamAbbr)} ${w.isHome ? 'vs' : '@'} ${esc(w.oppAbbr)}</h3>
    <div class="note">${m === 'ml' ? 'Moneyline' : 'Spread'} · now ${fmtVal(w.lastLine, m)} · opened ${fmtVal(w.openLine, m)}</div>
    ${swingRow(sheet.state.base, target, m)}
    <label class="f" style="text-align:center">Target</label>
    <div class="stepper"><button data-step="-1">−</button><div class="val">${fmtVal(target, m)}</div><button data-step="1">+</button></div>
    <div class="explain">${explain(w.teamAbbr, target, m)}</div>
    ${whenPicker(w.league, sheet.state.until, null)}
    <button class="btn" id="save-edit">Save and re-arm</button>
    <button class="btn secondary" id="close-sheet">Cancel</button>`);
}

// ---------- events ----------
document.addEventListener('click', async e => {
  const t = e.target.closest('button, [data-game], [data-go]');
  if (!t) return;
  const d = t.dataset;
  if (d.tab) { S.tab = d.tab; render(); if (S.tab === 'watching') loadWatches(); window.scrollTo(0, 0); return; }
  if (d.go) { e.preventDefault(); S.tab = d.go; render(); return; }
  if (d.league) { S.league = d.league; store.set('league', S.league); S.games = []; loadGames(); return; }
  if (d.day !== undefined) { S.day = +d.day; S.games = []; loadGames(); return; }
  if (d.game) { const g = S.games.find(x => x.id === d.game); if (g) openGameSheet(g); return; }
  if (d.side) { sheet.state.side = d.side; setDefaultTarget(); drawGameSheet(); return; }
  if (d.market) { sheet.state.market = d.market; setDefaultTarget(); drawGameSheet(); return; }
  if (d.when || d.up || d.left || d.min || d.inn || d.half || d.outs) {
    const s = sheet.state;
    if (d.when) s.until = d.when === 'until' ? (s.until || defaultUntil(s.league)) : null;
    else if (s.until) adjustUntil(s.league, s.until, d);
    s.edit ? drawEditSheet() : drawGameSheet(); return;
  }
  if (d.step) { const s = sheet.state; s.target = stepTarget(s.target, +d.step, s.market); s.edit ? drawEditSheet() : drawGameSheet(); return; }
  if (d.swing) { const s = sheet.state; s.target = fromSwing(s.base, +d.swing, s.market); s.edit ? drawEditSheet() : drawGameSheet(); return; }
  if (t.id === 'close-sheet') { closeSheet(); return; }
  if (t.id === 'save-watch') {
    const { g, side, target, market, until } = sheet.state;
    const repeat = $('#repeat').checked;
    t.disabled = true; t.textContent = 'Saving…';
    try {
      await api('/api/watches', { method: 'POST', body: JSON.stringify({ league: S.league, date: ymd(dayDate(S.day)), eventId: g.id, teamId: g[side].id, target, repeat, market, until }) });
      closeSheet(); toast(`Watching ${g[side].abbr} for ${fmtVal(target, market)}${market === 'ml' ? ' ML' : ''} or better`); await loadWatches();
    } catch (err) { toast('Could not save: ' + err.message); t.disabled = false; t.textContent = 'Watch this line'; }
    return;
  }
  if (t.id === 'save-edit') {
    const { edit, target, until } = sheet.state;
    try { await api('/api/watches/' + edit.id, { method: 'PATCH', body: JSON.stringify({ target, until, status: 'armed' }) }); closeSheet(); toast('Alert updated'); loadWatches(); }
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
    S.watchErr = null; await loadWatches();
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
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { loadGames(); loadWatches(); } });

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
render(); loadGames(); loadWatches();
