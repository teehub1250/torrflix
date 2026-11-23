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
      '<label>Repeat the PIN</label><input id="lk-pin2" type="passwor
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
        days.push({ iso, label: (i === 0 ? 'Today - ' : i === 1 ? 'Tomorrow - ' : '') + d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) });d" inputmode="numeric" maxlength="6" placeholder="PIN again">' +
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
