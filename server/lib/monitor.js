// Moniteur : historique CPU/RAM du PC, disponibilité des apps, journal des connexions.
'use strict';
const os = require('node:os');

module.exports = ({ db, route }) => {
  const history = []; // 1 point / 10 s, 1 h glissante
  let last = os.cpus();
  function sample() {
    const now = os.cpus();
    let idle = 0, total = 0;
    now.forEach((c, i) => {
      const p = last[i] || c;
      for (const t in c.times) total += c.times[t] - p.times[t];
      idle += c.times.idle - p.times.idle;
    });
    last = now;
    history.push({ t: Date.now(), cpu: total ? Math.round(100 * (1 - idle / total)) : 0, mem: Math.round(100 * (1 - os.freemem() / os.totalmem())) });
    if (history.length > 360) history.shift();
  }
  sample();
  setInterval(sample, 10e3);

  route('GET', '/api/monitor', { auth: 'user' }, (req) => {
    const since = Date.now() - 864e5;
    const apps = db.prepare(`SELECT a.id, a.name, a.icon, a.url,
        COUNT(c.ts) AS checks, SUM(c.up) AS ups, AVG(CASE WHEN c.up = 1 THEN c.ms END) AS avg_ms
      FROM apps a LEFT JOIN app_checks c ON c.app_id = a.id AND c.ts >= ?
      WHERE a.ping = 1 ${req.user.role === 'admin' ? '' : 'AND a.admin_only = 0'}
      GROUP BY a.id ORDER BY a.name`).all(since);
    // 24 tranches d'une heure pour la frise de disponibilité
    const buckets = db.prepare(`SELECT app_id, CAST((ts - ?) / 3600000 AS INTEGER) AS h, AVG(up) AS up FROM app_checks WHERE ts >= ? GROUP BY app_id, h`).all(since, since);
    const byApp = {};
    for (const b of buckets) (byApp[b.app_id] ||= Array(24).fill(null))[Math.min(23, b.h)] = b.up;
    return {
      history,
      apps: apps.map((a) => ({ ...a, uptime: a.checks ? Math.round((1000 * a.ups) / a.checks) / 10 : null, avg_ms: a.avg_ms ? Math.round(a.avg_ms) : null, hours: byApp[a.id] || Array(24).fill(null) })),
      events: req.user.role === 'admin' ? db.prepare('SELECT ts, username, action, ip, detail FROM events ORDER BY id DESC LIMIT 50').all() : [],
    };
  });
};
