'use strict';
/* TorrFlix - Stremio-style media center. Profiles + PIN login, addon support, AllDebrid built in. */
const CINEMETA = 'https://v3-cinemeta.strem.io';
const AD_API = 'https://api.alldebrid.com/v4';
const AD_AGENT = 'torrflix';

const $ = (s) => document.querySelector(s);
const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtBytes = (b) => { if (b == null || b === '') return ''; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let n = Number(b); while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return n.toFixed(n >= 100 ? 0 : 2) + ' ' + u[i]; };
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

const DEFAULT_ADDONS = [
  { name: 'TorrFlix Streams', base: 'torrflix://streams', kind: 'stream' },
  { name: 'OpenSubtitles v3', base: 'https://opensubtitles-v3.strem.io', kind: 'subtitles' }
];

let db = load('crimson_db', null);
if (!db || !Array.isArray(db.profiles)) {
  db = { profiles: [], addons: DEFAULT_ADDONS.slice() };
  save('crimson_db', db);
}
if (Array.isArray(db.addons)) {
  if (!db.addons.some((a) => a.kind === 'subtitles')) { db.addons.push(DEFAULT_ADDONS.find((a) => a.kind === 'subtitles')); save('crimson_db', db); }
  if (!db.addons.some((a) => a.base === 'torrflix://streams')) { db.addons.unshift(DEFAULT_ADDONS[0]); save('crimson_db', db); }
}
if (Array.isArray(db.profiles) && db.profiles.length) {
  if (db.adminId) {
    const ap = db.profiles.find((p) => p.id === db.adminId);
    if (ap && !ap.isAdmin) { ap.isAdmin = true; save('crimson_db', db); }
  }
  if (!db.profiles.some((p) => p.isAdmin || p.id === db.adminId)) {
    db.profiles[0].isAdmin = true; db.adminId = db.profiles[0].id; save('crimson_db', db);
  }
}
let me = null; // current profile
let currentView = 'home';
let lastListView = 'home';
let currentMeta = null;
let currentPlay = null;

function saveDB() { save('crimson_db', db); }
function isAdminProfile(p) { return !!p && (p.isAdmin === true || (!!db.adminId && p.id === db.adminId)); }
function streamAddons() { return db.addons.filter((a) => a.kind !== 'subtitles'); }
function subAddons() { return db.addons.filter((a) => a.kind === 'subtitles'); }

async function hashPin(pin) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('crimson:' + pin));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toast(msg, ms) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), ms || 3200);
}

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function showView(name) {
  currentView = name;
  ['home', 'browse', 'detail', 'library', 'debrid', 'settings', 'player', 'upcoming'].forEach((v) => {
    $('#view-' + v).classList.toggle('hidden', v !== name);
  });
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.nav === name));
  $('#back-btn').classList.toggle('hidden', !(name === 'detail' || name === 'browse'));
  if (name !== 'player') { const p = $('#player'); if (p) { try { p.pause(); p.removeAttribute('src'); p.load(); } catch (e) {} } }
  document.querySelectorAll('.view').forEach((v) => { v.scrollTop = 0; });
}

/* ---------- lock screen / profiles ---------- */
function renderLock() {
  const c = $('#lock-content');
  $('#lock-screen').classList.remove('hidden');
  $('#app').classList.add('hidden');
  if (!db.profiles.length) {
    c.innerHTML =
      '<div class="lock-sub">First run - create the admin account.<br>You are the admin: you set the app up and make PINs for everyone else.</div>' +
      '<label>Your name</label><input id="lk-name" type="text" placeholder="e.g. Torrin" autocomplete="off">' +
      '<label>Choose a PIN (4-6 numbers)</label><input id="lk-pin" type="password" inputmode="numeric" maxlength="6" placeholder="PIN">' +
      '<label>Repeat the PIN</label><input id="lk-pin2" type="password" inputmode="numeric" maxlength="6" placeholder="PIN again">' +
      '<button class="red-btn" id="lk-create">Create admin &amp; start</button>' +
      '<div class="lock-err" id="lk-err"></div>' +
      '<button class="lock-link" id="lk-import">Got a setup file from your admin? Import it</button>';
    $('#lk-create').onclick = async () => {
      const name = $('#lk-name').value.trim();
      const p1 = $('#lk-pin').value.trim(); const p2 = $('#lk-pin2').value.trim();
      const err = $('#lk-err');
      if (!name) { err.textContent = 'Enter your name.'; return; }
      if (!/^\d{4,6}$/.test(p1)) { err.textContent = 'PIN must be 4 to 6 numbers.'; return; }
      if (p1 !== p2) { err.textContent = 'The two PINs do not match.'; return; }
      const prof = { id: uid(), name, pinHash: await hashPin(p1), isAdmin: true, adKey: '', library: [], history: [] };
      db.profiles.push(prof); db.adminId = prof.id; saveDB();
      enterApp(prof);
    };
    $('#lk-import').onclick = () => importSetupFile(() => renderLock());
    return;
  }
  const clients = db.profiles.filter((p) => !isAdminProfile(p));
  const admin = db.profiles.find((p) => isAdminProfile(p));
  c.innerHTML = '<div class="lock-sub">Who is watching?</div><div id="lk-list"></div>' +
    (clients.length ? '' : '<div class="lock-sub" style="font-size:14px">No client profiles yet - the admin adds them in Settings.</div>') +
    '<div class="lock-err" id="lk-err"></div>' +
    (admin ? '<button class="lock-link" id="lk-admin">Admin login</button>' : '');
  const list = $('#lk-list');
  clients.forEach((p) => {
    const b = document.createElement('button');
    b.className = 'profile-pick';
    b.textContent = p.name;
    b.onclick = () => renderPinEntry(p);
    list.appendChild(b);
  });
  if (admin) $('#lk-admin').onclick = () => renderPinEntry(admin, true);
}

function renderPinEntry(p, adminDoor) {
  const c = $('#lock-content');
  c.innerHTML =
    '<div class="lock-sub">' + (adminDoor ? 'Admin login' : 'Enter the PIN for <b style="color:#fff">' + esc(p.name) + '</b>') + '</div>' +
    '<label>PIN</label><input id="lk-pin" type="password" inputmode="numeric" maxlength="6" placeholder="PIN">' +
    '<button class="red-btn" id="lk-go">Unlock</button>' +
    '<div class="lock-err" id="lk-err"></div>' +
    '<button class="lock-link" id="lk-back">← Different profile</button>';
  const pinEl = $('#lk-pin'); pinEl.focus();
  const attempt = async () => {
    const h = await hashPin(pinEl.value.trim());
    if (h === p.pinHash) enterApp(p);
    else { $('#lk-err').textContent = 'Wrong PIN.'; pinEl.value = ''; }
  };
  $('#lk-go').onclick = attempt;
  pinEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') attempt(); });
  $('#lk-back').onclick = renderLock;
}

function enterApp(p) {
  me = p;
  $('#lock-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#user-chip').innerHTML = 'Signed in as <b>' + esc(p.name) + '</b>' + (isAdminProfile(p) ? ' (admin)' : '');
  adStatusLine();
  lastListView = 'home';
  showView('home');
  renderHome();
}

