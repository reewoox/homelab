// Homelab API — tourne sur ton PC, zéro dépendance (Node >= 22.13, node:sqlite)
'use strict';
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const SITE_DIR = path.join(ROOT, '..', 'docs');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Config ----------
const CONFIG_FILE = path.join(ROOT, 'config.json');
const config = Object.assign(
  { port: 7575, host: '0.0.0.0', allowedOrigins: [] },
  fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {}
);
const PORT = Number(process.env.PORT || config.port);

const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(48).toString('hex'));
const SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();

// ---------- Base de données ----------
const db = new DatabaseSync(path.join(DATA_DIR, 'homelab.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'pending',
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login TEXT
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS apps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  ping_url TEXT,
  icon TEXT,
  description TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  new_tab INTEGER NOT NULL DEFAULT 1,
  ping INTEGER NOT NULL DEFAULT 1,
  admin_only INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

const DEFAULT_SETTINGS = {
  title: 'Mon Homelab',
  registration: 'approval', // open | approval | closed
  background: '',
  weatherCity: 'Paris',
  weatherLat: '48.8566',
  weatherLon: '2.3522',
  accent: '#fa5252',
};
for (const [k, v] of Object.entries(DEFAULT_SETTINGS))
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(k, v);

// Données de démo au premier lancement
if (db.prepare('SELECT COUNT(*) AS n FROM categories').get().n === 0) {
  const cat = (name, pos) => db.prepare('INSERT INTO categories (name, position) VALUES (?, ?)').run(name, pos).lastInsertRowid;
  const app = (c, name, url, icon, description, pos) =>
    db.prepare('INSERT INTO apps (category_id, name, url, icon, description, position) VALUES (?, ?, ?, ?, ?, ?)').run(c, name, url, icon, description, pos);
  const tools = cat('Outils', 0);
  app(tools, 'GitHub', 'https://github.com', 'github', 'Code & repos', 0);
  app(tools, 'ComfyUI', 'http://localhost:8188', 'comfyui', 'Génération d’images', 1);
  app(tools, 'Ollama', 'http://localhost:11434', 'ollama', 'LLM locaux', 2);
  const media = cat('Médias', 1);
  app(media, 'YouTube', 'https://youtube.com', 'youtube', '', 0);
}

const getSettings = () => Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));

// ---------- Crypto / tokens ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [, saltHex, hashHex] = String(stored).split('$');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}
const b64u = (s) => Buffer.from(s).toString('base64url');
function signToken(user) {
  const payload = b64u(JSON.stringify({ uid: user.id, v: user.token_version, exp: Date.now() + 30 * 864e5 }));
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function readToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.exp < Date.now()) return null;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(data.uid);
    if (!user || user.token_version !== data.v || user.status !== 'active') return null;
    return user;
  } catch { return null; }
}
const publicUser = (u) => u && ({ id: u.id, username: u.username, email: u.email, role: u.role, status: u.status, created_at: u.created_at, last_login: u.last_login });

// ---------- Anti brute-force ----------
const attempts = new Map();
function rateLimited(ip, key, max = 10, windowMs = 15 * 60e3) {
  const k = `${key}:${ip}`;
  const now = Date.now();
  const list = (attempts.get(k) || []).filter((t) => now - t < windowMs);
  list.push(now);
  attempts.set(k, list);
  return list.length > max;
}

// ---------- Ping des apps ----------
const status = {};
function ping(target) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(target); } catch { return resolve({ up: false, error: 'URL invalide' }); }
    const lib = u.protocol === 'https:' ? https : http;
    const start = Date.now();
    const req = lib.request(u, { method: 'GET', timeout: 5000, rejectUnauthorized: false, headers: { 'User-Agent': 'homelab-status' } }, (res) => {
      res.resume();
      resolve({ up: res.statusCode < 500, code: res.statusCode, ms: Date.now() - start });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ up: false, error: e.code || e.message, ms: Date.now() - start }));
    req.end();
  });
}
async function checkAll() {
  const list = db.prepare('SELECT id, url, ping_url FROM apps WHERE ping = 1').all();
  await Promise.all(list.map(async (a) => {
    status[a.id] = { ...(await ping(a.ping_url || a.url)), checkedAt: Date.now() };
  }));
}
setInterval(checkAll, 60e3);
setTimeout(checkAll, 1000);

