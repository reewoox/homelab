'use strict';
/* Homelab — front-end (GitHub Pages) qui parle à l'API sur ton PC */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

const state = { api: '', token: store.get('hl_token'), user: null, board: null, status: {}, editing: false, health: null, page: 'home', remote: null };

// Accès « direct » : depuis le PC, le réseau local ou Tailscale → on peut ouvrir les adresses locales/Tailscale
const isLocalAccess = () => /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname);
const absUrl = (u) => (/^https?:/.test(u) ? u : (state.api || location.origin) + u);
const fmtSize = (n) => {
  if (n == null) return '';
  const u = ['o', 'Ko', 'Mo', 'Go', 'To']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
};
const timeAgo = (ts) => {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'à l’instant';
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
};
const deviceName = () => {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android' : 'Tablette Android';
  if (/Windows/.test(ua)) return 'PC Windows';
  if (/Mac/.test(ua)) return 'Mac';
  return 'Appareil';
};

// ---------- API ----------
async function resolveApi() {
  const override = store.get('hl_api');
  if (override) return override;
  try {
    const r = await fetch(`config.json?t=${Date.now()}`, { cache: 'no-store' });
    const c = await r.json();
    return (c.apiUrl || '').replace(/\/$/, '');
  } catch { return ''; }
}
async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  let res;
  try {
    res = await fetch(state.api + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw Object.assign(new Error('Serveur injoignable'), { offline: true });
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token && !path.startsWith('/api/auth/')) { logout(); }
  if (!res.ok) throw Object.assign(new Error(data.error || `Erreur ${res.status}`), { status: res.status });
  return data;
}

// ---------- Vues ----------
function show(view) {
  $$('.view').forEach((v) => (v.hidden = v.id !== `view-${view}`));
}
function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 3500);
}

async function boot() {
  show('loading');
  state.api = await resolveApi();
  try {
    state.health = await api('/api/health');
  } catch {
    $('#api-input').value = store.get('hl_api') || '';
    return show('offline');
  }
  document.title = state.health.title;
  $('#auth-title').textContent = state.health.title;
  if (state.token) {
    try {
      state.user = (await api('/api/auth/me')).user;
      return enterApp();
    } catch (e) {
      if (e.offline) return show('offline');
      state.token = null; store.set('hl_token', null);
    }
  }
  showAuth(state.health.hasUsers ? 'login' : 'register');
}

$('#retry').onclick = boot;
$('#api-form').onsubmit = (e) => { e.preventDefault(); store.set('hl_api', $('#api-input').value.trim().replace(/\/$/, '') || null); boot(); };
$('#api-reset').onclick = () => { store.set('hl_api', null); boot(); };

// ---------- Auth ----------
let authMode = 'login';
function showAuth(mode) {
  authMode = mode;
  const h = state.health;
  const first = !h.hasUsers;
  const regClosed = h.hasUsers && h.registration === 'closed';
  $('#first-run').hidden = !first;
  $('#auth-tabs').hidden = first || regClosed;
  if (regClosed) authMode = mode = 'login';
  $$('#auth-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === mode));
  $$('[data-only="register"]').forEach((el) => (el.hidden = mode !== 'register'));
  $('#auth-form [name=confirm]').required = mode === 'register';
  $('#auth-form [name=password]').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  $('#auth-submit').textContent = mode === 'register' ? (first ? 'Créer le compte admin' : 'Créer mon compte') : 'Se connecter';
  $('#auth-error').hidden = $('#auth-success').hidden = true;
  show('auth');
  $('#auth-form [name=username]').focus();
}
$$('#auth-tabs button').forEach((b) => (b.onclick = () => showAuth(b.dataset.tab)));

$('#auth-form').onsubmit = async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const err = $('#auth-error'), ok = $('#auth-success'), btn = $('#auth-submit');
  err.hidden = ok.hidden = true;
  if (authMode === 'register' && f.password !== f.confirm) { err.textContent = 'Les mots de passe ne correspondent pas'; err.hidden = false; return; }
  btn.disabled = true;
  try {
    const data = await api(`/api/auth/${authMode}`, { method: 'POST', body: f });
    if (data.pending) {
      ok.textContent = data.message; ok.hidden = false;
      e.target.reset();
      return;
    }
    state.token = data.token; store.set('hl_token', data.token);
    state.user = data.user;
    state.health.hasUsers = true;
    e.target.reset();
    enterApp();
  } catch (ex) {
    err.textContent = ex.message; err.hidden = false;
  } finally { btn.disabled = false; }
};

function logout() {
  pages[state.page]?.leave?.();
  state.page = 'home';
  state.token = null; state.user = null; store.set('hl_token', null);
  stopTimers();
  setEditing(false);
  if (state.health) showAuth('login'); else boot();
}

// ---------- Application ----------
let timers = [];
function stopTimers() { timers.forEach(clearInterval); timers = []; }