function lockApp() {
  me = null; currentMeta = null; currentPlay = null;
  const v = $('#player'); try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {}
  renderLock();
}

function importSetupFile(done) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.json,application/json';
  inp.onchange = () => {
    const f = inp.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const data = JSON.parse(rd.result);
        if (!data || !Array.isArray(data.profiles) || !Array.isArray(data.addons)) throw new Error('bad file');
        data.profiles.forEach((p) => { p.adKey = ''; p.library = []; p.history = []; if (!p.id) p.id = uid(); });
        db = data; saveDB();
        toast('Setup imported - log in with your PIN');
        if (done) done();
      } catch (e) { toast('That setup file did not work', 4500); }
    };
    rd.readAsText(f);
  };
  inp.click();
}

/* ---------- catalog / browse ---------- */
function posterCard(m, wide) {
  const d = document.createElement('div');
  d.className = 'card' + (wide ? ' wide' : '');
  const img = wide ? (m.background || m.poster || '') : (m.poster || '');
  d.innerHTML = '<img loading="lazy" src="' + esc(img) + '" alt="">' +
    '<div class="c-name">' + esc(m.name) + '</div><div class="c-year">' + esc(m.releaseInfo || m.year || '') + '</div>';
  d.onclick = () => openDetail(m.type, m.id);
  return d;
}
function rowTitle(t) { const d = document.createElement('div'); d.className = 'row-title'; d.textContent = t; return d; }

async function catalog(type) {
  const data = await getJSON(CINEMETA + '/catalog/' + type + '/top.json');
  return data.metas || [];
}

async function renderHome() {
  const el = $('#view-home');
  el.innerHTML = '<div class="loading">Loading...</div>';
  try {
    const [movies, series] = await Promise.all([catalog('movie'), catalog('series')]);
    el.innerHTML = '';
    const cont = (me ? me.history : []).filter((h) => h.duration > 0 && h.progress / h.duration > 0.02 && h.progress / h.duration < 0.95);
    if (cont.length) {
      el.appendChild(rowTitle('Continue Watching'));
      const r = document.createElement('div'); r.className = 'row';
      cont.slice(0, 12).forEach((h) => {
        const d = document.createElement('div'); d.className = 'card wide';
        d.innerHTML = '<img loading="lazy" src="' + esc(h.poster) + '" alt=""><div class="c-name">' + esc(h.name) + '</div>' +
          '<div class="progress"><div style="width:' + Math.round((h.progress / h.duration) * 100) + '%"></div></div>';
        d.onclick = () => playUrl(h.streamUrl, h.name, { id: h.id, type: h.type, videoId: h.videoId, name: h.name, poster: h.poster }, h.progress);
        r.appendChild(d);
      });
      el.appendChild(r);
    }
    el.appendChild(rowTitle('Popular Movies'));
    const r1 = document.createElement('div'); r1.className = 'row';
    movies.slice(0, 24).forEach((m) => r1.appendChild(posterCard(m)));
    el.appendChild(r1);
    el.appendChild(rowTitle('Popular TV Shows'));
    const r2 = document.createElement('div'); r2.className = 'row';
    series.slice(0, 24).forEach((m) => r2.appendChild(posterCard(m)));
    el.appendChild(r2);
  } catch (e) { el.innerHTML = '<div class="empty">Could not load catalogs. Check the internet connection.</div>'; }
}

async function renderBrowse(type) {
  const el = $('#view-browse');
  el.innerHTML = '<div class="loading">Loading...</div>';
  try {
    const metas = await catalog(type);
    el.innerHTML = '';
    el.appendChild(rowTitle(type === 'movie' ? 'Movies' : 'TV Shows'));
    const g = document.createElement('div'); g.className = 'grid';
    metas.forEach((m) => g.appendChild(posterCard(m)));
    el.appendChild(g);
  } catch (e) { el.innerHTML = '<div class="empty">Could not load. Check the connection.</div>'; }
}

async function renderSearch(q) {
  const el = $('#view-browse');
  el.innerHTML = '<div class="loading">Searching for "' + esc(q) + '"...</div>';
  try {
    const enc = encodeURIComponent(q);
    const [mv, sv] = await Promise.all([
      getJSON(CINEMETA + '/catalog/movie/top/search=' + enc + '.json').catch(() => ({ metas: [] })),
      getJSON(CINEMETA + '/catalog/series/top/search=' + enc + '.json').catch(() => ({ metas: [] }))
    ]);
    const all = (mv.metas || []).concat(sv.metas || []);
    el.innerHTML = '';
    el.appendChild(rowTitle('Results for "' + q + '"'));
    if (!all.length) { el.innerHTML += '<div class="empty">Nothing found.</div>'; return; }
    const g = document.createElement('div'); g.className = 'grid';
    all.forEach((m) => g.appendChild(posterCard(m)));
    el.appendChild(g);
  } catch (e) { el.innerHTML = '<div class="empty">Search failed. Check the connection.</div>'; }
}