// ---------- Stats système ----------
let lastCpu = os.cpus();
function cpuUsage() {
  const now = os.cpus();
  let idle = 0, total = 0;
  now.forEach((c, i) => {
    const p = lastCpu[i] || c;
    for (const t in c.times) total += c.times[t] - p.times[t];
    idle += c.times.idle - p.times.idle;
  });
  lastCpu = now;
  return total ? Math.round(100 * (1 - idle / total)) : 0;
}
function disks() {
  const out = [];
  const letters = process.platform === 'win32' ? 'CDEFGHIJ'.split('').map((l) => `${l}:\\`) : ['/'];
  for (const d of letters) {
    try {
      const s = fs.statfsSync(d);
      const total = s.blocks * s.bsize;
      if (total > 0) out.push({ name: d.replace('\\', ''), total, free: s.bavail * s.bsize });
    } catch {}
  }
  return out;
}

// ---------- HTTP helpers ----------
const MAX_BODY = 1e6;
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(httpError(413, 'Corps trop gros')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(httpError(400, 'JSON invalide')); }
    });
    req.on('error', reject);
  });
}
function httpError(code, message) { const e = new Error(message); e.status = code; return e; }
function send(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
function cors(req, res) {
  const origin = req.headers.origin;
  const allowed = config.allowedOrigins;
  if (origin && (!allowed.length || allowed.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');
}
const clientIp = (req) => req.headers['cf-connecting-ip'] || req.socket.remoteAddress;

const str = (v, max = 500) => (v == null ? '' : String(v).trim().slice(0, max));
function validUrl(u) {
  try { const x = new URL(u); return ['http:', 'https:'].includes(x.protocol); } catch { return false; }
}

// ---------- Routes ----------
const routes = [];
const route = (method, pattern, opts, handler) => {
  if (typeof opts === 'function') { handler = opts; opts = {}; }
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, auth: opts.auth || null });
};

route('GET', '/api/health', () => {
  const s = getSettings();
  return { ok: true, title: s.title, registration: s.registration, hasUsers: db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0 };
});

route('POST', '/api/auth/register', async (req) => {
  if (rateLimited(clientIp(req), 'register', 5, 60 * 60e3)) throw httpError(429, 'Trop de tentatives, réessaie plus tard');
  const { username, email, password } = await readBody(req);
  const name = str(username, 32);
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(name)) throw httpError(400, 'Nom d’utilisateur : 3-32 caractères (lettres, chiffres, . _ -)');
  if (!password || String(password).length < 8) throw httpError(400, 'Mot de passe : 8 caractères minimum');
  const first = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
  const mode = getSettings().registration;
  const local = !req.headers['cf-connecting-ip'] && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  if (first && !local) throw httpError(403, 'Le compte admin doit être créé depuis le PC : ouvre http://localhost:7575');
  if (!first && mode === 'closed') throw httpError(403, 'Les inscriptions sont fermées');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) throw httpError(409, 'Ce nom est déjà pris');
  const role = first ? 'admin' : 'user';
  const st = first || mode === 'open' ? 'active' : 'pending';
  const id = db.prepare('INSERT INTO users (username, email, password_hash, role, status) VALUES (?, ?, ?, ?, ?)')
    .run(name, str(email, 120), hashPassword(String(password)), role, st).lastInsertRowid;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (st === 'pending') return { pending: true, message: 'Compte créé ! Un admin doit le valider.' };
  return { token: signToken(user), user: publicUser(user) };
});

route('POST', '/api/auth/login', async (req) => {
  if (rateLimited(clientIp(req), 'login')) throw httpError(429, 'Trop de tentatives, attends 15 minutes');
  const { username, password } = await readBody(req);
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(str(username, 32));
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) throw httpError(401, 'Identifiants incorrects');
  if (user.status === 'pending') throw httpError(403, 'Ton compte attend la validation d’un admin');
  if (user.status !== 'active') throw httpError(403, 'Compte désactivé');
  db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);
  return { token: signToken(user), user: publicUser(user) };
});

route('GET', '/api/auth/me', { auth: 'user' }, (req) => ({ user: publicUser(req.user) }));