async function enterApp() {
  const u = state.user;
  $('#avatar').textContent = u.username[0].toUpperCase();
  $('#menu-name').textContent = u.username;
  $('#menu-role').textContent = u.role === 'admin' ? 'Administrateur' : 'Utilisateur';
  $$('.admin-only').forEach((el) => (el.hidden = u.role !== 'admin'));
  show('app');
  await loadBoard();
  tickClock();
  loadSystem();
  loadStatus();
  loadDevices();
  stopTimers();
  timers.push(setInterval(tickClock, 1000), setInterval(loadSystem, 5000), setInterval(loadStatus, 30000), setInterval(loadWeather, 30 * 60e3), setInterval(loadDevices, 60e3));
  route();
}

// ---------- Navigation entre les pages ----------
const PAGES = { home: 'Accueil', drive: 'Drive', clip: 'Presse-papiers', ai: 'Assistant IA', monitor: 'Moniteur' };
const pages = {}; // remplis par pages/*.js : { enter(el), leave() }
function route() {
  if (!state.user) return;
  const name = (location.hash.match(/^#\/(\w+)/) || [])[1] || 'home';
  const page = PAGES[name] ? name : 'home';
  if (state.page !== page) pages[state.page]?.leave?.();
  state.page = page;
  $$('.page').forEach((p) => (p.hidden = p.id !== `page-${page}`));
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === page));
  $('#page-title').textContent = PAGES[page];
  $('#view-app').dataset.page = page;
  if (page !== 'home' && state.editing) setEditing(false);
  if (page !== 'home') pages[page]?.enter?.($(`#page-${page}`));
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

async function loadBoard() {
  try {
    state.board = await api('/api/board');
  } catch (e) {
    if (e.offline) return show('offline');
    return toast(e.message, true);
  }
  applySettings(state.board.settings);
  renderBoard();
  loadWeather();
}

function applySettings(s) {
  document.title = s.title;
  $('#title').textContent = s.title;
  $('#title-m').textContent = s.title;
  if (s.accent) document.documentElement.style.setProperty('--accent', s.accent);
  const bg = $('#bg');
  if (s.background) { bg.style.backgroundImage = `url("${encodeURI(s.background)}")`; bg.classList.add('has-image'); }
  else { bg.style.backgroundImage = ''; bg.classList.remove('has-image'); }
}

// ---------- Icônes ----------
const ICON_CDN = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons';
const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const isEmoji = (s) => s && !/^[\w.-]+$/.test(s) && !/^https?:/.test(s) && [...s].length <= 3;
function letterColor(name) {
  let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 45%)`;
}
function iconHtml(icon, name) {
  const letter = `<div class="letter" style="background:${letterColor(name)}">${esc(String(name || '?')[0].toUpperCase())}</div>`;
  if (!icon) icon = slug(name);
  if (isEmoji(icon)) return `<span>${esc(icon)}</span>`;
  const src = /^https?:\/\//.test(icon) ? icon : `${ICON_CDN}/svg/${slug(icon)}.svg`;
  const png = /^https?:\/\//.test(icon) ? '' : `${ICON_CDN}/png/${slug(icon)}.png`;
  return `<img src="${esc(src)}" alt="" loading="lazy" data-png="${esc(png)}" data-letter="${esc(letter)}">`;
}
// Repli : svg → png → lettre
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName !== 'IMG' || !img.dataset.letter) return;
  if (img.dataset.png && img.src !== img.dataset.png) { img.src = img.dataset.png; img.dataset.png = ''; return; }
  img.outerHTML = img.dataset.letter;
}, true);

// ---------- Rendu du tableau ----------
function renderBoard() {
  const board = $('#board');
  const q = $('#search').value.trim().toLowerCase();
  const admin = state.user.role === 'admin';
  let shown = 0;
  board.classList.toggle('editing', state.editing);
  board.innerHTML = state.board.categories.map((c, ci) => {
    const apps = c.apps.filter((a) => !q || `${a.name} ${a.description} ${a.url}`.toLowerCase().includes(q));
    shown += apps.length;
    if (q && !apps.length) return '';
    if (!state.editing && !apps.length) return '';
    return `<section class="category" data-cat="${c.id}">
      <div class="category-head">
        <h2>${esc(c.name)}</h2><span class="count">${apps.length}</span>
        ${state.editing ? `<div class="tools">
          <button class="icon-btn" data-act="cat-up" title="Monter" ${ci === 0 ? 'disabled' : ''}>↑</button>
          <button class="icon-btn" data-act="cat-down" title="Descendre" ${ci === state.board.categories.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="icon-btn" data-act="cat-edit" title="Renommer">✎</button>
          <button class="icon-btn" data-act="cat-del" title="Supprimer">🗑</button>
        </div>` : ''}
      </div>
      <div class="apps" data-cat="${c.id}">
        ${apps.map((a) => tileHtml(a)).join('')}
        ${state.editing ? `<button class="card tile add-tile" data-act="add-app"><span class="plus">+</span><span>Ajouter</span></button>` : ''}
      </div>
    </section>`;
  }).join('') || (admin
    ? `<div class="empty muted">Aucune app pour l’instant. Passe en <b>mode édition</b> (✏️) pour en ajouter.</div>`
    : `<div class="empty muted">Aucune application disponible pour l’instant.</div>`);
  $('#no-results').hidden = !q || shown > 0;
  paintStatus();
}

function tileHtml(a) {
  const st = state.status[a.id];
  const dot = a.ping ? `<span class="dot ${st ? (st.up ? 'up' : 'down') : ''}" title="${st ? (st.up ? `En ligne · ${st.ms} ms` : `Hors ligne · ${esc(st.error || st.code)}`) : 'Vérification…'}"></span>` : '';
  const href = appHref(a);
  const attrs = state.editing
    ? `role="button" tabindex="0" draggable="true"`
    : `href="${esc(href)}" ${a.new_tab ? 'target="_blank" rel="noopener noreferrer"' : ''}`;
  const badge = a.remote_url ? '<span class="badge-remote" title="Accessible de partout via Tailscale">🌐</span>'
    : a.remote ? '<span class="badge-remote" title="Activation Tailscale en cours…">⏳</span>'
    : (!isLocalAccess() && isPrivate(a.url)) ? '<span class="badge-remote" title="Adresse locale : ne marche que chez toi. Active « Accessible de partout » dans l’édition de l’app.">🏠</span>' : '';
  return `<a class="card tile" data-app="${a.id}" ${attrs}>
    ${dot}${badge}${a.admin_only ? '<span class="lock" title="Visible par les admins seulement">🔒</span>' : ''}
    <div class="ico">${iconHtml(a.icon, a.name)}</div>
    <div class="name">${esc(a.name)}</div>
    ${a.description ? `<div class="desc">${esc(a.description)}</div>` : ''}
  </a>`;
}

const isPrivate = (u) => { try { return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|[^.]+$)/.test(new URL(u).hostname); } catch { return false; } };
// Hors de chez toi, une app locale s'ouvre via son adresse Tailscale
function appHref(a) {
  if (a.remote_url && (!isLocalAccess() || !/^(localhost|127\.)/.test(location.hostname))) return a.remote_url;
  return a.url;
}

function paintStatus() {
  $$('.tile[data-app]').forEach((t) => {
    const st = state.status[t.dataset.app];
    const dot = $('.dot', t);
    if (!dot || !st) return;
    dot.className = `dot ${st.up ? 'up' : 'down'}`;
    dot.title = st.up ? `En ligne · ${st.ms} ms` : `Hors ligne · ${st.error || st.code}`;
  });
}
async function loadStatus() {
  try { state.status = await api('/api/status'); paintStatus(); } catch {}
}

const findApp = (id) => state.board.categories.flatMap((c) => c.apps).find((a) => a.id === Number(id));

// Clics dans le tableau
$('#board').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  const catEl = e.target.closest('.category');
  const catId = catEl && Number(catEl.dataset.cat);
  if (btn) {
    e.preventDefault();
    const act = btn.dataset.act;
    if (act === 'add-app') return editApp(null, catId);
    if (act === 'cat-edit') return editCategory(state.board.categories.find((c) => c.id === catId));
    if (act === 'cat-del') return deleteCategory(catId);
    if (act === 'cat-up' || act === 'cat-down') return moveCategory(catId, act === 'cat-up' ? -1 : 1);
  }
  const tile = e.target.closest('.tile[data-app]');
  if (tile && state.editing) { e.preventDefault(); editApp(findApp(tile.dataset.app)); }
});
$('#board').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && state.editing && e.target.matches('.tile[data-app]')) editApp(findApp(e.target.dataset.app));
});

// ---------- Glisser-déposer ----------
let dragId = null;
$('#board').addEventListener('dragstart', (e) => {
  const t = e.target.closest('.tile[data-app]');
  if (!t || !state.editing) return;
  dragId = t.dataset.app;
  t.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragId);
});
$('#board').addEventListener('dragend', () => { $$('.dragging, .drop-target').forEach((el) => el.classList.remove('dragging', 'drop-target')); dragId = null; });
$('#board').addEventListener('dragover', (e) => {
  const zone = e.target.closest('.apps');
  if (!zone || !dragId) return;
  e.preventDefault();
  $$('.drop-target').forEach((el) => el !== zone && el.classList.remove('drop-target'));
  zone.classList.add('drop-target');
  const dragged = $(`.tile[data-app="${dragId}"]`);
  const over = e.target.closest('.tile[data-app]');
  const add = $('.add-tile', zone);
  if (over && over !== dragged) {
    const r = over.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    zone.insertBefore(dragged, after ? over.nextSibling : over);
  } else if (!over && !zone.contains(dragged)) {
    zone.insertBefore(dragged, add);
  }
});
$('#board').addEventListener('drop', async (e) => {
  if (!dragId) return;
  e.preventDefault();
  const apps = {};
  $$('#board .apps').forEach((z) => (apps[z.dataset.cat] = $$('.tile[data-app]', z).map((t) => Number(t.dataset.app))));
  try {
    await api('/api/reorder', { method: 'POST', body: { apps } });
    await loadBoard();
  } catch (ex) { toast(ex.message, true); loadBoard(); }
});

// ---------- Mode édition ----------
function setEditing(on) {
  state.editing = on;
  $('#edit-banner').hidden = !on;
  $('#toggle-edit').classList.toggle('active', on);
  if (state.board) renderBoard();
}
$('#toggle-edit').onclick = () => setEditing(!state.editing);
$('#exit-edit').onclick = () => setEditing(false);
$('#add-app').onclick = () => editApp(null);
$('#add-category').onclick = () => editCategory(null);

// Détection automatique des services qui tournent sur le PC
$('#discover').onclick = async () => {
  toast('Recherche des services sur le PC…');
  let found;
  try { found = await api('/api/discover'); } catch (e) { return toast(e.message, true); }
  if (!found.length) return toast('Aucun nouveau service détecté (tout est déjà ajouté 👍)');
  const cats = state.board.categories;
  openModal({
    title: `${found.length} service(s) détecté(s)`,
    body: `<div class="stack">
      <p class="muted" style="margin:0">Coche ceux à ajouter à ton tableau de bord.</p>
      ${found.map((f, i) => `<label class="check found">
        <input type="checkbox" name="pick" value="${i}" checked>
        <span class="ico">${iconHtml(f.icon, f.name)}</span>
        <span><input name="name-${i}" value="${esc(f.name)}" maxlength="60"><span class="hint">${esc(f.url)}${f.title && f.title !== f.name ? ` · « ${esc(f.title)} »` : ''}</span></span>
      </label>`).join('')}
      <label>Catégorie<select name="category">
        <option value="new">➕ Nouvelle catégorie « Sur mon PC »</option>
        ${cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
      </select></label>
      <label class="check"><input type="checkbox" name="remote" checked> 🌐 Les rendre accessibles de partout (Tailscale)</label>
    </div>`,
    footer: `<button class="btn ghost" value="cancel" formnovalidate>Annuler</button><button class="btn primary" value="ok">Ajouter</button>`,
    async onSubmit(fd) {
      const picks = fd.getAll('pick').map(Number);
      if (!picks.length) return;
      let catId = fd.get('category');
      if (catId === 'new') catId = (await api('/api/categories', { method: 'POST', body: { name: 'Sur mon PC' } })).id;
      for (const i of picks) {
        const f = found[i];
        await api('/api/apps', { method: 'POST', body: { name: fd.get(`name-${i}`) || f.name, url: f.url, icon: f.icon, category_id: Number(catId), remote: fd.has('remote'), new_tab: true, ping: true } });
      }
      await loadBoard();
      setTimeout(loadBoard, 7000);
      toast(`${picks.length} app(s) ajoutée(s) 🎉`);
    },
  });
};

async function moveCategory(id, dir) {
  const ids = state.board.categories.map((c) => c.id);
  const i = ids.indexOf(id);
  const j = i + dir;
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await api('/api/reorder', { method: 'POST', body: { categories: ids } }).catch((e) => toast(e.message, true));
  loadBoard();
}
async function deleteCategory(id) {
  const c = state.board.categories.find((x) => x.id === id);
  if (!confirm(`Supprimer la catégorie « ${c.name} » et ses ${c.apps.length} app(s) ?`)) return;
  await api(`/api/categories/${id}`, { method: 'DELETE' }).catch((e) => toast(e.message, true));
  loadBoard();
}

// ---------- Modale ----------
const modal = $('#modal');
function openModal({ title, body, footer, onSubmit, wide = false, onOpen }) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  $('#modal-footer').innerHTML = footer ?? `<button class="btn ghost" value="cancel" formnovalidate>Annuler</button><button class="btn primary" value="ok">Enregistrer</button>`;
  $('#modal-error').hidden = true;
  modal.classList.toggle('wide', wide);
  modal._submit = onSubmit;
  modal.showModal();
  onOpen?.();
  $('#modal-body input:not([type=checkbox])')?.focus();
}
$('#modal-form').addEventListener('submit', async (e) => {
  const action = e.submitter?.value;
  if (action === 'cancel' || !modal._submit) return;
  e.preventDefault();
  const err = $('#modal-error');
  err.hidden = true;
  if (e.submitter) e.submitter.disabled = true;
  try {
    const fd = new FormData(e.target);
    const res = await modal._submit(fd, action);
    if (res !== false) modal.close();
  } catch (ex) {
    err.textContent = ex.message; err.hidden = false;
  } finally { if (e.submitter) e.submitter.disabled = false; }
});
modal.addEventListener('close', () => { modal._submit = null; });

function editCategory(cat) {
  openModal({
    title: cat ? 'Renommer la catégorie' : 'Nouvelle catégorie',
    body: `<label>Nom<input name="name" required maxlength="60" value="${esc(cat?.name)}" placeholder="ex. Médias, Réseau, Domotique…"></label>`,
    async onSubmit(fd) {
      const name = fd.get('name');
      if (cat) await api(`/api/categories/${cat.id}`, { method: 'PUT', body: { name } });
      else await api('/api/categories', { method: 'POST', body: { name } });
      await loadBoard();
    },
  });
}

const POPULAR = ['plex', 'jellyfin', 'emby', 'sonarr', 'radarr', 'lidarr', 'prowlarr', 'qbittorrent', 'transmission', 'overseerr', 'jellyseerr', 'tautulli', 'home-assistant', 'pi-hole', 'adguard-home', 'nextcloud', 'immich', 'photoprism', 'vaultwarden', 'bitwarden', 'portainer', 'proxmox', 'truenas', 'unraid', 'synology', 'grafana', 'prometheus', 'uptime-kuma', 'nginx-proxy-manager', 'traefik', 'gitea', 'github', 'gitlab', 'code-server', 'vscode', 'n8n', 'node-red', 'paperless-ngx', 'syncthing', 'tailscale', 'cloudflare', 'docker', 'ollama', 'open-webui', 'comfyui', 'stable-diffusion', 'youtube', 'netflix', 'spotify', 'discord', 'twitch', 'google-drive', 'gmail', 'chatgpt', 'claude', 'notion', 'obsidian', 'figma', 'router', 'wireguard', 'minecraft', 'steam', 'frigate', 'mealie', 'actual-budget', 'firefly-iii', 'homarr', 'dashy', 'speedtest-tracker'];

function editApp(app, catId) {
  const cats = state.board.categories;
  if (!cats.length) { toast('Crée d’abord une catégorie', true); return editCategory(null); }
  const sel = app?.category_id ?? catId ?? cats[0].id;
  openModal({
    title: app ? `Modifier ${app.name}` : 'Nouvelle application',
    body: `<div class="stack">
      <div class="grid2">
        <label>Nom<input name="name" required maxlength="60" value="${esc(app?.name)}" placeholder="Jellyfin"></label>
        <label>Catégorie<select name="category_id">${cats.map((c) => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      </div>
      <label>Adresse (URL)<input name="url" required type="url" value="${esc(app?.url)}" placeholder="http://192.168.1.10:8096 ou https://…"></label>
      <label>Icône <span class="hint">— nom d’icône (dashboard-icons), URL d’image ou emoji</span>
        <div class="icon-preview"><div class="ico" id="icon-prev"></div><input name="icon" list="icon-list" value="${esc(app?.icon)}" placeholder="auto (d’après le nom)"></div>
      </label>
      <datalist id="icon-list">${POPULAR.map((p) => `<option value="${p}">`).join('')}</datalist>
      <label>Description <span class="hint">(optionnel)</span><input name="description" maxlength="200" value="${esc(app?.description)}" placeholder="Films & séries"></label>
      <label>URL de vérification <span class="hint">— optionnel, si différente (ex. adresse locale)</span><input name="ping_url" type="url" value="${esc(app?.ping_url)}" placeholder="http://localhost:8096"></label>
      <label class="check remote-check"><input type="checkbox" name="remote" ${app?.remote ? 'checked' : ''}>
        <span>🌐 <b>Accessible de partout</b> <span class="hint">— pour une app locale : crée une adresse HTTPS Tailscale, utilisable depuis ton iPhone, ta tablette… (appareils connectés à Tailscale)</span></span></label>
      ${app?.remote_url ? `<p class="hint" style="margin:-6px 0 0 26px">Adresse : <a href="${esc(app.remote_url)}" target="_blank" rel="noopener">${esc(app.remote_url)}</a></p>` : ''}
      <div class="row" style="gap:18px">
        <label class="check"><input type="checkbox" name="new_tab" ${app?.new_tab === 0 ? '' : 'checked'}> Nouvel onglet</label>
        <label class="check"><input type="checkbox" name="ping" ${app?.ping === 0 ? '' : 'checked'}> Vérifier l’état</label>
        <label class="check"><input type="checkbox" name="admin_only" ${app?.admin_only ? 'checked' : ''}> Admins seulement</label>
      </div>
    </div>`,
    footer: `${app ? '<button class="btn danger left" value="delete" formnovalidate>Supprimer</button>' : ''}
      <button class="btn ghost" value="cancel" formnovalidate>Annuler</button><button class="btn primary" value="ok">${app ? 'Enregistrer' : 'Ajouter'}</button>`,
    onOpen() {
      const f = $('#modal-form');
      const upd = () => ($('#icon-prev').innerHTML = iconHtml(f.icon.value.trim(), f.name.value.trim() || '?'));
      f.icon.oninput = upd; f.name.oninput = upd; upd();
    },
    async onSubmit(fd, action) {
      if (action === 'delete') {
        if (!confirm(`Supprimer ${app.name} ?`)) return false;
        await api(`/api/apps/${app.id}`, { method: 'DELETE' });
        await loadBoard();
        return toast(`${app.name} supprimée`);
      }
      const body = {
        name: fd.get('name'), category_id: Number(fd.get('category_id')), url: fd.get('url'),
        icon: fd.get('icon'), description: fd.get('description'), ping_url: fd.get('ping_url'),
        new_tab: fd.has('new_tab'), ping: fd.has('ping'), admin_only: fd.has('admin_only'), remote: fd.has('remote'),
      };
      if (app) await api(`/api/apps/${app.id}`, { method: 'PUT', body });
      else await api('/api/apps', { method: 'POST', body });
      await loadBoard();
      setTimeout(loadStatus, 2500);
      if (body.remote) setTimeout(loadBoard, 6000); // l'adresse Tailscale arrive quelques secondes après
      toast(app ? 'Modifications enregistrées' : `${body.name} ajoutée 🎉`);
    },
  });
}

// ---------- Réglages (admin) ----------
$('#open-settings').onclick = openSettings;
async function openSettings() {
  const s = state.board.settings;
  let users = [];
  try { users = await api('/api/users'); } catch (e) { toast(e.message, true); }
  const me = state.user.id;
  const pending = users.filter((u) => u.status === 'pending').length;
  openModal({
    title: 'Réglages',
    wide: true,
    body: `<div class="stack">
      <div class="section-title">Général</div>
      <div class="grid2">
        <label>Nom du homelab<input name="title" maxlength="60" value="${esc(s.title)}"></label>
        <label>Couleur d’accent<input name="accent" type="color" value="${esc(s.accent || '#fa5252')}" style="height:40px;padding:4px"></label>
      </div>
      <label>Image de fond <span class="hint">(URL, optionnel)</span><input name="background" type="url" value="${esc(s.background)}" placeholder="https://images.unsplash.com/…"></label>
      <label>Dossier du Drive sur le PC <span class="hint">(chaque utilisateur y a son sous-dossier + un dossier « Commun »)</span><input name="driveRoot" value="${esc(s.driveRoot)}"></label>
      <div class="grid2">
        <label>Ville pour la météo<input name="weatherCity" value="${esc(s.weatherCity)}"></label>
        <label>Inscriptions<select name="registration">
          <option value="approval" ${s.registration === 'approval' ? 'selected' : ''}>Sur validation d’un admin</option>
          <option value="open" ${s.registration === 'open' ? 'selected' : ''}>Ouvertes à tous</option>
          <option value="closed" ${s.registration === 'closed' ? 'selected' : ''}>Fermées</option>
        </select></label>
      </div>

      <div class="section-title">Utilisateurs ${pending ? `<span class="pill pending">${pending} en attente</span>` : ''}</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Utilisateur</th><th>Rôle</th><th>Statut</th><th>Dernière connexion</th><th></th></tr></thead>
        <tbody>${users.map((u) => `<tr data-user="${u.id}">
          <td><b>${esc(u.username)}</b><br><span class="muted" style="font-size:12px">${esc(u.email || '')}</span></td>
          <td><span class="pill ${u.role}">${u.role === 'admin' ? 'Admin' : 'Utilisateur'}</span></td>
          <td><span class="pill ${u.status}">${{ active: 'Actif', pending: 'En attente', disabled: 'Désactivé' }[u.status]}</span></td>
          <td class="muted">${u.last_login ? new Date(u.last_login + 'Z').toLocaleString('fr-FR') : '—'}</td>
          <td>${u.id === me ? '<span class="muted">(toi)</span>' : `<div class="row">
            ${u.status !== 'active' ? `<button class="btn small" type="button" data-uact="approve">${u.status === 'pending' ? 'Valider' : 'Réactiver'}</button>` : `<button class="btn small" type="button" data-uact="disable">Désactiver</button>`}
            <button class="btn small" type="button" data-uact="role">${u.role === 'admin' ? 'Retirer admin' : 'Rendre admin'}</button>
            <button class="btn small danger" type="button" data-uact="delete">Supprimer</button>
          </div>`}</td>
        </tr>`).join('')}</tbody>
      </table></div>

      <div class="section-title">Sauvegarde</div>
      <div class="row">
        <button class="btn" type="button" id="export">⬇ Exporter les apps</button>
        <button class="btn" type="button" id="import">⬆ Importer…</button>
        <input type="file" id="import-file" accept="application/json" hidden>
      </div>
    </div>`,
    onOpen() {
      $$('[data-uact]').forEach((b) => (b.onclick = () => userAction(b.closest('tr').dataset.user, b.dataset.uact, users)));
      $('#export').onclick = exportData;
      $('#import').onclick = () => $('#import-file').click();
      $('#import-file').onchange = importData;
    },
    async onSubmit(fd) {
      const body = Object.fromEntries(fd);
      if (body.weatherCity && body.weatherCity !== s.weatherCity) {
        const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=fr&name=${encodeURIComponent(body.weatherCity)}`).then((r) => r.json()).catch(() => ({}));
        const hit = g.results?.[0];
        if (!hit) throw new Error(`Ville « ${body.weatherCity} » introuvable`);
        Object.assign(body, { weatherCity: hit.name, weatherLat: String(hit.latitude), weatherLon: String(hit.longitude) });
      }
      await api('/api/settings', { method: 'PUT', body });
      await loadBoard();
      toast('Réglages enregistrés');
    },
  });
}
async function userAction(id, act, users) {
  const u = users.find((x) => x.id === Number(id));
  try {
    if (act === 'delete') {
      if (!confirm(`Supprimer le compte ${u.username} ?`)) return;
      await api(`/api/users/${id}`, { method: 'DELETE' });
    } else if (act === 'approve') await api(`/api/users/${id}`, { method: 'PUT', body: { status: 'active' } });
    else if (act === 'disable') await api(`/api/users/${id}`, { method: 'PUT', body: { status: 'disabled' } });
    else if (act === 'role') await api(`/api/users/${id}`, { method: 'PUT', body: { role: u.role === 'admin' ? 'user' : 'admin' } });
    modal.close();
    openSettings();
  } catch (e) { toast(e.message, true); }
}
async function exportData() {
  const data = await api('/api/export');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = `homelab-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
async function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (!confirm('Remplacer toutes les catégories et apps par celles du fichier ?')) return;
  try {
    await api('/api/import', { method: 'POST', body: JSON.parse(await file.text()) });
    modal.close();
    await loadBoard();
    toast('Sauvegarde restaurée');
  } catch (ex) { toast(ex.message || 'Fichier invalide', true); }
}

// ---------- Compte ----------
$('#avatar').onclick = (e) => { e.stopPropagation(); $('#user-menu').hidden = !$('#user-menu').hidden; };
document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) $('#user-menu').hidden = true; });
$('#menu-logout').onclick = logout;
$('#menu-password').onclick = () => {
  $('#user-menu').hidden = true;
  openModal({
    title: 'Changer de mot de passe',
    body: `<div class="stack">
      <label>Mot de passe actuel<input name="current" type="password" required autocomplete="current-password"></label>
      <label>Nouveau mot de passe<input name="next" type="password" required minlength="8" autocomplete="new-password"></label>
      <label>Confirmer<input name="confirm" type="password" required minlength="8" autocomplete="new-password"></label>
    </div>`,
    async onSubmit(fd) {
      if (fd.get('next') !== fd.get('confirm')) throw new Error('Les mots de passe ne correspondent pas');
      const { token } = await api('/api/auth/password', { method: 'POST', body: { current: fd.get('current'), next: fd.get('next') } });
      state.token = token; store.set('hl_token', token);
      toast('Mot de passe modifié (les autres sessions sont déconnectées)');
    },
  });
};

// ---------- Recherche ----------
$('#search').addEventListener('input', () => renderBoard());
$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.target.value = ''; renderBoard(); e.target.blur(); }
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim();
  if (!q) return;
  const tiles = $$('#board .tile[data-app]');
  if (tiles.length === 1 && !state.editing) {
    const a = findApp(tiles[0].dataset.app);
    return window.open(appHref(a), a.new_tab ? '_blank' : '_self', 'noopener');
  }
  window.open(`https://www.google.com/search?q=${encodeURIComponent(q)}`, '_blank', 'noopener');
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && state.page === 'home' && !e.target.closest('input, textarea, select') && !$('#view-app').hidden && !modal.open) { e.preventDefault(); $('#search').focus(); }
});