/* ---------- detail ---------- */
async function openDetail(type, id) {
  const el = $('#view-detail');
  el.innerHTML = '<div class="loading">Loading...</div>';
  showView('detail');
  try {
    const data = await getJSON(CINEMETA + '/meta/' + type + '/' + encodeURIComponent(id) + '.json');
    const m = data.meta; currentMeta = m;
    const inLib = me.library.some((x) => x.id === m.id && x.type === m.type);
    let html = '<div class="detail-hero">' +
      '<div class="bg" style="background-image:url(\'' + esc(m.background || m.poster || '') + '\')"></div><div class="shade"></div>' +
      '<div class="detail-inner"><img src="' + esc(m.poster || '') + '" alt="">' +
      '<div><div class="d-title">' + esc(m.name) + '</div>' +
      '<div class="d-meta">' + esc(m.releaseInfo || m.year || '') +
      (m.imdbRating ? ' &nbsp;★ <b>' + esc(m.imdbRating) + '</b>' : '') +
      (m.runtime ? ' &nbsp;' + esc(m.runtime) : '') +
      (m.genre && m.genre.length ? ' &nbsp;' + esc(m.genre.join(', ')) : '') + '</div>' +
      '<div class="d-desc">' + esc(m.description || '') + '</div>' +
      (m.cast && m.cast.length ? '<div class="d-meta">Cast: ' + esc(m.cast.slice(0, 6).join(', ')) + '</div>' : '') +
      '<div class="d-actions">' +
      (m.type === 'movie' ? '<button class="red-btn" id="d-streams">Find Streams</button>' : '') +
      '<button class="dark-btn" id="d-lib">' + (inLib ? 'Remove from Library' : '+ My Library') + '</button>' +
      '</div></div></div></div><div id="stream-zone"></div>';
    let seasonGroups = null;
    if (m.type === 'series' && m.videos && m.videos.length) {
      seasonGroups = {};
      m.videos.forEach((v) => { const s = v.season == null ? 1 : v.season; (seasonGroups[s] = seasonGroups[s] || []).push(v); });
      const nums = Object.keys(seasonGroups).sort((a, b) => a - b);
      html += '<div class="season-bar"><label for="season-sel">Season</label><select id="season-sel">' +
        nums.map((s) => '<option value="' + s + '">' + (Number(s) === 0 ? 'Specials' : 'Season ' + s) + '</option>').join('') +
        '</select></div><div id="ep-list"></div>';
    }
    el.innerHTML = html;
    const libBtn = $('#d-lib');
    if (libBtn) libBtn.onclick = () => {
      const i = me.library.findIndex((x) => x.id === m.id && x.type === m.type);
      if (i >= 0) me.library.splice(i, 1); else me.library.push({ id: m.id, type: m.type, name: m.name, poster: m.poster, releaseInfo: m.releaseInfo || m.year || '' });
      saveDB();
      libBtn.textContent = i >= 0 ? '+ My Library' : 'Remove from Library';
      toast(i >= 0 ? 'Removed from library' : 'Added to library');
    };
    const sBtn = $('#d-streams');
    if (sBtn) sBtn.onclick = () => loadStreams(m.type, m.id, m.name);
    if (seasonGroups) {
      const sel = $('#season-sel');
      const epList = $('#ep-list');
      const renderSeason = (s) => {
        const eps = (seasonGroups[s] || []).slice().sort((a, b) => ((a.episode != null ? a.episode : a.number || 0) - (b.episode != null ? b.episode : b.number || 0)));
        epList.innerHTML = eps.map((v) => {
          const epn = v.episode != null ? v.episode : (v.number != null ? v.number : '');
          return '<div class="ep-row"><div class="ep-t"><div>' + esc(v.name || v.title || ('Episode ' + epn)) + '</div>' +
            '<div class="ep-n">S' + s + ' E' + epn + (v.released ? ' - ' + esc(String(v.released).slice(0, 10)) : '') + '</div></div>' +
            '<button class="red-btn small-btn ep-btn" data-vid="' + esc(v.id) + '" data-vname="' + esc((v.name || v.title || ('S' + s + ' E' + epn))) + '">Streams</button></div>';
        }).join('');
        epList.querySelectorAll('.ep-btn').forEach((b) => { b.onclick = () => loadStreams(m.type, b.dataset.vid, m.name + ' - ' + b.dataset.vname); });
      };
      const firstSeason = seasonGroups[1] ? '1' : Object.keys(seasonGroups).sort((a, b) => a - b)[0];
      sel.value = firstSeason;
      renderSeason(firstSeason);
      sel.onchange = () => renderSeason(sel.value);
    }
  } catch (e) { el.innerHTML = '<div class="empty">Could not load details.</div>'; }
}

/* ---------- streams ---------- */
function magnetFromStream(s) {
  let mag = 'magnet:?xt=urn:btih:' + s.infoHash;
  if (s.behaviorHints && s.behaviorHints.filename) mag += '&dn=' + encodeURIComponent(s.behaviorHints.filename);
  (s.sources || []).forEach((src) => { if (src.indexOf('tracker:') === 0) mag += '&tr=' + encodeURIComponent(src.slice(8)); });
  return mag;
}

/* ---------- Coming Soon: next 7 days of TV (TVmaze, no key) ---------- */
let upcomingCache = null;
async function renderUpcoming() {
  const el = $('#view-upcoming');
  el.innerHTML = '<div class="loading">Checking what is coming out...</div>';
  try {
    if (!upcomingCache) {
      const days = [];
      const now = new Date();
      for (let i = 0; i < 7; i++) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
        const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        days.push({ iso, label: (i === 0 ? 'Today - ' : i === 1 ? 'Tomorrow - ' : '') + d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) });
      }
      upcomingCache = await Promise.all(days.map(async (d) => {
        try { const items = await tfFetchJSON('https://api.tvmaze.com/schedule?country=US&date=' + d.iso); return { ...d, items: Array.isArray(items) ? items : [] }; }
        catch (e) { return { ...d, items: [] }; }
      }));
    }
    let html = '<div class="row-title">Coming Soon</div><p class="hint">New episodes airing in the next 7 days (US schedule). Tap a show to open it - once an episode has aired, its streams show up like normal.</p>';
    upcomingCache.forEach((d) => {
      const items = d.items.filter((it) => it && it.show && it.show.name).sort((a, b) => String(a.airtime || '').localeCompare(String(b.airtime || '')));
      if (!items.length) return;
      html += '<div class="row-title">' + esc(d.label) + '</div>';
      items.slice(0, 40).forEach((it) => {
        const sh = it.show;
        const img = sh.image && sh.image.medium ? sh.image.medium : '';
        const net = (sh.network && sh.network.name) || (sh.webChannel && sh.webChannel.name) || '';
        const premiere = it.season === 1 && it.number === 1;
        html += '<div class="up-row" data-imdb="' + esc((sh.externals && sh.externals.imdb) || '') + '" data-name="' + esc(sh.name) + '">' +
          (img ? '<img class="up-img" src="' + esc(img) + '" alt="">' : '<div class="up-img"></div>') +
          '<div class="ep-t"><div>' + esc(sh.name) + (premiere ? ' <span class="up-badge">PREMIERE</span>' : '') + '</div>' +
          '<div class="ep-n">S' + it.season + ' E' + it.number + ' - ' + esc(it.name || '') + (it.airtime ? ' - ' + esc(it.airtime) : '') + (net ? ' - ' + esc(net) : '') + '</div></div></div>';
      });
    });
    el.innerHTML = html;
    el.querySelectorAll('.up-row').forEach((r) => {
      r.style.cursor = 'pointer';
      r.onclick = () => {
        if (r.dataset.imdb) openDetail('series', r.dataset.imdb);
        else { lastListView = 'browse'; showView('browse'); renderSearch(r.dataset.name); }
      };
    });
  } catch (e) { el.innerHTML = '<div class="empty">Could not load the schedule right now.</div>'; }
}

/* ---------- TorrFlix Streams: our own built-in finder ----------
   Original code on the open Stremio addon protocol. It asks public
   torrent indexes for the IMDb id (or the episode), ranks the results
   by quality and seeds, and hands back plain torrent hashes.
   TorrFlix then unlocks the pick through the user's own AllDebrid. */
