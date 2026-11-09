'use strict';
/* Moniteur : charge du PC sur 1 h, disponibilité des apps sur 24 h, journal des connexions */
(() => {
  const { $, $$, esc, api, state, timeAgo, iconHtml } = HL;
  let root, timer, data;

  // Graphe en aire, une seule série, avec curseur + infobulle au survol
  function areaChart(points, key, label) {
    const W = 600, H = 160, P = { l: 34, r: 8, t: 10, b: 22 };
    if (points.length < 2) return `<div class="chart-empty muted">Collecte des données… (un point toutes les 10 s)</div>`;
    const t0 = points[0].t, t1 = points[points.length - 1].t;
    const x = (t) => P.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - P.l - P.r);
    const y = (v) => P.t + (1 - v / 100) * (H - P.t - P.b);
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p[key]).toFixed(1)}`).join('');
    const area = `${line}L${x(t1).toFixed(1)},${y(0)}L${x(t0).toFixed(1)},${y(0)}Z`;
    const grid = [0, 50, 100].map((v) => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${P.l - 6}" y="${y(v) + 4}" class="axis" text-anchor="end">${v}%</text>`).join('');
    const ticks = [t0, (t0 + t1) / 2, t1].map((t, i) => `<text x="${x(t)}" y="${H - 5}" class="axis" text-anchor="${['start', 'middle', 'end'][i]}">${new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</text>`).join('');
    const last = points[points.length - 1][key];
    const avg = Math.round(points.reduce((s, p) => s + p[key], 0) / points.length);
    const max = Math.max(...points.map((p) => p[key]));
    return `<div class="chart" data-key="${key}">
      <div class="chart-head"><b>${label}</b><span class="hero">${last}<small>%</small></span><span class="hint">moy. ${avg}% · max ${max}% · 1 h</span></div>
      <div class="chart-box">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${label} sur la dernière heure, actuellement ${last}%">
          ${grid}<path d="${area}" class="area"/><path d="${line}" class="line"/>
          <line class="cross" y1="${P.t}" y2="${H - P.b}" x1="-10" x2="-10"/><circle class="dot" r="4" cx="-10" cy="-10"/>
          <rect class="hit" x="${P.l}" y="0" width="${W - P.l - P.r}" height="${H}" fill="transparent"/>
        </svg>
        <div class="tip" hidden></div>
      </div>
    </div>`;
  }
  function bindChart(el, points, key) {
    const svg = $('svg', el), tip = $('.tip', el);
    if (!svg) return;
    const W = 600, P = { l: 34, r: 8, t: 10, b: 22 }, H = 160;
    const t0 = points[0].t, t1 = points[points.length - 1].t;
    const move = (e) => {
      const r = svg.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      const t = t0 + ((px - P.l) / (W - P.l - P.r)) * (t1 - t0);
      let best = points[0];
      for (const p of points) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
      const bx = P.l + ((best.t - t0) / Math.max(1, t1 - t0)) * (W - P.l - P.r);
      const by = P.t + (1 - best[key] / 100) * (H - P.t - P.b);
      $('.cross', svg).setAttribute('x1', bx); $('.cross', svg).setAttribute('x2', bx);
      $('.dot', svg).setAttribute('cx', bx); $('.dot', svg).setAttribute('cy', by);
      tip.hidden = false;
      tip.innerHTML = `<b>${best[key]}%</b> <span class="muted">${new Date(best.t).toLocaleTimeString('fr-FR')}</span>`;
      const left = (bx / W) * r.width;
      tip.style.left = `${Math.min(Math.max(left, 50), r.width - 50)}px`;
    };
    const out = () => { tip.hidden = true; $('.cross', svg).setAttribute('x1', -10); $('.cross', svg).setAttribute('x2', -10); $('.dot', svg).setAttribute('cx', -10); };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerleave', out);
  }

  function uptimeRows(apps) {
    if (!apps.length) return '<p class="muted">Aucune app surveillée.</p>';
    return apps.map((a) => {
      const st = state.status[a.id];
      const now = st ? (st.up ? '<span class="st up">● En ligne</span>' : '<span class="st down">● Hors ligne</span>') : '<span class="st">—</span>';
      const cells = a.hours.map((h, i) => {
        const hourLabel = `il y a ${23 - i} h`;
        if (h == null) return `<i class="nodata" title="${hourLabel} : pas de donnée"></i>`;
        const pct = Math.round(h * 100);
        return `<i class="${pct >= 99 ? 'good' : pct >= 50 ? 'warn' : 'bad'}" title="${hourLabel} : ${pct}% disponible"></i>`;
      }).join('');
      return `<div class="up-row">
        <div class="up-name"><span class="mini-ico">${iconHtml(a.icon, a.name)}</span><b>${esc(a.name)}</b></div>
        <div class="up-bars" aria-label="Disponibilité heure par heure sur 24 h">${cells}</div>
        <div class="up-stats">${now}<span class="hint">${a.uptime == null ? '—' : a.uptime + '% sur 24 h'}${a.avg_ms ? ` · ${a.avg_ms} ms` : ''}</span></div>
      </div>`;
    }).join('');
  }

  function render() {
    const admin = state.user.role === 'admin';
    root.innerHTML = `
      <div class="mon-grid">
        <div class="card mon-card" id="mon-cpu">${areaChart(data.history, 'cpu', 'Processeur')}</div>
        <div class="card mon-card" id="mon-mem">${areaChart(data.history, 'mem', 'Mémoire vive')}</div>
      </div>
      <div class="card mon-card">
        <div class="chart-head"><b>Disponibilité des apps</b><span class="hint">24 dernières heures · vérification chaque minute</span></div>
        <div class="legend-up"><span><i class="good"></i>OK</span><span><i class="warn"></i>Coupures</span><span><i class="bad"></i>Hors ligne</span><span><i class="nodata"></i>Pas de donnée</span></div>
        ${uptimeRows(data.apps)}
      </div>
      ${admin ? `<div class="card mon-card">
        <div class="chart-head"><b>Journal de sécurité</b><span class="hint">connexions, inscriptions, partages</span></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Quand</th><th>Utilisateur</th><th>Action</th><th>IP</th><th>Détail</th></tr></thead>
          <tbody>${data.events.map((e) => `<tr class="${/échec/.test(e.action) ? 'ev-bad' : ''}">
            <td title="${new Date(e.ts).toLocaleString('fr-FR')}">${timeAgo(e.ts)}</td><td>${esc(e.username || '—')}</td>
            <td>${/échec/.test(e.action) ? '⚠️ ' : ''}${esc(e.action)}</td><td class="muted">${esc(e.ip || '')}</td><td class="muted">${esc(e.detail || '')}</td>
          </tr>`).join('') || '<tr><td colspan="5" class="muted">Rien pour l’instant.</td></tr>'}</tbody>
        </table></div>
      </div>` : ''}`;
    if (data.history.length >= 2) {
      bindChart($('#mon-cpu', root), data.history, 'cpu');
      bindChart($('#mon-mem', root), data.history, 'mem');
    }
  }

  async function load() {
    try { data = await api('/api/monitor'); } catch { return; }
    // On ne redessine pas pendant un survol de graphe
    if (root.querySelector('.tip:not([hidden])')) return;
    render();
  }

  HL.pages.monitor = {
    enter(el) {
      root = el;
      if (!data) root.innerHTML = '<div class="center-pad"><div class="spinner"></div></div>';
      load();
      clearInterval(timer);
      timer = setInterval(() => { if (!document.hidden) load(); }, 10000);
    },
    leave() { clearInterval(timer); },
  };
})();
