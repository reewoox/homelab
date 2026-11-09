// Import Gmail : une page (locale ou dans le homelab) envoie l'adresse + un mot de passe d'application,
// le serveur lance scripts/import-gmail.py en tâche de fond (mot de passe transmis par stdin, jamais stocké).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

module.exports = (ctx) => {
  const { db, route, httpError, readBody, getSettings, logEvent, clientIp } = ctx;
  const SCRIPT = path.join(ctx.ROOT, '..', 'scripts', 'import-gmail.py');
  const PAGE = path.join(ctx.ROOT, 'local', 'gmail.html');
  const PY = ctx.config.python || ['Python313', 'Python312', 'Python311']
    .map((v) => path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', v, 'python.exe'))
    .find((p) => fs.existsSync(p)) || 'python';

  const jobs = new Map(); // userId -> job
  const userDir = (u) => path.join(path.resolve(getSettings().driveRoot || path.join(os.homedir(), 'HomelabDrive')), 'Utilisateurs', u.username);

  // Requête faite directement sur ce PC (pas via le tunnel Cloudflare ni Tailscale) → compte admin
  function localAdmin(req) {
    const h = req.headers;
    const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    const proxied = h['cf-connecting-ip'] || h['x-forwarded-for'] || h['tailscale-user-login'];
    const hostOk = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(h.host || '');
    const originOk = !h.origin || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(h.origin);
    if (!loopback || proxied || !hostOk || !originOk) throw httpError(403, 'Cette page ne fonctionne que sur le PC (http://localhost:7575/local/gmail)');
    const u = db.prepare("SELECT * FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1").get();
    if (!u) throw httpError(400, 'Crée d’abord ton compte admin sur http://localhost:7575');
    return u;
  }

  const status = (user) => {
    const j = jobs.get(user.id);
    let last = null;
    try { last = JSON.parse(fs.readFileSync(path.join(userDir(user), '.homelab-mail-last.json'), 'utf8')); } catch {}
    return {
      job: j ? { running: j.running, email: j.email, progress: j.progress, log: j.log.slice(-12), error: j.error, startedAt: j.startedAt, endedAt: j.endedAt } : null,
      last,
    };
  };

  async function start(req, user) {
    const { email, password } = await readBody(req);
    const addr = String(email || '').trim().toLowerCase();
    const pw = String(password || '').replace(/\s+/g, '');
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(addr)) throw httpError(400, 'Adresse email invalide');
    if (!/^[a-zA-Z]{16}$/.test(pw)) throw httpError(400, 'Le mot de passe d’application fait 16 lettres (ex. « abcd efgh ijkl mnop »). Ce n’est pas ton mot de passe Gmail habituel.');
    if (jobs.get(user.id)?.running) throw httpError(409, 'Un import est déjà en cours');
    const dest = userDir(user);
    fs.mkdirSync(dest, { recursive: true });

    const job = { running: true, email: addr, progress: null, log: [], error: null, startedAt: Date.now(), endedAt: null };
    jobs.set(user.id, job);
    const child = spawn(PY, ['-I', '-u', SCRIPT, addr, '-', dest], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    job.child = child;
    child.stdin.on('error', () => {});
    child.stdin.end(pw + '\n');
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        if (line.startsWith('@@')) { try { job.progress = JSON.parse(line.slice(2)); } catch {} continue; }
        job.log.push(line);
        if (job.log.length > 200) job.log.shift();
        if (/ÉCHEC DE CONNEXION|Erreur IMAP|Error|Impossible/.test(line) && !job.error) job.error = line;
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => { job.error = `Python introuvable (${e.code})`; });
    child.on('close', (code) => {
      job.running = false; job.endedAt = Date.now(); job.child = null;
      if (job.stopped) job.error = 'Import arrêté (relance-le : il reprendra là où il s’est arrêté)';
      else if (code !== 0 && !job.error) job.error = `L’import s’est arrêté (code ${code})`;
      if (job.progress?.final) fs.writeFileSync(path.join(dest, '.homelab-mail-last.json'), JSON.stringify({ email: addr, at: job.endedAt, ...job.progress }));
    });
    logEvent(user.username, 'import Gmail lancé', clientIp(req), addr);
    return { ok: true };
  }
  function stop(user) {
    const j = jobs.get(user.id);
    if (j?.child) { j.stopped = true; j.child.kill(); }
    return { ok: true };
  }

  // Version homelab (connecté) …
  route('GET', '/api/mail-import', { auth: 'user' }, (req) => status(req.user));
  route('POST', '/api/mail-import', { auth: 'user' }, (req) => start(req, req.user));
  route('POST', '/api/mail-import/stop', { auth: 'user' }, (req) => stop(req.user));
  // … et page locale (sur le PC uniquement)
  route('GET', '/local/gmail', (req, p, res) => {
    localAdmin(req);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'SAMEORIGIN' });
    res.end(fs.readFileSync(PAGE));
  });
  route('GET', '/local/api/mail-import', (req) => status(localAdmin(req)));
  route('POST', '/local/api/mail-import', (req) => start(req, localAdmin(req)));
  route('POST', '/local/api/mail-import/stop', (req) => stop(localAdmin(req)));
};
