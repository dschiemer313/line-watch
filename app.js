// Line Watch — phone app. Browses games straight from ESPN's public feed and manages watches
// stored in your Cloudflare Worker (which does the minute-by-minute checking and sends alerts).
'use strict';

const LEAGUES = {
  nba:   { path: 'basketball/nba', label: 'NBA' },
  ncaab: { path: 'basketball/mens-college-basketball', label: 'NCAAB', groups: '50' },
  nfl:   { path: 'football/nfl', label: 'NFL' },
  ncaaf: { path: 'football/college-football', label: 'NCAAF', groups: '80' },
  wnba:  { path: 'basketball/wnba', label: 'WNBA' },
};

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
    odds = { provider: o.provider?.name || 'Sportsbook', home: { cur: hc, open: ho }, away: { cur: ac, open: ao } };
  }
  return { id: e.id, start: e.date, state: st.type.state, detail: st.type.shortDetail || st.type.detail, home, away, odds };
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
    <div class="note" style="margin:0 4px 10px">Lines: DraftKings via ESPN. Tap a game to set an alert.</div>${body}`;
}

function gameCard(g) {
  const watched = S.watches.some(w => w.eventId === g.id && w.status !== 'done');
  const top = g.state === 'in' ? `<span class="live-dot">LIVE · ${esc(g.detail)}</span>`
    : g.state === 'post' ? `<span>${esc(g.detail)}</span>` : `<span>${timeStr(g.start)}</span>`;
  const row = (t, side) => {
    const o = g.odds?.[side];
    const moved = o && o.open !== null && o.cur !== null && o.open !== o.cur;
    const ln = o && o.cur !== null
      ? `<span class="${moved ? 'moved' : ''}">${fmtLine(o.cur)}</span>${o.open !== null ? `<small>open ${fmtLine(o.open)}</small>` : ''}`
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
  return `<div class="card watch">
    <div class="watch-head"><div><div class="t">${esc(w.teamAbbr)} ${w.isHome ? 'vs' : '@'} ${esc(w.oppAbbr)}</div>
      <div class="s">${esc(LEAGUES[w.league]?.label || '')} · ${when}${fin}</div></div>
      <span class="status ${w.status}">${statusLabel(w)}</span></div>
    <div class="nums">
      <div class="num"><div class="k">Opened</div><div class="v">${fmtLine(w.openLine)}</div></div>
      <div class="num"><div class="k">Now</div><div class="v">${fmtLine(w.lastLine)}</div></div>
      <div class="num"><div class="k">Target</div><div class="v" style="color:var(--good-text)">${fmtLine(w.target)}</div></div>
    </div>
    ${spark(w)}
    <div class="note">${w.lastLineAt ? 'Line last moved ' + ago(w.lastLineAt) : ''}${w.repeat ? ' · alerts again if it bounces back' : ' · alerts once'}</div>
    ${alert}
    <div class="actions">
      ${w.status === 'fired' ? `<button class="mini" data-rearm="${w.id}">Re-arm</button>` : ''}
      ${w.status !== 'done' ? `<button class="mini" data-edit="${w.id}">Change target</button>` : ''}
      <button class="mini danger" data-del="${w.id}">Remove</button>
    </div></div>`;
}

// Tiny line chart of the spread over time with the target as a dashed line.
function spark(w) {
  const h = (w.history || []).filter(p => p[1] !== null);
  if (h.length < 2) return '';
  const W = 320, H = 64, pad = 6;
  const ys = h.map(p => p[1]).concat([w.target]);
  const lo = Math.min(...ys), hi = Math.max(...ys), span = Math.max(hi - lo, 1);
  const t0 = h[0][0], t1 = Math.max(h[h.length - 1][0], Date.now() - 1), ts = Math.max(t1 - t0, 1);
  const x = t => pad + (t - t0) / ts * (W - pad * 2), y = v => pad + (hi - v) / span * (H - pad * 2);
  let d = `M${x(h[0][0]).toFixed(1)},${y(h[0][1]).toFixed(1)}`;
  for (let i = 1; i < h.length; i++) d += ` H${x(h[i][0]).toFixed(1)} V${y(h[i][1]).toFixed(1)}`;
  d += ` H${x(t1).toFixed(1)}`;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Line history">
    <line x1="0" x2="${W}" y1="${y(w.target)}" y2="${y(w.target)}" stroke="var(--target)" stroke-dasharray="4 4" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
    <path d="${d}" fill="none" stroke="var(--line)" stroke-width="2.2" vector-effect="non-scaling-stroke"/></svg>`;
}