route('POST', '/api/auth/password', { auth: 'user' }, async (req) => {
  const { current, next } = await readBody(req);
  if (!verifyPassword(String(current || ''), req.user.password_hash)) throw httpError(401, 'Mot de passe actuel incorrect');
  if (!next || String(next).length < 8) throw httpError(400, 'Nouveau mot de passe : 8 caractères minimum');
  db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(hashPassword(String(next)), req.user.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  return { token: signToken(user) };
});

// Tableau de bord
route('GET', '/api/board', { auth: 'user' }, (req) => {
  const isAdmin = req.user.role === 'admin';
  const cats = db.prepare('SELECT * FROM categories ORDER BY position, id').all();
  const apps = db.prepare('SELECT * FROM apps ORDER BY position, id').all().filter((a) => isAdmin || !a.admin_only);
  return {
    settings: getSettings(),
    categories: cats.map((c) => ({ ...c, apps: apps.filter((a) => a.category_id === c.id) })),
  };
});

route('POST', '/api/categories', { auth: 'admin' }, async (req) => {
  const { name } = await readBody(req);
  if (!str(name)) throw httpError(400, 'Nom requis');
  const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM categories').get().p;
  return { id: Number(db.prepare('INSERT INTO categories (name, position) VALUES (?, ?)').run(str(name, 60), pos).lastInsertRowid) };
});
route('PUT', '/api/categories/:id', { auth: 'admin' }, async (req, p) => {
  const { name } = await readBody(req);
  if (!str(name)) throw httpError(400, 'Nom requis');
  db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(str(name, 60), Number(p.id));
  return { ok: true };
});
route('DELETE', '/api/categories/:id', { auth: 'admin' }, (req, p) => {
  db.prepare('DELETE FROM categories WHERE id = ?').run(Number(p.id));
  return { ok: true };
});

function appFields(b) {
  const f = {
    category_id: Number(b.category_id) || null,
    name: str(b.name, 60),
    url: str(b.url, 1000),
    ping_url: str(b.ping_url, 1000) || null,
    icon: str(b.icon, 1000),
    description: str(b.description, 200),
    new_tab: b.new_tab === false ? 0 : 1,
    ping: b.ping === false ? 0 : 1,
    admin_only: b.admin_only ? 1 : 0,
  };
  if (!f.name) throw httpError(400, 'Nom requis');
  if (!validUrl(f.url)) throw httpError(400, 'URL invalide (http:// ou https://)');
  if (f.ping_url && !validUrl(f.ping_url)) throw httpError(400, 'URL de ping invalide');
  if (!f.category_id || !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(f.category_id)) throw httpError(400, 'Catégorie invalide');
  return f;
}
route('POST', '/api/apps', { auth: 'admin' }, async (req) => {
  const f = appFields(await readBody(req));
  f.position = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM apps WHERE category_id = ?').get(f.category_id).p;
  const id = Number(db.prepare(`INSERT INTO apps (category_id, name, url, ping_url, icon, description, new_tab, ping, admin_only, position)
    VALUES (:category_id, :name, :url, :ping_url, :icon, :description, :new_tab, :ping, :admin_only, :position)`).run(f).lastInsertRowid);
  if (f.ping) ping(f.ping_url || f.url).then((r) => (status[id] = { ...r, checkedAt: Date.now() }));
  return { id };
});
route('PUT', '/api/apps/:id', { auth: 'admin' }, async (req, p) => {
  const f = appFields(await readBody(req));
  f.id = Number(p.id);
  db.prepare(`UPDATE apps SET category_id = :category_id, name = :name, url = :url, ping_url = :ping_url, icon = :icon,
    description = :description, new_tab = :new_tab, ping = :ping, admin_only = :admin_only WHERE id = :id`).run(f);
  if (f.ping) ping(f.ping_url || f.url).then((r) => (status[f.id] = { ...r, checkedAt: Date.now() }));
  else delete status[f.id];
  return { ok: true };
});
route('DELETE', '/api/apps/:id', { auth: 'admin' }, (req, p) => {
  db.prepare('DELETE FROM apps WHERE id = ?').run(Number(p.id));
  delete status[p.id];
  return { ok: true };
});

route('POST', '/api/reorder', { auth: 'admin' }, async (req) => {
  const { categories = [], apps = {} } = await readBody(req);
  db.exec('BEGIN');
  try {
    categories.forEach((id, i) => db.prepare('UPDATE categories SET position = ? WHERE id = ?').run(i, Number(id)));
    for (const [catId, ids] of Object.entries(apps))
      ids.forEach((id, i) => db.prepare('UPDATE apps SET position = ?, category_id = ? WHERE id = ?').run(i, Number(catId), Number(id)));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { ok: true };
});

route('GET', '/api/status', { auth: 'user' }, () => status);

route('GET', '/api/system', { auth: 'user' }, () => ({
  hostname: os.hostname(),
  platform: `${os.type()} ${os.release()}`,
  uptime: os.uptime(),
  cpu: { usage: cpuUsage(), cores: os.cpus().length, model: os.cpus()[0]?.model?.trim() },
  memory: { total: os.totalmem(), free: os.freemem() },
  disks: disks(),
}));

// Admin : réglages & utilisateurs
route('PUT', '/api/settings', { auth: 'admin' }, async (req) => {
  const body = await readBody(req);
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (body[k] === undefined) continue;
    if (k === 'registration' && !['open', 'approval', 'closed'].includes(body[k])) throw httpError(400, 'Mode d’inscription invalide');
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(str(body[k], 1000), k);
  }
  return getSettings();
});
route('GET', '/api/users', { auth: 'admin' }, () => db.prepare('SELECT * FROM users ORDER BY id').all().map(publicUser));
route('PUT', '/api/users/:id', { auth: 'admin' }, async (req, p) => {
  const id = Number(p.id);
  if (id === req.user.id) throw httpError(400, 'Tu ne peux pas modifier ton propre compte ici');
  const { role, status: st } = await readBody(req);
  if (role && !['admin', 'user'].includes(role)) throw httpError(400, 'Rôle invalide');
  if (st && !['active', 'pending', 'disabled'].includes(st)) throw httpError(400, 'Statut invalide');
  if (role) db.prepare('UPDATE users SET role = ?, token_version = token_version + 1 WHERE id = ?').run(role, id);
  if (st) db.prepare('UPDATE users SET status = ?, token_version = token_version + 1 WHERE id = ?').run(st, id);
  return { ok: true };
});
route('DELETE', '/api/users/:id', { auth: 'admin' }, (req, p) => {
  if (Number(p.id) === req.user.id) throw httpError(400, 'Tu ne peux pas te supprimer toi-même');
  db.prepare('DELETE FROM users WHERE id = ?').run(Number(p.id));
  return { ok: true };
});

// Sauvegarde / restauration des apps
route('GET', '/api/export', { auth: 'admin' }, () => ({
  version: 1,
  exportedAt: new Date().toISOString(),
  settings: getSettings(),
  categories: db.prepare('SELECT * FROM categories ORDER BY position').all(),
  apps: db.prepare('SELECT * FROM apps ORDER BY position').all(),
}));
route('POST', '/api/import', { auth: 'admin' }, async (req) => {
  const data = await readBody(req);
  if (!Array.isArray(data.categories) || !Array.isArray(data.apps)) throw httpError(400, 'Fichier de sauvegarde invalide');
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM apps; DELETE FROM categories;');
    const map = {};
    for (const c of data.categories) map[c.id] = db.prepare('INSERT INTO categories (name, position) VALUES (?, ?)').run(str(c.name, 60), Number(c.position) || 0).lastInsertRowid;
    for (const a of data.apps) {
      if (!map[a.category_id]) continue;
      db.prepare('INSERT INTO apps (category_id, name, url, ping_url, icon, description, position, new_tab, ping, admin_only) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(map[a.category_id], str(a.name, 60), str(a.url, 1000), a.ping_url ? str(a.ping_url, 1000) : null, str(a.icon, 1000), str(a.description, 200),
          Number(a.position) || 0, a.new_tab ? 1 : 0, a.ping ? 1 : 0, a.admin_only ? 1 : 0);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  for (const k of Object.keys(status)) delete status[k];
  checkAll();
  return { ok: true };
});

// ---------- Fichiers statiques (accès local / réseau : http://localhost:7575) ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res, pathname) {
  if (pathname === '/config.json') return send(res, 200, { apiUrl: '' }); // en local, l'API est sur la même origine
  const file = path.normalize(path.join(SITE_DIR, pathname === '/' ? 'index.html' : decodeURIComponent(pathname)));
  if (!file.startsWith(SITE_DIR)) return send(res, 403, { error: 'Interdit' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'Introuvable' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ---------- Serveur ----------
const server = http.createServer(async (req, res) => {
  cors(req, res);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const { pathname } = new URL(req.url, 'http://x');
  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = pathname.match(r.re);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
    try {
      if (r.auth) {
        const user = readToken((req.headers.authorization || '').replace(/^Bearer /, ''));
        if (!user) throw httpError(401, 'Session expirée, reconnecte-toi');
        if (r.auth === 'admin' && user.role !== 'admin') throw httpError(403, 'Réservé aux admins');
        req.user = user;
      }
      return send(res, 200, await r.handler(req, params));
    } catch (e) {
      if (!e.status) console.error(e);
      return send(res, e.status || 500, { error: e.status ? e.message : 'Erreur serveur' });
    }
  }
  send(res, 404, { error: 'Route inconnue' });
});

server.listen(PORT, config.host, () => {
  console.log(`🏠 Homelab API prête sur http://localhost:${PORT}`);
});
