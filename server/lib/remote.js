// Accès distant aux apps locales via Tailscale Serve (HTTPS, visible uniquement par tes appareils Tailscale)
// + découverte automatique des services qui tournent sur le PC.
'use strict';
const fs = require('node:fs');
const { execFile } = require('node:child_process');

const PORT_BASE = 10000; // ports gérés par le homelab : 10000 + id de l'app (on ne touche jamais aux autres)
const PORT_MAX = 10999;

module.exports = (ctx) => {
  const { db, route, httpError } = ctx;
  const TS = ctx.config.tailscale || ['C:\\Program Files\\Tailscale\\tailscale.exe', '/usr/bin/tailscale', '/usr/local/bin/tailscale'].find((p) => fs.existsSync(p));

  const run = (args) => new Promise((resolve) => {
    if (!TS) return resolve({ ok: false, out: 'Tailscale introuvable' });
    execFile(TS, args, { timeout: 20000, windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, out: (stdout || '') + (stderr || '') }));
  });

  let info = { available: false, dnsName: '', ip: '', peers: [], checkedAt: 0 };
  async function refreshInfo() {
    const r = await run(['status', '--json']);
    if (!r.ok) { info = { ...info, available: false, checkedAt: Date.now() }; return info; }
    try {
      const j = JSON.parse(r.out.slice(r.out.indexOf('{')));
      info = {
        available: j.BackendState === 'Running',
        dnsName: String(j.Self?.DNSName || '').replace(/\.$/, ''),
        ip: j.Self?.TailscaleIPs?.[0] || '',
        https: Array.isArray(j.CertDomains) && j.CertDomains.length > 0,
        self: { name: j.Self?.HostName, os: j.Self?.OS, online: true, ip: j.Self?.TailscaleIPs?.[0] },
        peers: Object.values(j.Peer || {}).map((p) => ({ name: p.HostName === 'localhost' ? (p.DNSName || '').split('.')[0] || p.HostName : p.HostName, os: p.OS, online: !!p.Online, ip: p.TailscaleIPs?.[0], lastSeen: p.LastSeen })),
        checkedAt: Date.now(),
      };
    } catch { info.available = false; }
    return info;
  }

  const PRIVATE = [/^localhost$/i, /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /\.local$/i, /^[^.]+$/, /^\[?::1\]?$/];
  ctx.isPrivateUrl = (u) => { try { return PRIVATE.some((re) => re.test(new URL(u).hostname)); } catch { return false; } };

  const servePort = (id) => PORT_BASE + Number(id);
  const remoteUrls = new Map(); // appId -> url
  ctx.remoteUrl = (id) => remoteUrls.get(Number(id)) || null;

  function target(u) {
    const x = new URL(u);
    const host = x.hostname === 'localhost' ? '127.0.0.1' : x.hostname;
    return `${x.protocol === 'https:' ? 'https+insecure' : 'http'}://${host}${x.port ? ':' + x.port : ''}`;
  }

  // Ports actuellement servis par Tailscale (pour ne gérer que les nôtres)
  async function currentServe() {
    const r = await run(['serve', 'status', '--json']);
    try {
      const j = JSON.parse(r.out.slice(r.out.indexOf('{')) || '{}');
      return Object.keys(j.TCP || {}).map(Number).filter((p) => p >= PORT_BASE && p <= PORT_MAX);
    } catch { return []; }
  }

  let syncing = null, again = false;
  async function sync() {
    if (syncing) { again = true; return syncing; }
    syncing = (async () => {
      do {
        again = false;
        await refreshInfo();
        if (!info.available || !info.dnsName) { remoteUrls.clear(); continue; }
        const apps = db.prepare('SELECT id, url FROM apps WHERE remote = 1').all().filter((a) => ctx.isPrivateUrl(a.url) && servePort(a.id) <= PORT_MAX);
        const wanted = new Map(apps.map((a) => [servePort(a.id), a]));
        // Port 10000 : le homelab lui-même, accès direct et rapide depuis tes appareils Tailscale
        wanted.set(PORT_BASE, { id: 0, url: `http://localhost:${Number(process.env.PORT || ctx.config.port)}` });
        const proto = info.https ? 'https' : 'http';
        for (const port of await currentServe()) {
          if (!wanted.has(port)) await run(['serve', `--${proto}=${port}`, 'off']);
        }
        remoteUrls.clear();
        for (const [port, a] of wanted) {
          const r = await run(['serve', '--bg', '--yes', `--${proto}=${port}`, target(a.url)]);
          if (!r.ok && !/already/i.test(r.out)) { console.error(`tailscale serve ${port}:`, r.out.trim()); continue; }
          const u = new URL(a.url);
          remoteUrls.set(a.id, `${proto}://${info.dnsName}:${port}${u.pathname === '/' ? '' : u.pathname}${u.search}`);
        }
      } while (again);
    })().finally(() => { syncing = null; });
    return syncing;
  }
  ctx.syncRemote = () => { if (process.env.HOMELAB_NO_TAILSCALE) return; sync().catch((e) => console.error('sync tailscale', e)); };
  setTimeout(ctx.syncRemote, 500);
  setInterval(refreshInfo, 60e3);

  route('GET', '/api/remote', { auth: 'user' }, async () => {
    if (Date.now() - info.checkedAt > 15e3) await refreshInfo();
    return { ...info, apps: Object.fromEntries(remoteUrls) };
  });

  // ---------- Découverte des services locaux ----------
  const KNOWN = [
    [8188, 'ComfyUI', 'comfyui'], [11434, 'Ollama', 'ollama'], [8765, 'Remote PC', ''], [7860, 'Stable Diffusion WebUI', 'stable-diffusion'],
    [3000, 'Open WebUI / Grafana', ''], [8080, 'Open WebUI', 'open-webui'], [32400, 'Plex', 'plex'], [8096, 'Jellyfin', 'jellyfin'], [8123, 'Home Assistant', 'home-assistant'],
    [9000, 'Portainer', 'portainer'], [9443, 'Portainer', 'portainer'], [3001, 'Uptime Kuma', 'uptime-kuma'], [8384, 'Syncthing', 'syncthing'], [9091, 'Transmission', 'transmission'],
    [8989, 'Sonarr', 'sonarr'], [7878, 'Radarr', 'radarr'], [9696, 'Prowlarr', 'prowlarr'], [5055, 'Overseerr', 'overseerr'], [2283, 'Immich', 'immich'],
    [8000, 'Service web', ''], [5000, 'Service web', ''], [5678, 'n8n', 'n8n'], [1880, 'Node-RED', 'node-red'], [8081, 'Service web', ''], [8888, 'Jupyter', 'jupyter'],
    [6006, 'TensorBoard', 'tensorboard'], [5173, 'Vite (dev)', 'vite'], [4000, 'Service web', ''], [8443, 'Service web', ''], [9090, 'Prometheus', 'prometheus'],
    [8090, 'Service web', ''], [8200, 'Duplicati', 'duplicati'], [8112, 'Deluge', 'deluge'], [8085, 'qBittorrent', 'qbittorrent'], [6875, 'BookStack', 'bookstack'],
  ];
  route('GET', '/api/discover', { auth: 'admin' }, async () => {
    const known = new Set(db.prepare('SELECT url, ping_url FROM apps').all().flatMap((a) => [a.url, a.ping_url]).filter(Boolean).map((u) => {
      try { const x = new URL(u); return `${['localhost', '127.0.0.1'].includes(x.hostname) ? 'local' : x.hostname}:${x.port || (x.protocol === 'https:' ? 443 : 80)}`; } catch { return ''; }
    }));
    const selfPort = Number(process.env.PORT || ctx.config.port);
    const found = await Promise.all(KNOWN.filter(([p]) => p !== selfPort && !known.has(`local:${p}`)).map(async ([port, name, icon]) => {
      const url = `http://localhost:${port}`;
      const r = await ctx.ping(url);
      if (!r.up) return null;
      let title = '';
      try {
        const html = await fetch(url, { signal: AbortSignal.timeout(3000) }).then((x) => x.text());
        title = (html.match(/<title[^>]*>([^<]{1,60})<\/title>/i) || [])[1]?.trim() || '';
      } catch {}
      return { port, url, name: name === 'Service web' && title ? title : name, title, icon };
    }));
    return found.filter(Boolean);
  });
};