function renderSettings() {
  const hb = S.heartbeat ? `<div class="note">Watcher last checked in ${ago(S.heartbeat.at)}.</div>` : '';
  return `<div class="card">
    <b>Connect your watcher</b>
    <div class="note">Paste the two values from your Cloudflare setup (SETUP.md, steps 3–4). They're saved only on this phone.</div>
    <label class="f" for="cfg-url">Worker URL</label>
    <input type="url" id="cfg-url" placeholder="https://line-watch.yourname.workers.dev" value="${esc(S.cfg.url)}" autocapitalize="off" autocorrect="off">
    <label class="f" for="cfg-key">App key</label>
    <input type="password" id="cfg-key" placeholder="the APP_KEY you set" value="${esc(S.cfg.key)}" autocapitalize="off" autocorrect="off">
    <button class="btn" id="cfg-save">Save</button>
    <div id="cfg-status" class="note" style="margin-top:8px">${configured() ? (S.watchErr ? `<span class="bad">${esc(S.watchErr)}</span>` : '<span class="ok">Connected ✓</span>') : ''}</div>
    ${hb}
  </div>
  <div class="card">
    <b>Test it</b>
    <div class="note">Sends a test push through ntfy. If it doesn't show on your lock screen, check that ntfy notifications are on in iPhone Settings and that you're subscribed to your topic in the ntfy app.</div>
    <button class="btn secondary" id="test-btn" ${configured() ? '' : 'disabled'}>Send test alert</button>
    <button class="btn secondary" id="check-btn" ${configured() ? '' : 'disabled'}>Run a check now</button>
    <pre id="check-log" class="note" style="white-space:pre-wrap;margin:10px 0 0"></pre>
  </div>
  <div class="card note">
    <b style="color:var(--text)">How it works</b><br>
    Your Cloudflare watcher checks every minute while a watched game is live (every 15 min before that). When the team's spread reaches your target or better, it pushes an alert with the score, the injury report, and a warning if the line moved more than the score explains. It never places bets.
  </div>`;
}

// ---------- the "set alert" sheet ----------
const sheet = { el: null };
function openSheet(html) {
  const s = $('#sheet'); s.innerHTML = '<div class="grabber"></div>' + html; s.hidden = false; $('#sheet-backdrop').hidden = false;
}
function closeSheet() { $('#sheet').hidden = true; $('#sheet-backdrop').hidden = true; sheet.state = null; }

