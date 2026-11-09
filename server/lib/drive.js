// Drive : fichiers stockés sur ton PC, accessibles depuis tous tes appareils.
// Chaque utilisateur a son espace perso + un espace « Commun » partagé.
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', heic: 'image/heic',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', m4v: 'video/mp4',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/opus',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', json: 'application/json', csv: 'text/csv; charset=utf-8', log: 'text/plain; charset=utf-8',
  zip: 'application/zip', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const mimeOf = (name) => MIME[path.extname(name).slice(1).toLowerCase()] || 'application/octet-stream';
// Types affichables en ligne sans risque (pas de HTML/SVG qui pourraient exécuter du script)
const SAFE_INLINE = /^(image\/(jpeg|png|gif|webp|avif|bmp)|video\/|audio\/|application\/pdf|text\/plain)/;

module.exports = (ctx) => {
  const { route, httpError, readBody, str, signData, verifyData, getSettings, db, logEvent, clientIp } = ctx;
  const defaultRoot = path.join(os.homedir(), 'HomelabDrive');
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('driveRoot', defaultRoot);
  const root = () => path.resolve(getSettings().driveRoot || defaultRoot);

  function spaceDir(user, space) {
    const base = space === 'commun' ? path.join(root(), 'Commun') : path.join(root(), 'Utilisateurs', user.username);
    fs.mkdirSync(base, { recursive: true });
    return base;
  }
  function resolve(user, space, rel = '') {
    const base = spaceDir(user, space);
    const parts = String(rel).split(/[\\/]+/).filter(Boolean);
    if (parts.some((p) => p === '..' || p === '.')) throw httpError(400, 'Chemin invalide');
    const full = path.resolve(base, ...parts);
    if (full !== base && !full.startsWith(base + path.sep)) throw httpError(400, 'Chemin invalide');
    return { base, full, rel: parts.join('/') };
  }
  function cleanName(n) {
    const name = str(n, 200).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
    if (!name || name === '.' || name === '..') throw httpError(400, 'Nom de fichier invalide');
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)) throw httpError(400, 'Nom réservé par Windows');
    return name;
  }
  async function uniquePath(dir, name) {
    const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
    let candidate = path.join(dir, name);
    for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${stem} (${i})${ext}`);
    return candidate;
  }
  async function dirSize(dir) {
    let total = 0;
    for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += await dirSize(p);
      else total += (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
    }
    return total;
  }
  const q = (req) => new URL(req.url, 'http://x').searchParams;
  const space = (s) => (s === 'commun' ? 'commun' : 'perso');

  route('GET', '/api/drive/list', { auth: 'user' }, async (req) => {
    const p = q(req);
    const { full, rel } = resolve(req.user, space(p.get('space')), p.get('path'));
    const st = await fsp.stat(full).catch(() => null);
    if (!st?.isDirectory()) throw httpError(404, 'Dossier introuvable');
    const items = [];
    for (const e of await fsp.readdir(full, { withFileTypes: true })) {
      if (e.name.startsWith('.homelab-')) continue;
      const s = await fsp.stat(path.join(full, e.name)).catch(() => null);
      if (!s) continue;
      const item = { name: e.name, dir: s.isDirectory(), size: s.isDirectory() ? null : s.size, mtime: s.mtimeMs, type: s.isDirectory() ? 'folder' : mimeOf(e.name) };
      if (!item.dir) item.url = `/api/drive/dl/${encodeURIComponent(e.name)}?t=${signData('dl', { u: req.user.id, s: space(p.get('space')), p: rel ? `${rel}/${e.name}` : e.name }, 3600e3)}`;
      items.push(item);
    }
    items.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'fr', { numeric: true }));
    let disk = null;
    try { const s = fs.statfsSync(root()); disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize }; } catch {}
    return { path: rel, items, disk };
  });

  route('GET', '/api/drive/usage', { auth: 'user' }, async (req) => ({
    perso: await dirSize(spaceDir(req.user, 'perso')),
    commun: await dirSize(spaceDir(req.user, 'commun')),
  }));

  route('POST', '/api/drive/mkdir', { auth: 'user' }, async (req) => {
    const b = await readBody(req);
    const { full } = resolve(req.user, space(b.space), b.path);
    const target = path.join(full, cleanName(b.name));
    if (fs.existsSync(target)) throw httpError(409, 'Ce nom existe déjà');
    await fsp.mkdir(target, { recursive: true });
    return { ok: true };
  });

  route('POST', '/api/drive/rename', { auth: 'user' }, async (req) => {
    const b = await readBody(req);
    const { full, base } = resolve(req.user, space(b.space), b.path);
    if (full === base) throw httpError(400, 'Impossible de renommer la racine');
    const target = path.join(path.dirname(full), cleanName(b.newName));
    if (fs.existsSync(target)) throw httpError(409, 'Ce nom existe déjà');
    await fsp.rename(full, target);
    return { ok: true };
  });

  route('POST', '/api/drive/move', { auth: 'user' }, async (req) => {
    const b = await readBody(req);
    const dest = resolve(req.user, space(b.toSpace || b.space), b.to).full;
    if (!fs.statSync(dest, { throwIfNoEntry: false })?.isDirectory()) throw httpError(404, 'Dossier de destination introuvable');
    for (const p of [].concat(b.paths || [])) {
      const { full, base } = resolve(req.user, space(b.space), p);
      if (full === base) continue;
      if (dest === full || dest.startsWith(full + path.sep)) throw httpError(400, 'Impossible de déplacer un dossier dans lui-même');
      const target = await uniquePath(dest, path.basename(full));
      await fsp.rename(full, target).catch(async (e) => {
        if (e.code !== 'EXDEV') throw e;
        await fsp.cp(full, target, { recursive: true }); await fsp.rm(full, { recursive: true, force: true });
      });
    }
    return { ok: true };
  });

  route('POST', '/api/drive/delete', { auth: 'user' }, async (req) => {
    const b = await readBody(req);
    let n = 0;
    for (const p of [].concat(b.paths || [])) {
      const { full, base } = resolve(req.user, space(b.space), p);
      if (full === base) continue;
      await fsp.rm(full, { recursive: true, force: true });
      n++;
    }
    return { deleted: n };
  });

  // Envoi en morceaux (le tunnel Cloudflare limite chaque requête à 100 Mo)
  route('POST', '/api/drive/upload', { auth: 'user' }, async (req) => {
    const p = q(req);
    const { full: dir } = resolve(req.user, space(p.get('space')), p.get('path'));
    if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw httpError(404, 'Dossier introuvable');
    const name = cleanName(p.get('name'));
    const id = String(p.get('id') || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40) || crypto.randomUUID();
    const offset = Number(p.get('offset') || 0);
    const final = p.get('final') === '1';
    const tmp = path.join(dir, `.homelab-${req.user.id}-${id}.part`);
    if (offset === 0) await fsp.rm(tmp, { force: true });
    const have = fs.statSync(tmp, { throwIfNoEntry: false })?.size || 0;
    if (have !== offset) throw httpError(409, `Décalage incohérent (${have} ≠ ${offset})`);
    await new Promise((resolveP, reject) => {
      const out = fs.createWriteStream(tmp, { flags: 'a' });
      req.pipe(out);
      out.on('finish', resolveP);
      out.on('error', reject);
      req.on('error', reject);
    });
    if (!final) return { ok: true, received: fs.statSync(tmp).size };
    const target = await uniquePath(dir, name);
    await fsp.rename(tmp, target);
    return { ok: true, name: path.basename(target) };
  });

  // Liens signés : téléchargement / aperçu (1 h) et partage public (n jours)
  route('GET', '/api/drive/link', { auth: 'user' }, (req) => {
    const p = q(req);
    const sp = space(p.get('space'));
    const { full, rel } = resolve(req.user, sp, p.get('path'));
    if (!fs.statSync(full, { throwIfNoEntry: false })?.isFile()) throw httpError(404, 'Fichier introuvable');
    const t = signData('dl', { u: req.user.id, s: sp, p: rel }, 3600e3);
    return { url: `/api/drive/dl/${encodeURIComponent(path.basename(full))}?t=${t}` };
  });
  route('POST', '/api/drive/share', { auth: 'user' }, async (req) => {
    const b = await readBody(req);
    const sp = space(b.space);
    const { full, rel } = resolve(req.user, sp, b.path);
    if (!fs.statSync(full, { throwIfNoEntry: false })?.isFile()) throw httpError(404, 'Seuls les fichiers peuvent être partagés');
    const days = Math.min(Math.max(Number(b.days) || 7, 1), 30);
    const t = signData('share', { u: req.user.id, s: sp, p: rel }, days * 864e5);
    logEvent(req.user.username, 'partage de fichier', clientIp(req), `${rel} (${days} j)`);
    return { url: `/s/${t}/${encodeURIComponent(path.basename(full))}`, days };
  });

  function sendFile(req, res, user, sp, rel, { download }) {
    const { full } = resolve(user, sp, rel);
    const st = fs.statSync(full, { throwIfNoEntry: false });
    if (!st?.isFile()) throw httpError(404, 'Fichier introuvable ou supprimé');
    const name = path.basename(full);
    const type = mimeOf(name);
    const inline = !download && SAFE_INLINE.test(type);
    const headers = {
      'Content-Type': inline ? type : 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'",
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
      start = Math.max(0, start); end = Math.min(end, st.size - 1);
      if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      return fs.createReadStream(full, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(full).pipe(res);
  }
  const userById = (id) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u || u.status !== 'active') throw httpError(410, 'Lien expiré');
    return u;
  };

  route('GET', '/api/drive/dl/:name', (req, params, res) => {
    const d = verifyData('dl', q(req).get('t'));
    if (!d) throw httpError(410, 'Lien expiré, recharge la page');
    sendFile(req, res, userById(d.u), d.s, d.p, { download: q(req).get('download') === '1' });
  });
  route('GET', '/s/:token/:name', (req, params, res) => {
    const d = verifyData('share', params.token);
    if (!d) { res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<meta name=viewport content="width=device-width"><body style="font:16px system-ui;padding:40px;text-align:center"><h2>Lien expiré</h2><p>Ce lien de partage n’est plus valide.</p>'); }
    sendFile(req, res, userById(d.u), d.s, d.p, { download: q(req).get('download') === '1' });
  });
};