// ---------- Widget « Mes appareils » (Tailscale) ----------
const OS_ICON = { windows: '💻', macOS: '💻', linux: '🐧', iOS: '📱', android: '📱' };
async function loadDevices() {
  try {
    state.remote = await api('/api/remote');
    const r = state.remote;
    const el = $('#devices');
    if (!r.available) { el.innerHTML = `<div class="head"><b>🛰️ Tailscale</b></div><div class="muted">Tailscale n’est pas connecté sur le PC.</div>`; return; }
    const all = [{ ...r.self, me: true }, ...r.peers].sort((a, b) => b.online - a.online);
    el.innerHTML = `<div class="head"><b>🛰️ Mes appareils</b><span class="muted">${all.filter((d) => d.online).length}/${all.length} en ligne</span></div>
      <ul class="dev-list">${all.map((d) => `<li><span class="dev-ico">${OS_ICON[d.os] || '🖥️'}</span><span class="dev-name">${esc(d.name)}${d.me ? ' <span class="muted">(ce PC)</span>' : ''}</span>
        <span class="dev-st ${d.online ? 'on' : ''}">${d.online ? 'en ligne' : d.lastSeen && !d.lastSeen.startsWith('0001') ? `vu ${timeAgo(Date.parse(d.lastSeen))}` : 'hors ligne'}</span></li>`).join('')}</ul>
      ${state.board?.tailnetUrl ? `<a class="hint" href="${esc(state.board.tailnetUrl)}" target="_blank" rel="noopener">Accès direct Tailscale ↗</a>` : ''}`;
    $('#side-foot').textContent = r.dnsName ? `🛰️ ${r.dnsName.split('.')[0]} · Tailscale` : '';
  } catch {}
}

