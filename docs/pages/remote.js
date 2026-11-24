'use strict';
/* Remote : prendre le contrôle de tes appareils à distance (RustDesk auto-hébergé + secours dans le navigateur).
   Tout passe par Tailscale ; la page refuse de s'ouvrir par l'adresse publique du homelab. */
(() => {
  const { $, esc, api, toast, timeAgo, deviceName } = HL;
  let root, timer, data, showPw = false, lastSig = '';

  const OS = { windows: ['💻', 'Windows'], macOS: ['💻', 'Mac'], linux: ['🐧', 'Linux'], iOS: ['📱', 'iPhone / iPad'], android: ['📱', 'Android'] };
  const fmtId = (id) => (/^\d+$/.test(String(id)) ? String(id).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : String(id || '')); // comme l'app : 5 159 617
  const since = (d) => (d.online ? 'en ligne' : d.lastSeen && !d.lastSeen.startsWith('0001') ? `vu ${timeAgo(Date.parse(d.lastSeen))}` : 'hors ligne');

  async function copy(text, what = 'Copié') {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    toast(`${what} 📋`);
  }

  // ---------- Rendu ----------
  function serverCard(s) {
    const up = s.idUp && s.relayUp;
    return `<div class="card rc-status ${up ? 'ok' : 'ko'}">
      <div class="rc-status-main">
        <b>${up ? '● Serveur RustDesk en marche' : '⚠️ Serveur RustDesk arrêté'}</b>
        <span class="hint">${up ? `Annuaire et relais sur ${esc(s.host)}, ouverts seulement à tes appareils Tailscale.`
          : `${s.idUp ? '' : 'Annuaire (hbbs) arrêté. '}${s.relayUp ? '' : 'Relais (hbbr) arrêté. '}Relance la tâche « Homelab RustDesk » sur le PC.`}</span>
      </div>
      <span class="hint">🛰️ Allume Tailscale sur ton téléphone avant de t'en servir, même à la maison.</span>
    </div>`;
  }

  function pcCard(d, pc, web) {
    const ready = pc.installed && pc.id;
    const pw = pc.password ? (showPw ? esc(pc.password) : '•'.repeat(12)) : '';
    return `<div class="card rc-dev ${d.viewer ? 'is-viewer' : ''}">
      <div class="rc-head"><span class="rc-ico">💻</span><div><b>${esc(d.name)}</b> <span class="muted">· ce PC</span>
        <div class="dev-st ${d.online ? 'on' : ''}">${since(d)}</div></div></div>
      ${d.viewer ? '<p class="note rc-note">Tu es sur ce PC : ouvre cette page sur ton téléphone pour le piloter.</p>' : ''}
      ${ready ? `<dl class="rc-ids">
          <dt>ID RustDesk</dt><dd><code>${fmtId(pc.id)}</code> <button class="btn small ghost" data-copy="${esc(pc.id)}" data-what="ID copié">Copier</button>
            ${pc.registered ? '<span class="pill active">inscrit</span>' : '<span class="pill pending">pas encore inscrit</span>'}</dd>
          <dt>Mot de passe</dt><dd><code>${pw}</code> <button class="btn small ghost" data-a="pw">${showPw ? 'Masquer' : 'Afficher'}</button>
            <button class="btn small ghost" data-copy="${esc(pc.password)}" data-what="Mot de passe copié">Copier</button></dd>
        </dl>
        ${d.viewer ? '' : `<div class="rc-actions">
          <a class="btn primary" href="${esc(d.connect)}">🖥️ Contrôler avec RustDesk</a>
          ${web ? `<a class="btn" href="${esc(web.control)}" target="_blank" rel="noopener">🌐 Dans le navigateur, sans app${web.up ? '' : ' (arrêté)'}</a>` : ''}
        </div>
        <p class="hint">« Contrôler avec RustDesk » ouvre l'app déjà réglée sur ton serveur, mot de passe compris. Ça marche aussi sur l'écran de connexion Windows.</p>`}`
      : `<p class="muted">RustDesk n'est pas encore installé sur ce PC : lance <code>scripts\\install-remote-admin.ps1</code> en administrateur.</p>
        ${web ? `<div class="rc-actions"><a class="btn" href="${esc(web.control)}" target="_blank" rel="noopener">🌐 Contrôler dans le navigateur</a></div>` : ''}`}
    </div>`;
  }

  function iphoneCard(d, web) {
    return `<div class="card rc-dev ${d.viewer ? 'is-viewer' : ''}">
      <div class="rc-head"><span class="rc-ico">📱</span><div><b>${esc(d.name)}</b>${d.viewer ? ' <span class="muted">· cet appareil</span>' : ''}
        <div class="dev-st ${d.online ? 'on' : ''}">${since(d)}</div></div></div>
      <p class="muted rc-why">Apple interdit de piloter un iPhone à distance : aucune app ne peut le faire. Depuis l'iPhone, tu pilotes le PC et la tablette.</p>
      ${web ? `<div class="rc-actions"><a class="btn" href="${esc(web.hub)}" target="_blank" rel="noopener">🔔 Sonner · 📷 caméra · ✉️ envois</a></div>
        <p class="hint">Le Hub : depuis le PC, fais sonner l'iPhone, regarde sa caméra ou envoie-lui un fichier. La page doit être ouverte sur l'iPhone.</p>` : ''}
    </div>`;
  }

  function otherCard(d) {
    const [ico, osName] = OS[d.os] || ['🖥️', 'Appareil'];
    return `<div class="card rc-dev ${d.viewer ? 'is-viewer' : ''}">
      <div class="rc-head"><span class="rc-ico">${ico}</span><div><b>${esc(d.name)}</b> <span class="muted">· ${esc(osName)}${d.viewer ? ' · cet appareil' : ''}</span>
        ${d.online === null ? '' : `<div class="dev-st ${d.online ? 'on' : ''}">${since(d)}</div>`}</div></div>
      ${d.rustdeskId ? `<dl class="rc-ids"><dt>ID RustDesk</dt><dd><code>${fmtId(d.rustdeskId)}</code> <button class="btn small ghost" data-copy="${esc(d.rustdeskId)}" data-what="ID copié">Copier</button></dd></dl>
        <div class="rc-actions"><a class="btn primary" href="${esc(d.connect)}">🖥️ Contrôler avec RustDesk</a></div>
        <p class="hint">La première fois, RustDesk demande le mot de passe choisi sur l'appareil. Coche « Se souvenir ».</p>`
      : `<p class="muted">RustDesk n'est pas encore installé ou relié au serveur sur cet appareil.</p>
        <div class="rc-actions"><a class="btn" href="#rc-install" data-a="install">Comment l'installer ↓</a></div>`}
    </div>`;
  }

  function installCard(s, links) {
    const val = (label, v, what) => `<div class="rc-val"><span class="hint">${label}</span><code>${esc(v)}</code><button class="btn small ghost" data-copy="${esc(v)}" data-what="${what}">Copier</button></div>`;
    return `<div class="card rc-install" id="rc-install">
      <h3>Installer le remote sur un appareil</h3>
      <div class="rc-cols">
        <div class="rc-qr-box">
          ${s.qrSvg ? `<div class="rc-qr" role="img" aria-label="QR code de configuration RustDesk">${s.qrSvg}</div>
            <p class="hint">À scanner avec l'app RustDesk du téléphone ou de la tablette, depuis l'écran du PC. Sur le téléphone même : fais une capture du QR, puis choisis-la dans le scanner de RustDesk (bouton image).</p>` : ''}
          ${val('Serveur ID', s.host, 'Serveur copié')}
          ${val('Serveur relais', s.host, 'Serveur copié')}
          ${val('Clé', s.key, 'Clé copiée')}
          ${val('Configuration complète (pour « Importer »)', s.configString, 'Configuration copiée')}
        </div>
        <div class="rc-steps">
          <details open><summary>📱 iPhone (pour piloter le PC et la tablette)</summary><ol>
            <li>Tailscale installé et <b>allumé</b> (même compte que le PC).</li>
            <li>Installe <a href="${esc(links.ios)}" target="_blank" rel="noopener">RustDesk sur l'App Store</a>.</li>
            <li>Le plus simple : reviens sur cette page et touche « Contrôler avec RustDesk ». L'app s'ouvre déjà réglée.</li>
            <li>Pour te servir de l'app seule : Réglages → Serveur ID/Relais, puis scanne le QR ou colle « Serveur ID » et « Clé ».</li>
          </ol></details>
          <details><summary>📲 Galaxy Tab / Android (pour pouvoir la piloter)</summary><ol>
            <li>Tailscale installé et allumé, même compte.</li>
            <li>Installe RustDesk : <a href="${esc(links.android)}" target="_blank" rel="noopener">APK officiel sur GitHub</a> (fichier « aarch64 ») ou <a href="${esc(links.fdroid)}" target="_blank" rel="noopener">F-Droid</a>.</li>
            <li>Dans RustDesk : Réglages → Serveur ID/Relais → scanne le QR (ou colle les valeurs).</li>
            <li>Onglet « Partager l'écran » → <b>Démarrer le service</b> et accepte la capture d'écran. Active aussi « Saisie » (accessibilité « RustDesk Input »), sinon tu verras l'écran sans pouvoir toucher.</li>
            <li>Menu ⋮ → choisis un <b>mot de passe permanent</b>.</li>
            <li>La tablette apparaît ensuite ici toute seule, avec son bouton « Contrôler ».</li>
          </ol></details>
          <details><summary>💻 Autre ordinateur (Windows, Mac)</summary><ol>
            <li>Tailscale installé et allumé, même compte.</li>
            <li><a href="${esc(links.desktop)}" target="_blank" rel="noopener">Télécharge RustDesk</a>.</li>
            <li>Réglages → Réseau → Serveur ID/Relais → <b>Importer</b> après avoir copié la « Configuration complète ».</li>
          </ol></details>
        </div>
      </div>
    </div>`;
  }

  function render() {
    if (!data.private) {
      root.innerHTML = `<div class="card rc-lock">
        <div class="big">🔒</div>
        <h3>Le remote passe seulement par Tailscale</h3>
        <p class="muted">Tu as ouvert le homelab par son adresse publique (${esc(deviceName())}). Pour piloter tes appareils, allume Tailscale sur cet appareil puis ouvre l'adresse privée.</p>
        ${data.tailnetUrl ? `<a class="btn primary" href="${esc(data.tailnetUrl)}/#/remote">Ouvrir le homelab par Tailscale</a>` : '<p class="error">Tailscale n’est pas connecté sur le PC.</p>'}
      </div>`;
      return;
    }
    const devs = data.devices || [];
    const mine = devs.find((d) => d.me);
    const others = devs.filter((d) => !d.me).sort((a, b) => (b.os === 'iOS') - (a.os === 'iOS') || b.online - a.online);
    root.innerHTML = `${serverCard(data.server)}
      <div class="rc-grid">
        ${mine ? pcCard(mine, data.pc, data.web) : ''}
        ${others.map((d) => (d.os === 'iOS' ? iphoneCard(d, data.web) : otherCard(d))).join('')}
      </div>
      ${installCard(data.server, data.links)}`;
  }

  async function load(force) {
    try { data = await api('/api/telecommande'); }
    catch (e) {
      if (!data) root.innerHTML = `<div class="card rc-lock"><p class="error">${esc(e.message)}</p></div>`;
      return;
    }
    // On ne redessine que si quelque chose a changé (sinon les menus dépliés se referment)
    const sig = JSON.stringify([data.private, data.server?.idUp, data.server?.relayUp, data.pc, (data.devices || []).map((d) => [d.name, d.online, d.rustdeskId, d.registered, d.viewer]), data.web?.up, showPw]);
    if (!force && sig === lastSig) return;
    const open = [...root.querySelectorAll('details')].map((x) => x.open);
    lastSig = sig;
    render();
    if (!force) [...root.querySelectorAll('details')].forEach((x, i) => { if (open[i] !== undefined) x.open = open[i]; });
  }

  function onClick(e) {
    const c = e.target.closest('[data-copy]');
    if (c) { e.preventDefault(); return copy(c.dataset.copy, c.dataset.what); }
    const a = e.target.closest('[data-a]');
    if (!a) return;
    if (a.dataset.a === 'pw') { showPw = !showPw; load(true); }
    if (a.dataset.a === 'install') {
      e.preventDefault();
      const box = $('#rc-install', root);
      const android = box?.querySelectorAll('details')[1];
      if (android) android.open = true;
      box?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  HL.pages.remote = {
    enter(el) {
      if (!root) { root = el; root.addEventListener('click', onClick); root.innerHTML = '<div class="center-pad"><div class="spinner"></div></div>'; }
      showPw = false;
      load(true);
      clearInterval(timer);
      timer = setInterval(() => { if (!document.hidden) load(); }, 15000);
    },
    leave() { clearInterval(timer); showPw = false; },
  };
})();