async function tfFetchJSON(url) {
  if (window.crimson && window.crimson.fetchJson) return window.crimson.fetchJson(url);
  return getJSON(url);
}
function qualityOf(name) {
  const n = String(name || '').toLowerCase();
  if (/2160p|4k|uhd/.test(n)) return { rank: 4, label: '2160p 4K' };
  if (/1080p/.test(n)) return { rank: 3, label: '1080p' };
  if (/720p/.test(n)) return { rank: 2, label: '720p' };
  if (/480p|360p/.test(n)) return { rank: 1, label: 'SD' };
  return { rank: 2, label: 'HD' };
}
async function localStreamData(type, videoId) {
  const parts = String(videoId).split(':');
  const imdb = parts[0];
  const season = parts.length > 1 ? parseInt(parts[1], 10) : null;
  const episode = parts.length > 2 ? parseInt(parts[2], 10) : null;
  const found = new Map();
  const add = (hash, name, seeds, size) => {
    if (!hash || !/^[a-f0-9]{40}$/i.test(hash) || /^0+$/.test(hash)) return;
    const key = hash.toLowerCase();
    const prev = found.get(key);
    if (!prev || (seeds || 0) > prev.seeds) found.set(key, { hash: key, name: String(name || ''), seeds: seeds || 0, size: size || 0 });
  };
  const jobs = [];
  if (type === 'movie') {
    jobs.push((async () => {
      const d = await tfFetchJSON('https://apibay.org/q.php?q=' + encodeURIComponent(imdb) + '&cat=200');
      (Array.isArray(d) ? d : []).forEach((t) => { if (Number(t.size) > 150 * 1048576) add(t.info_hash, t.name, Number(t.seeders), Number(t.size)); });
    })().catch(() => {}));
  } else {
    jobs.push((async () => {
      const d = await tfFetchJSON('https://eztvx.to/api/get-torrents?imdb_id=' + encodeURIComponent(imdb.replace(/^tt/, '')) + '&limit=100&page=1');
      (d.torrents || []).forEach((t) => {
        if (season != null && Number(t.season) !== season) return;
        if (episode != null && Number(t.episode) !== episode) return;
        add(t.hash, t.filename, Number(t.seeds), Number(t.size_bytes));
      });
    })().catch(() => {}));
    jobs.push((async () => {
      const meta = await tfFetchJSON('https://v3-cinemeta.strem.io/meta/series/' + encodeURIComponent(imdb) + '.json');
      const seriesName = meta && meta.meta && meta.meta.name;
      if (!seriesName) return;
      const ep = 'S' + String(season).padStart(2, '0') + 'E' + String(episode).padStart(2, '0');
      const d = await tfFetchJSON('https://apibay.org/q.php?q=' + encodeURIComponent(seriesName + ' ' + ep) + '&cat=200');
      (Array.isArray(d) ? d : []).forEach((t) => { if (Number(t.size) > 80 * 1048576) add(t.info_hash, t.name, Number(t.seeders), Number(t.size)); });
    })().catch(() => {}));
  }
  await Promise.all(jobs);
  const rows = Array.from(found.values()).map((r) => ({ ...r, q: qualityOf(r.name) }));
  rows.sort((a, b) => (b.q.rank - a.q.rank) || (b.seeds - a.seeds));
  return {
    streams: rows.slice(0, 15).map((r) => ({
      name: 'TorrFlix Streams\n' + r.q.label,
      title: r.name + '\nSeeds: ' + r.seeds + (r.size ? '   Size: ' + fmtBytes(r.size) : ''),
      infoHash: r.hash,
      behaviorHints: { filename: r.name, notWebReady: true }
    }))
  };
}

async function loadStreams(type, videoId, label) {
  const zone = $('#stream-zone');
  if (!zone) return;
  zone.innerHTML = '<div class="loading">Asking your addons for streams...</div>';
  zone.scrollIntoView({ behavior: 'smooth' });
  const results = [];
  await Promise.all(streamAddons().map(async (a) => {
    try {
      const data = a.base === 'torrflix://streams' ? await localStreamData(type, videoId) : await getJSON(a.base + '/stream/' + type + '/' + encodeURIComponent(videoId) + '.json');
      (data.streams || []).forEach((s) => results.push({ addon: a.name, s }));
    } catch (e) { /* addon offline or no streams */ }
  }));
  if (!results.length) {
    zone.innerHTML = '<div class="row-title">Streams</div><div class="empty">No streams found this time. TorrFlix Streams searches the public indexes by title, so a very new or very obscure release may not be listed yet - try again later, or add another finder in Settings.</div>';
    return;
  }
  zone.innerHTML = '';
  zone.appendChild(rowTitle('Streams - ' + label));
  results.forEach(({ addon, s }) => {
    const row = document.createElement('div'); row.className = 'stream';
    const name = (s.name || addon).trim();
    const title = (s.title || s.description || '').trim();
    let btns = '';
    if (s.url) btns += '<button class="red-btn small-btn act-play">Play</button>';
    if (s.infoHash) {
      btns += '<button class="red-btn small-btn act-ad">Play via AllDebrid</button>';
      btns += '<button class="dark-btn small-btn act-magnet">Copy magnet</button>';
    }
    if (s.externalUrl) btns += '<button class="dark-btn small-btn act-ext">Open external</button>';
    row.innerHTML = '<div class="s-body"><div class="s-name">' + esc(name) + '</div><div class="s-title">' + esc(title) + '</div></div><div class="s-btns">' + btns + '</div>';
    row.style.cursor = 'pointer';
    row.title = 'Click to play';
    row.onclick = (e) => {
      if (e.target.closest('button')) return;
      const ctx = { id: currentMeta.id, type: currentMeta.type, videoId, name: currentMeta.name, poster: currentMeta.poster };
      if (s.infoHash && me && me.alldebridKey) adPlayMagnet(magnetFromStream(s), label, ctx, null);
      else if (s.url) playUrl(s.url, label, ctx);
      else if (s.infoHash) adPlayMagnet(magnetFromStream(s), label, ctx, null);
      else if (s.externalUrl) window.crimson.openExternal(s.externalUrl);
    };
    const play = row.querySelector('.act-play');
    if (play) play.onclick = () => playUrl(s.url, label, { id: currentMeta.id, type: currentMeta.type, videoId, name: currentMeta.name, poster: currentMeta.poster });
    const ad = row.querySelector('.act-ad');
    if (ad) ad.onclick = () => adPlayMagnet(magnetFromStream(s), label, { id: currentMeta.id, type: currentMeta.type, videoId, name: currentMeta.name, poster: currentMeta.poster }, ad);
    const mg = row.querySelector('.act-magnet');
    if (mg) mg.onclick = () => { window.crimson.copyText(magnetFromStream(s)); toast('Magnet link copied'); };
    const ex = row.querySelector('.act-ext');
    if (ex) ex.onclick = () => window.crimson.openExternal(s.externalUrl);
    zone.appendChild(row);
  });
}

/* Mouse wheel scrolls poster rows sideways */
document.addEventListener('wheel', (e) => {
  const row = e.target && e.target.closest ? e.target.closest('.row') : null;
  if (row && row.scrollWidth > row.clientWidth && Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
    row.scrollLeft += e.deltaY;
    e.preventDefault();
  }
}, { passive: false });