// ---------- Boîte à outils partagée avec pages/*.js ----------
window.HL = { $, $$, esc, api, state, toast, openModal, modal, pages, fmtSize, timeAgo, absUrl, deviceName, iconHtml, store };

// ---------- Widgets ----------
function tickClock() {
  const d = new Date();
  const h = d.getHours();
  $('#greet').textContent = `${h < 5 ? 'Bonne nuit' : h < 12 ? 'Bonjour' : h < 18 ? 'Bon après-midi' : 'Bonsoir'}, ${state.user?.username ?? ''} 👋`;
  $('#clock').textContent = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  $('#date').textContent = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

const WMO = { 0: ['☀️', 'Ciel dégagé'], 1: ['🌤️', 'Peu nuageux'], 2: ['⛅', 'Partiellement nuageux'], 3: ['☁️', 'Couvert'], 45: ['🌫️', 'Brouillard'], 48: ['🌫️', 'Brouillard givrant'], 51: ['🌦️', 'Bruine légère'], 53: ['🌦️', 'Bruine'], 55: ['🌧️', 'Bruine forte'], 61: ['🌦️', 'Pluie faible'], 63: ['🌧️', 'Pluie'], 65: ['🌧️', 'Forte pluie'], 66: ['🌧️', 'Pluie verglaçante'], 67: ['🌧️', 'Pluie verglaçante'], 71: ['🌨️', 'Neige faible'], 73: ['🌨️', 'Neige'], 75: ['❄️', 'Forte neige'], 77: ['🌨️', 'Grains de neige'], 80: ['🌦️', 'Averses'], 81: ['🌧️', 'Averses'], 82: ['⛈️', 'Fortes averses'], 85: ['🌨️', 'Averses de neige'], 86: ['❄️', 'Averses de neige'], 95: ['⛈️', 'Orage'], 96: ['⛈️', 'Orage + grêle'], 99: ['⛈️', 'Orage + grêle'] };
async function loadWeather() {
  const s = state.board?.settings;
  if (!s?.weatherLat) return;
  try {
    const w = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${s.weatherLat}&longitude=${s.weatherLon}&current=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=4`).then((r) => r.json());
    const [ico, label] = WMO[w.current.weather_code] || ['🌡️', ''];
    $('#weather').innerHTML = `<div class="big">${ico}</div>
      <div>
        <div class="temp">${Math.round(w.current.temperature_2m)}°</div>
        <div class="muted">${esc(label)} · ${esc(s.weatherCity)}</div>
        <div class="days">${w.daily.time.slice(1).map((t, i) => `<div><span class="muted">${new Date(t).toLocaleDateString('fr-FR', { weekday: 'short' })}</span><span>${(WMO[w.daily.weather_code[i + 1]] || ['🌡️'])[0]}</span><span>${Math.round(w.daily.temperature_2m_max[i + 1])}° <span class="muted">${Math.round(w.daily.temperature_2m_min[i + 1])}°</span></span></div>`).join('')}</div>
      </div>`;
  } catch { $('#weather').innerHTML = '<div class="muted">Météo indisponible</div>'; }
}

const gb = (n) => (n / 1024 ** 3).toFixed(n > 100 * 1024 ** 3 ? 0 : 1);
const level = (p) => (p >= 90 ? 'crit' : p >= 75 ? 'hot' : '');
const meter = (label, pct, detail) => `<div class="meter"><div class="lbl"><span>${label}</span><span class="muted">${detail}</span></div><div class="bar"><i class="${level(pct)}" style="width:${pct}%"></i></div></div>`;
function fmtUptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d} j ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}
async function loadSystem() {
  try {
    const s = await api('/api/system');
    const memUsed = s.memory.total - s.memory.free;
    const memPct = Math.round((100 * memUsed) / s.memory.total);
    $('#system').innerHTML = `<div class="head"><b>🖥️ ${esc(s.hostname)}</b><span class="muted">allumé depuis ${fmtUptime(s.uptime)}</span></div>
      ${meter('CPU', s.cpu.usage, `${s.cpu.usage} % · ${s.cpu.cores} cœurs`)}
      ${meter('RAM', memPct, `${gb(memUsed)} / ${gb(s.memory.total)} Go`)}
      ${s.disks.slice(0, 3).map((d) => { const p = Math.round((100 * (d.total - d.free)) / d.total); return meter(`Disque ${esc(d.name)}`, p, `${gb(d.free)} Go libres`); }).join('')}`;
  } catch (e) {
    if (e.offline) $('#system').innerHTML = '<div class="error">⚠️ PC injoignable</div>';
  }
}

boot();