function openGameSheet(g) {
  // Start on the favorite (the "wait for a better number" case); one tap switches sides.
  const fav = g.odds && g.odds.home.cur !== null ? (g.odds.home.cur <= 0 ? 'home' : 'away') : 'home';
  sheet.state = { g, side: fav, target: null, repeat: false };
  setDefaultTarget();
  drawGameSheet();
}
function curLine() { const s = sheet.state; return s.g.odds?.[s.side]?.cur ?? null; }
function setDefaultTarget() {
  const c = curLine();
  sheet.state.target = c === null ? -2 : c + 4;   // a few points better than now
}
function explain(abbr, t) {
  if (t < 0) return `Alert when <b>${esc(abbr)}</b> is favored by <b>${-t}</b> or less`;
  if (t === 0) return `Alert when <b>${esc(abbr)}</b> is a pick'em or an underdog`;
  return `Alert when <b>${esc(abbr)}</b> is getting <b>+${t}</b> or more`;
}
function drawGameSheet() {
  const { g, side, target, repeat } = sheet.state;
  const team = g[side], c = curLine();
  const btn = sd => {
    const t = g[sd], o = g.odds?.[sd];
    return `<button data-side="${sd}" class="${sd === side ? 'on' : ''}"><img src="${esc(t.logo)}" alt=""><b>${esc(t.short)}</b>
      <span>${o?.cur !== null && o?.cur !== undefined ? fmtLine(o.cur) : 'no line'}${o?.open !== null && o?.open !== undefined ? ` · open ${fmtLine(o.open)}` : ''}</span></button>`;
  };
  const already = c !== null && c >= target;
  openSheet(`<h3>${esc(g.away.abbr)} @ ${esc(g.home.abbr)}</h3>
    <div class="note">${g.state === 'in' ? 'Live · ' + esc(g.detail) : timeStr(g.start)} · tap the team you'd bet on</div>
    <div class="pick">${btn('away')}${btn('home')}</div>
    <label class="f" style="text-align:center">Target line for ${esc(team.abbr)}</label>
    <div class="stepper"><button data-step="-0.5" aria-label="Lower">−</button><div class="val">${fmtLine(target)}</div><button data-step="0.5" aria-label="Higher">+</button></div>
    <div class="explain">${explain(team.abbr, target)}${already ? '<br><span class="bad">It\'s already there now, so this alerts on the next check.</span>' : ''}</div>
    ${c !== null ? `<div class="quick">${[3, 5, 8, 10].map(n => `<button class="mini" data-quick="${n}">${n} pts better</button>`).join('')}</div>` : ''}
    <label class="toggle"><span>Alert again if it bounces back<small>Re-arms after the line moves ${'1.5'} pts back past your target</small></span>
      <input type="checkbox" id="repeat" ${repeat ? 'checked' : ''}></label>
    <button class="btn" id="save-watch" ${configured() ? '' : 'disabled'}>${configured() ? 'Watch this line' : 'Finish Setup to save alerts'}</button>
    <button class="btn secondary" id="close-sheet">Cancel</button>`);
}

function openEditSheet(w) {
  sheet.state = { edit: w, target: w.target };
  drawEditSheet();
}
function drawEditSheet() {
  const { edit: w, target } = sheet.state;
  openSheet(`<h3>${esc(w.teamAbbr)} ${w.isHome ? 'vs' : '@'} ${esc(w.oppAbbr)}</h3>
    <div class="note">Now ${fmtLine(w.lastLine)} · opened ${fmtLine(w.openLine)}</div>
    <div class="stepper" style="margin-top:16px"><button data-step="-0.5">−</button><div class="val">${fmtLine(target)}</div><button data-step="0.5">+</button></div>
    <div class="explain">${explain(w.teamAbbr, target)}</div>
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
  if (d.step) { sheet.state.target = Math.round((sheet.state.target + +d.step) * 2) / 2; sheet.state.edit ? drawEditSheet() : drawGameSheet(); return; }
  if (d.quick) { sheet.state.target = curLine() + +d.quick; drawGameSheet(); return; }
  if (t.id === 'close-sheet') { closeSheet(); return; }
  if (t.id === 'save-watch') {
    const { g, side, target } = sheet.state;
    const repeat = $('#repeat').checked;
    t.disabled = true; t.textContent = 'Saving…';
    try {
      await api('/api/watches', { method: 'POST', body: JSON.stringify({ league: S.league, date: ymd(dayDate(S.day)), eventId: g.id, teamId: g[side].id, target, repeat }) });
      closeSheet(); toast(`Watching ${g[side].abbr} for ${fmtLine(target)} or better`); await loadWatches();
    } catch (err) { toast('Could not save: ' + err.message); t.disabled = false; t.textContent = 'Watch this line'; }
    return;
  }
  if (t.id === 'save-edit') {
    const { edit, target } = sheet.state;
    try { await api('/api/watches/' + edit.id, { method: 'PATCH', body: JSON.stringify({ target, status: 'armed' }) }); closeSheet(); toast('Target updated'); loadWatches(); }
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
    S.cfg.url = $('#cfg-url').value.trim(); S.cfg.key = $('#cfg-key').value.trim();
    store.set('url', S.cfg.url); store.set('key', S.cfg.key);
    await loadWatches(); toast(S.watchErr ? 'Saved, but: ' + S.watchErr : 'Connected ✓');
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

// Keep it fresh while the app is open.
setInterval(() => { if (document.visibilityState === 'visible' && !sheet.state) { loadGames(); loadWatches(); } }, 30000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { loadGames(); loadWatches(); } });

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
render(); loadGames(); loadWatches();