/* ---------- player + subtitles ---------- */
function srtToVtt(srt) {
  return 'WEBVTT\n\n' + srt.replace(/\r+/g, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
}

async function attachSubtitles(vid, type, videoId) {
  try {
    const all = [];
    await Promise.all(subAddons().map(async (a) => {
      try {
        const data = await getJSON(a.base + '/subtitles/' + type + '/' + encodeURIComponent(videoId) + '.json');
        (data.subtitles || []).forEach((s) => all.push(s));
      } catch (e) {}
    }));
    const eng = all.filter((s) => /^(eng?|english)$/i.test(String(s.lang || ''))).slice(0, 3);
    for (let i = 0; i < eng.length; i++) {
      try {
        const r = await fetch(eng[i].url);
        if (!r.ok) continue;
        let text = await r.text();
        if (!/^\s*WEBVTT/.test(text)) text = srtToVtt(text);
        const blobUrl = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
        const track = document.createElement('track');
        track.kind = 'subtitles'; track.label = 'English ' + (i + 1); track.srclang = 'en';
        track.src = blobUrl;
        if (i === 0) track.default = true;
        vid.appendChild(track);
      } catch (e) { /* subtitle fetch failed, carry on without it */ }
    }
  } catch (e) {}
}

function historyKeyFor(title, ctx, url) { return ctx ? (ctx.type + ':' + ctx.videoId) : ('file:' + (title || url)); }

function logHistory(url, title, ctx, progress, duration) {
  if (!me) return;
  const key = historyKeyFor(title, ctx, url);
  const i = me.history.findIndex((h) => h.key === key);
  const prev = i >= 0 ? me.history[i] : null;
  const entry = {
    key,
    id: ctx ? ctx.id : '', type: ctx ? ctx.type : 'file', videoId: ctx ? ctx.videoId : '',
    name: ctx ? ctx.name : (title || 'AllDebrid file'), poster: ctx ? (ctx.poster || '') : '',
    streamUrl: url, progress: progress != null ? progress : (prev ? prev.progress : 0),
    duration: duration != null ? duration : (prev ? prev.duration : 0), updated: Date.now()
  };
  if (i >= 0) me.history[i] = entry; else me.history.unshift(entry);
  me.history = me.history.slice(0, 40);
  saveDB();
}

async function fetchEnglishSubUrls(type, videoId) {
  const all = [];
  await Promise.all(subAddons().map(async (a) => {
    try {
      const data = await getJSON(a.base + '/subtitles/' + type + '/' + encodeURIComponent(videoId) + '.json');
      (data.subtitles || []).forEach((s) => all.push(s));
    } catch (e) {}
  }));
  return all.filter((s) => /^(eng?|english)$/i.test(String(s.lang || ''))).slice(0, 3).map((s) => s.url);
}

function playUrl(url, title, ctx, resumeAt) {
  if (!url) { toast('No playable link'); return; }
  currentPlay = { url, title, ctx };
  if (window.crimson && window.crimson.playPlayer) playViaBuiltinPlayer(url, title, ctx, resumeAt);
  else playInWebPlayer(url, title, ctx, resumeAt);
}

async function playViaBuiltinPlayer(url, title, ctx, resumeAt) {
  $('#player-title').textContent = title || '';
  const vid = $('#player'); try { vid.pause(); vid.removeAttribute('src'); vid.load(); } catch (e) {}
  showView('player');
  const msg = $('#player-msg');
  msg.classList.remove('hidden');
  msg.innerHTML = 'Starting the TorrFlix player...';
  logHistory(url, title, ctx, resumeAt || 0, 0);
  let unsub = null;
  if (window.crimson.onPlayerProgress) unsub = window.crimson.onPlayerProgress((d) => { msg.innerHTML = 'Downloading the TorrFlix player - one time only... ' + (d.pct || 0) + '%'; });
  let res = null;
  try { res = await window.crimson.ensurePlayer(); } catch (e) {}
  if (typeof unsub === 'function') unsub();
  if (res && res.status === 'ready') {
    let subs = [];
    if (ctx) { try { subs = await fetchEnglishSubUrls(ctx.type, ctx.videoId); } catch (e) {} }
    let r = null;
    try { r = await window.crimson.playPlayer({ url, start: resumeAt || 0, subs }); } catch (e) {}
    if (r && r.ok) {
      msg.innerHTML = '<b>Playing in the TorrFlix player</b> - it opened in its own fullscreen window and plays everything, sound included. When you are done, just close that window.';
      return;
    }
  }
  msg.innerHTML = 'The TorrFlix player could not start, so the built-in web player is taking over. Some files (4K, MKV, AC3/DTS sound) may not play properly in it.';
  playInWebPlayer(url, title, ctx, resumeAt);
}

function playInWebPlayer(url, title, ctx, resumeAt) {
  $('#player-title').textContent = title || '';
  const vid = $('#player');
  const msg = $('#player-msg');
  msg.classList.add('hidden'); msg.textContent = '';
  Array.from(vid.querySelectorAll('track')).forEach((t) => t.remove());
  showView('player');
  try { const fp = vid.requestFullscreen && vid.requestFullscreen(); if (fp && fp.catch) fp.catch(() => {}); } catch (e) {}
  logHistory(url, title, ctx, resumeAt || 0, 0);
  vid.src = url;
  vid.onloadedmetadata = () => { if (resumeAt && resumeAt > 5 && vid.duration && resumeAt < vid.duration - 10) vid.currentTime = resumeAt; };
  vid.onerror = () => {
    msg.innerHTML = 'This file would not play in the built-in player. This is common with 4K, MKV and HEVC files.';
    msg.classList.remove('hidden');
  };
  let lastSave = 0;
  vid.ontimeupdate = () => {
    const now = Date.now();
    if (now - lastSave < 5000 || !me) return;
    lastSave = now;
    logHistory(url, title, ctx, vid.currentTime, vid.duration || 0);
  };
  if (ctx) attachSubtitles(vid, ctx.type, ctx.videoId);
  vid.play().catch(() => {});
  const myPlay = currentPlay;
  setTimeout(() => {
    if (currentPlay !== myPlay) return;
    const v2 = $('#player');
    if (!v2 || v2.paused || v2.currentTime < 2) return;
    if (typeof v2.webkitAudioDecodedByteCount === 'number' && v2.webkitAudioDecodedByteCount === 0 && !audioGraph) {
      msg.innerHTML = 'This one is playing with <b>no sound</b> in the built-in player - its audio track (usually AC3 or DTS) cannot be decoded here. The TorrFlix player handles it; if it did not open, check your connection and press Play again.';
      msg.classList.remove('hidden');
    }
  }, 5000);
}

function adUrl(path, params, base) {
  const q = new URLSearchParams(Object.assign({ agent: AD_AGENT, apikey: me ? me.adKey : '' }, params || {}));
  return (base || AD_API) + path + '?' + q.toString();
}
async function adGet(path, params, base) {
  const data = await getJSON(adUrl(path, params, base));
  if (data.status === 'error') throw new Error((data.error && data.error.message) || 'AllDebrid error');
  return data.data;
}
const AD_API41 = 'https://api.alldebrid.com/v4.1';
async function adPost(path, params) {
  const body = new URLSearchParams(Object.assign({ agent: AD_AGENT, apikey: me ? me.adKey : '' }, params || {}));
  const r = await fetch(AD_API + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const data = await r.json();
  if (data.status === 'error') throw new Error((data.error && data.error.message) || 'AllDebrid error');
  return data.data;
}
async function adMagnetFiles(id) {
  let data;
  try { data = await adGet('/magnet/files', { id }, AD_API41); }
  catch (e) { data = await adPost('/magnet/files', { 'id[]': id }); }
  const mag = (data.magnets || [])[0];
  if (!mag) throw new Error('No files came back from AllDebrid');
  if (mag.error) throw new Error(mag.error.message || 'Could not get the files');
  const out = [];
  const walk = (entries) => { (entries || []).forEach((f) => { if (f.e) walk(f.e); else if (f.l) out.push({ filename: f.n, size: f.s, link: f.l }); }); };
  walk(mag.files);
  return out;
}
function needKey() {
  if (!me || !me.adKey) { toast('Add your AllDebrid API key in Settings first'); showView('settings'); renderSettings(); return true; }
  return false;
}
function adStatusLine() {
  $('#ad-status').textContent = me && me.adKey ? 'AllDebrid: key saved' : 'AllDebrid: not set up';
}

async function adFetchMagnetLinks(magnet, btn) {
  const up = await adGet('/magnet/upload', { 'magnets[]': magnet });
  const m = (up.magnets || [])[0];
  if (!m) throw new Error('AllDebrid did not accept the magnet');
  if (m.error) throw new Error(m.error.message || 'Magnet rejected');
  for (let i = 0; i < 40; i++) {
    const raw = await adGet('/magnet/status', { id: m.id }, AD_API41);
    const st = raw && raw.magnets ? (Array.isArray(raw.magnets) ? raw.magnets[0] : raw.magnets) : raw;
    const code = st ? st.statusCode : null;
    if (code === 4 || (st && st.status === 'Ready')) return adMagnetFiles(m.id);
    if (code != null && code > 4) throw new Error('AllDebrid: ' + (st.status || 'failed'));
    if (btn) btn.textContent = 'AllDebrid is fetching it... (' + ((st && st.status) || 'working') + ')';
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('Timed out waiting for AllDebrid');
}

async function adPlayMagnet(magnet, label, ctx, btn) {
  if (needKey()) return;
  const old = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Sending to AllDebrid...'; }
  try {
    const links = await adFetchMagnetLinks(magnet, btn);
    if (!links.length) throw new Error('No files came back from AllDebrid');
    const videoExt = /\.(mkv|mp4|avi|mov|m4v|webm|ts)$/i;
    links.sort((a, b) => (b.size || 0) - (a.size || 0));
    const pick = links.find((l) => videoExt.test(l.filename || '')) || links[0];
    if (links.length > 1) toast('Picked the biggest video file: ' + (pick.filename || ''));
    const un = await adGet('/link/unlock', { link: pick.link });
    playUrl(un.link, label, ctx);
  } catch (e) {
    toast('AllDebrid: ' + e.message, 5000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = old; }
  }
}

function adFileRow(l, directUrl) {
  const row = document.createElement('div'); row.className = 'file-row clickable';
  row.title = 'Click to play';
  row.innerHTML = '<div class="f-name">' + esc(l.filename || l.link) + '</div><div class="f-size">' + fmtBytes(l.size) + '</div>';
  const copy = document.createElement('button'); copy.className = 'dark-btn small-btn'; copy.textContent = 'Copy link';
  const go = async () => {
    if (directUrl) return directUrl;
    const un = await adGet('/link/unlock', { link: l.link });
    return un.link;
  };
  row.onclick = async () => {
    toast('Getting your link...');
    try { const u = await go(); playUrl(u, l.filename || 'AllDebrid file', null); } catch (e) { toast(e.message, 4500); }
  };
  copy.onclick = async (ev) => { ev.stopPropagation(); try { const u = await go(); window.crimson.copyText(u); toast('Direct link copied'); } catch (e) { toast(e.message, 4500); } };
  row.appendChild(copy);
  return row;
}

function renderDebrid() {
  const el = $('#view-debrid');
  el.innerHTML =
    '<div class="row-title">AllDebrid</div>' +
    '<div class="panel"><h3>Paste a magnet or a link</h3>' +
    '<p>AllDebrid will fetch it and hand back a direct link you can play right here. Torrents come back as the files inside them - pick the video file.</p>' +
    '<label>Magnet link or file-host link</label>' +
    '<textarea id="ad-input" rows="3" placeholder="magnet:?xt=urn:btih:... or https://..."></textarea>' +
    '<div class="btn-row"><button class="red-btn" id="ad-go">Unlock / Fetch</button></div>' +
    '<div id="ad-result"></div></div>';
  $('#ad-go').onclick = async () => {
    if (needKey()) return;
    const val = $('#ad-input').value.trim();
    const out = $('#ad-result');
    if (!val) { toast('Paste something first'); return; }
    out.innerHTML = '<div class="loading">Talking to AllDebrid...</div>';
    try {
      if (val.indexOf('magnet:') === 0) {
        const links = await adFetchMagnetLinks(val, null);
        out.innerHTML = '<p style="margin-top:12px">Files ready - click one to play it:</p>';
        links.forEach((l) => out.appendChild(adFileRow(l)));
      } else {
        const un = await adGet('/link/unlock', { link: val });
        out.innerHTML = '';
        out.appendChild(adFileRow({ link: val, filename: un.filename, size: un.filesize }, un.link));
      }
    } catch (e) { out.innerHTML = '<p class="err" style="margin-top:12px">' + esc(e.message) + '</p>'; }
  };
}

/* ---------- library ---------- */
function renderLibrary() {
  const el = $('#view-library');
  el.innerHTML = '';
  el.appendChild(rowTitle('My Library'));
  if (!me.library.length) { el.innerHTML += '<div class="empty">Nothing saved yet. Open any movie or show and hit "+ My Library".</div>'; }
  else {
    const g = document.createElement('div'); g.className = 'grid';
    me.library.forEach((m) => g.appendChild(posterCard(m)));
    el.appendChild(g);
  }
  el.appendChild(rowTitle('Watch History'));
  const hist = (me.history || []).slice();
  if (!hist.length) { el.innerHTML += '<div class="empty">Nothing watched yet. Everything you play lands here.</div>'; return; }
  const clear = document.createElement('button'); clear.className = 'dark-btn small-btn'; clear.textContent = 'Clear history';
  clear.onclick = () => { me.history = []; saveDB(); renderLibrary(); };
  el.appendChild(clear);
  hist.forEach((h) => {
    const row = document.createElement('div'); row.className = 'file-row clickable';
    const when = h.updated ? new Date(h.updated).toLocaleString() : '';
    const pct = h.duration > 0 ? Math.round((h.progress / h.duration) * 100) : 0;
    row.innerHTML = '<div class="f-name"><b>' + esc(h.name || 'Untitled') + '</b><br><span style="color:var(--muted);font-size:12px">' + esc(when) + (pct ? ' - watched ' + pct + '%' : '') + '</span></div>';
    const rm = document.createElement('button'); rm.className = 'dark-btn small-btn'; rm.textContent = 'Remove';
    rm.onclick = (ev) => { ev.stopPropagation(); me.history = me.history.filter((x) => x.key !== h.key); saveDB(); renderLibrary(); };
    row.onclick = () => {
      if (h.type === 'file') playUrl(h.streamUrl, h.name, null, h.progress);
      else playUrl(h.streamUrl, h.name, { id: h.id, type: h.type, videoId: h.videoId, name: h.name, poster: h.poster }, h.progress);
    };
    row.appendChild(rm);
    el.appendChild(row);
  });
}

/* ---------- settings ---------- */
function renderSettings() {
  const el = $('#view-settings');
  let html = '<div class="row-title">Settings</div>';
  html += '<div class="panel"><h3>My AllDebrid</h3>' +
    '<p>Your own AllDebrid API key - get it from your AllDebrid account under API keys, then paste it here. It is stored only on this PC, under your profile.</p>' +
    '<label>AllDebrid API key</label>' +
    '<input type="password" id="set-adkey" value="' + esc(me.adKey || '') + '" placeholder="Paste your API key">' +
    '<div class="btn-row"><button class="red-btn" id="set-ad-save">Save key</button>' +
    '<button class="dark-btn" id="set-ad-check">Check account</button>' +
    '<button class="dark-btn" id="set-ad-open">Open AllDebrid API page</button></div>' +
    '<div id="ad-check-out"></div></div>';

  html += '<div class="panel"><h3>Streaming sources (AllDebrid)</h3>' +
    '<p>Here is the part nobody tells you: AllDebrid only works properly when the unlocking happens from <b>your own connection</b> - and TorrFlix already does that itself. So the addons here are just <b>finders</b>. They find the releases, and when you tap a stream, TorrFlix unlocks it through your AllDebrid account, from your PC. That path cannot be blocked or switched off by anyone.</p>' +
    '<p><b>TorrFlix Streams is already built in</b> - it is our own finder, it searches the public indexes and ranks results by quality and seeds, and it works with AllDebrid in one click. The options below are only if you ever want extra finders on top.</p>' +
    '<p>Why not pick AllDebrid inside MediaFusion? MediaFusion\'s own docs say AllDebrid only works when MediaFusion runs on your own machine - on every public instance it is a dead end, and ElfHosted (the big public host) no longer supports AllDebrid at all. That is why it failed you.</p>' +
    '<p><b>Option 1 - one tap:</b> add Torrentio as a finder only. No key inside it, nothing to configure - TorrFlix does the AllDebrid part.</p>' +
    '<p><b>Option 2:</b> MediaFusion as a finder. On its configure page choose <b>Direct Torrent</b> as the provider (NOT AllDebrid), copy the manifest link it gives you, and paste it in the Add an addon box below.</p>' +
    '<div class="btn-row"><button class="red-btn" id="src-tio">Add Torrentio as a finder</button>' +
    '<button class="dark-btn" id="src-mf">Configure MediaFusion as a finder</button></div></div>';

  html += '<div class="panel"><h3>Stream addons</h3>' +
    '<p>Addons are how TorrFlix finds streams and subtitles - the same system Stremio uses. For movie and TV streams through AllDebrid, use the Streaming sources panel above. Subtitles (OpenSubtitles) are already loaded.</p>' +
    '<div id="addon-list"></div>' +
    '<label>Add an addon (manifest URL)</label>' +
    '<input type="text" id="set-addon-url" placeholder="https://.../manifest.json">' +
    '<div class="btn-row"><button class="red-btn" id="set-addon-add">Add addon</button></div></div>';

  if (isAdminProfile(me)) {
    html += '<div class="panel"><h3>Profiles (admin)</h3>' +
      '<p>Make a profile and a PIN for each person. They pick their name on the first screen and type their PIN.</p>' +
      '<div id="prof-list"></div>' +
      '<label>New profile name</label><input type="text" id="prof-name" placeholder="Name">' +
      '<label>PIN (4-6 numbers)</label><input type="text" id="prof-pin" inputmode="numeric" maxlength="6" placeholder="PIN">' +
      '<div class="btn-row"><button class="red-btn" id="prof-add">Create profile</button></div>' +
      '<label style="margin-top:22px">Reset a PIN</label>' +
      '<div class="btn-row" style="margin-top:0"><select id="pin-reset-sel" style="flex:1;background:var(--panel2);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:10px;"></select>' +
      '<input type="text" id="pin-reset-val" inputmode="numeric" maxlength="6" placeholder="New PIN" style="width:130px">' +
      '<button class="dark-btn" id="pin-reset-go">Reset PIN</button></div></div>';

    html += '<div class="panel"><h3>Hand TorrFlix to someone (admin)</h3>' +
      '<p>Export a setup file, then give the person the app plus this file. On their first screen they tap "Import it", pick the file, and log in with the PIN you gave them. The file carries the profiles, PINs and addons - never any AllDebrid keys. Each person adds their own AllDebrid key in Settings.</p>' +
      '<div class="btn-row"><button class="red-btn" id="export-btn">Export setup file</button>' +
      '<button class="dark-btn" id="import-btn">Import setup file</button></div></div>';
  }
  el.innerHTML = html;

  $('#src-tio').onclick = () => {
    if (db.addons.some((a) => /torrentio\.strem\.fun/i.test(a.base || ''))) { toast('Torrentio finder is already added'); return; }
    db.addons.push({ name: 'Torrentio', base: 'https://torrentio.strem.fun', kind: 'stream' });
    saveDB(); if (typeof addonList === 'function') addonList();
    toast('Torrentio added as a finder');
  };
  $('#src-mf').onclick = () => window.crimson.openExternal('https://mediafusion.elfhosted.com/configure');
  $('#set-ad-save').onclick = () => { me.adKey = $('#set-adkey').value.trim(); saveDB(); adStatusLine(); toast('API key saved'); };
  $('#set-ad-open').onclick = () => window.crimson.openExternal('https://alldebrid.com/apikeys');
  $('#set-ad-check').onclick = async () => {
    const out = $('#ad-check-out');
    me.adKey = $('#set-adkey').value.trim(); saveDB(); adStatusLine();
    if (!me.adKey) { out.innerHTML = '<p class="err" style="margin-top:10px">No key entered.</p>'; return; }
    out.innerHTML = '<div class="loading">Checking...</div>';
    try {
      const u = await adGet('/user');
      const usr = u.user || {};
      const until = usr.premiumUntil ? new Date(usr.premiumUntil * 1000).toLocaleDateString() : '';
      out.innerHTML = '<p class="ok" style="margin-top:10px">Connected as <b>' + esc(usr.username || '') + '</b>' + (usr.isPremium ? ' - Premium' + (until ? ' until ' + esc(until) : '') : ' - not premium right now') + '</p>';
    } catch (e) { out.innerHTML = '<p class="err" style="margin-top:10px">' + esc(e.message) + '</p>'; }
  };

  if (isAdminProfile(me)) {
  const profList = () => {
    const z = $('#prof-list'); z.innerHTML = '';
    const sel = $('#pin-reset-sel'); sel.innerHTML = '';
    db.profiles.forEach((p) => {
      const r = document.createElement('div'); r.className = 'file-row';
      r.innerHTML = '<div class="f-name"><b>' + esc(p.name) + '</b>' + (p.isAdmin ? '<span class="kind-tag">ADMIN</span>' : '') + '</div>';
      if (p.id !== me.id) {
        const del = document.createElement('button'); del.className = 'dark-btn small-btn'; del.textContent = 'Delete';
        del.onclick = () => { db.profiles = db.profiles.filter((x) => x.id !== p.id); saveDB(); profList(); toast('Profile deleted'); };
        r.appendChild(del);
      }
      z.appendChild(r);
      const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; sel.appendChild(o);
    });
  };
  profList();

  $('#prof-add').onclick = async () => {
    const name = $('#prof-name').value.trim();
    const pin = $('#prof-pin').value.trim();
    if (!name) { toast('Give the profile a name'); return; }
    if (!/^\d{4,6}$/.test(pin)) { toast('PIN must be 4 to 6 numbers'); return; }
    if (db.profiles.some((p) => p.name.toLowerCase() === name.toLowerCase())) { toast('That name is already used'); return; }
    db.profiles.push({ id: uid(), name, pinHash: await hashPin(pin), isAdmin: false, adKey: '', library: [], history: [] });
    saveDB(); profList();
    $('#prof-name').value = ''; $('#prof-pin').value = '';
    toast('Profile created for ' + name);
  };
  $('#pin-reset-go').onclick = async () => {
    const pin = $('#pin-reset-val').value.trim();
    if (!/^\d{4,6}$/.test(pin)) { toast('PIN must be 4 to 6 numbers'); return; }
    const p = db.profiles.find((x) => x.id === $('#pin-reset-sel').value);
    if (!p) return;
    p.pinHash = await hashPin(pin); saveDB();
    $('#pin-reset-val').value = '';
    toast('PIN reset for ' + p.name);
  };
  }

  const addonList = () => {
    const z = $('#addon-list'); z.innerHTML = '';
    db.addons.forEach((a, i) => {
      const r = document.createElement('div'); r.className = 'file-row';
      r.innerHTML = '<div class="f-name"><b>' + esc(a.name) + '</b><span class="kind-tag">' + esc(a.kind || 'stream') + '</span><br>' + esc(a.base) + '</div>';
      const rm = document.createElement('button'); rm.className = 'dark-btn small-btn'; rm.textContent = 'Remove';
      rm.onclick = () => { db.addons.splice(i, 1); saveDB(); addonList(); };
      r.appendChild(rm); z.appendChild(r);
    });
  };
  addonList();
  $('#set-addon-add').onclick = async () => {
    const url = $('#set-addon-url').value.trim();
    if (!url) return;
    try {
      const man = await getJSON(url);
      const base = url.replace(/\/manifest\.json(\?.*)?$/, '');
      const res = man.resources || [];
      const has = (n) => res.some((r) => (typeof r === 'string' ? r : r.name) === n);
      let kind = 'stream';
      if (has('subtitles') && !has('stream')) kind = 'subtitles';
      db.addons.push({ name: man.name || base, base, kind });
      saveDB();
      $('#set-addon-url').value = '';
      addonList(); toast('Addon added: ' + (man.name || base));
    } catch (e) { toast('Could not load that manifest URL', 4500); }
  };

  if (isAdminProfile(me)) $('#export-btn').onclick = () => {
    const clean = {
      profiles: db.profiles.map((p) => ({ id: p.id, name: p.name, pinHash: p.pinHash, isAdmin: !!p.isAdmin })),
      addons: db.addons
    };
    const blob = new Blob([JSON.stringify(clean, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'torrflix-setup.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('Setup file downloaded - check your Downloads folder');
  };
  if (isAdminProfile(me)) $('#import-btn').onclick = () => {
    if (!window.confirm('Importing replaces all profiles and addons on this PC. Continue?')) return;
    importSetupFile(() => { toast('Setup imported - locking so you can log in fresh'); lockApp(); });
  };
}

/* ---------- wiring ---------- */
document.querySelectorAll('.nav-btn').forEach((b) => {
  b.onclick = () => {
    if (!me) return;
    const n = b.dataset.nav;
    if (n === 'home') { lastListView = 'home'; showView('home'); renderHome(); }
    if (n === 'movies') { lastListView = 'browse'; showView('browse'); renderBrowse('movie'); }
    if (n === 'series') { lastListView = 'browse'; showView('browse'); renderBrowse('series'); }
    if (n === 'upcoming') { showView('upcoming'); renderUpcoming(); }
    if (n === 'library') { showView('library'); renderLibrary(); }
    if (n === 'debrid') { showView('debrid'); renderDebrid(); }
    if (n === 'settings') { showView('settings'); renderSettings(); }
  };
});
$('#back-btn').onclick = () => { if (lastListView === 'browse') { showView('browse'); } else { showView('home'); renderHome(); } };
$('#player-back').onclick = () => { if (currentMeta) { openDetail(currentMeta.type, currentMeta.id); } else { showView('home'); renderHome(); } };
$('#player-copy').onclick = () => { if (currentPlay) { window.crimson.copyText(currentPlay.url); toast('Stream link copied'); } };
let audioGraph = null;
function teardownBoost() {
  const old = $('#player');
  const t = old ? (old.currentTime || 0) : 0;
  const fresh = document.createElement('video');
  fresh.id = 'player'; fresh.controls = true; fresh.autoplay = true;
  if (old) old.replaceWith(fresh);
  if (audioGraph) { try { audioGraph.ac.close(); } catch (e) {} audioGraph = null; }
  if (currentPlay) playUrl(currentPlay.url, currentPlay.title, currentPlay.ctx, t > 5 ? t : 0);
}
$('#boost-sel').onchange = () => {
  const v = parseFloat($('#boost-sel').value);
  if (v === 1 && audioGraph) { teardownBoost(); toast('Volume boost off'); return; }
  const vid = $('#player');
  try {
    if (!audioGraph) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { toast('Volume boost is not supported on this device'); return; }
      const ac = new AC();
      const srcNode = ac.createMediaElementSource(vid);
      const gain = ac.createGain();
      const comp = ac.createDynamicsCompressor();
      comp.threshold.value = -18; comp.ratio.value = 12; comp.attack.value = 0.003; comp.release.value = 0.25;
      srcNode.connect(gain); gain.connect(comp); comp.connect(ac.destination);
      audioGraph = { ac, gain };
    }
    if (audioGraph.ac.state === 'suspended') audioGraph.ac.resume();
    audioGraph.gain.gain.value = v;
    toast(v > 1 ? 'Volume boost ' + v + 'x' : 'Volume boost off');
  } catch (e) { toast('Boost would not start on this stream. If the sound ever cuts out with boost on, restart the app.', 5000); }
};
$('#lock-btn').onclick = lockApp;

const doSearch = () => {
  const q = $('#search-input').value.trim();
  if (!q || !me) return;
  lastListView = 'browse'; showView('browse'); renderSearch(q);
};
$('#search-btn').onclick = doSearch;
$('#search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

renderLock();
