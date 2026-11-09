'use strict';
/* Presse-papiers partagé : envoie un texte ou un lien d'un appareil à l'autre */
(() => {
  const { $, $$, esc, api, toast, timeAgo, deviceName } = HL;
  let root, timer, clips = [], lastSig = '';

  const linkify = (s) => esc(s).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
  const DEV_ICON = (d) => (/iPhone|Android$/.test(d) ? '📱' : /iPad|Tablette/.test(d) ? '📲' : '💻');

  function shell() {
    root.innerHTML = `
      <div class="clip-wrap">
        <div class="card clip-new">
          <textarea id="cl-text" rows="3" placeholder="Colle ou tape un texte, un lien, un code… puis Envoyer : il apparaît sur tous tes appareils."></textarea>
          <div class="row" style="justify-content:space-between">
            <span class="hint">Depuis : ${esc(deviceName())} · <kbd>Ctrl</kbd>+<kbd>Entrée</kbd></span>
            <div class="row">
              <button class="btn" type="button" id="cl-paste">📋 Coller</button>
              <button class="btn primary" type="button" id="cl-send">Envoyer</button>
            </div>
          </div>
        </div>
        <div class="row clip-head"><b>Historique</b><button class="btn small ghost" type="button" id="cl-clear">Tout effacer (sauf épinglés)</button></div>
        <div id="cl-list" class="clip-list"></div>
      </div>`;
    const ta = $('#cl-text', root);
    $('#cl-send', root).onclick = send;
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); });
    $('#cl-paste', root).onclick = async () => {
      try { ta.value = await navigator.clipboard.readText(); ta.focus(); }
      catch { toast('Ton navigateur bloque la lecture : colle avec Ctrl+V / appui long', true); ta.focus(); }
    };
    $('#cl-clear', root).onclick = async () => {
      if (!confirm('Effacer tout l’historique non épinglé ?')) return;
      await api('/api/clips/all', { method: 'DELETE' }).catch((e) => toast(e.message, true));
      load(true);
    };
    $('#cl-list', root).addEventListener('click', onClick);
  }

  async function send() {
    const ta = $('#cl-text', root);
    const content = ta.value;
    if (!content.trim()) return ta.focus();
    try {
      await api('/api/clips', { method: 'POST', body: { content, device: deviceName() } });
      ta.value = '';
      load(true);
    } catch (e) { toast(e.message, true); }
  }

  async function load(force) {
    try { clips = await api('/api/clips'); } catch { return; }
    const sig = clips.map((c) => `${c.id}:${c.pinned}`).join(',');
    if (!force && sig === lastSig) return;
    lastSig = sig;
    const list = $('#cl-list', root);
    list.innerHTML = clips.length ? clips.map((c) => `
      <div class="card clip ${c.pinned ? 'pinned' : ''}" data-id="${c.id}">
        <div class="clip-body">${linkify(c.content)}</div>
        <div class="clip-meta">
          <span class="hint">${DEV_ICON(c.device || '')} ${esc(c.device || 'Appareil')} · ${timeAgo(c.created_at)}${c.pinned ? ' · 📌 épinglé' : ''}</span>
          <div class="row">
            <button class="btn small primary" data-a="copy">Copier</button>
            <button class="btn small" data-a="pin">${c.pinned ? 'Désépingler' : '📌'}</button>
            <button class="btn small ghost" data-a="del" title="Supprimer">🗑</button>
          </div>
        </div>
      </div>`).join('') : '<div class="empty muted">Rien pour l’instant. Envoie un texte depuis ton téléphone, il apparaîtra ici sur ton PC (et inversement).</div>';
  }

  async function onClick(e) {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const id = Number(b.closest('[data-id]').dataset.id);
    const c = clips.find((x) => x.id === id);
    if (b.dataset.a === 'copy') {
      try { await navigator.clipboard.writeText(c.content); toast('Copié 📋'); }
      catch {
        const ta = document.createElement('textarea'); ta.value = c.content; document.body.append(ta); ta.select();
        document.execCommand('copy'); ta.remove(); toast('Copié 📋');
      }
    } else if (b.dataset.a === 'pin') {
      await api(`/api/clips/${id}`, { method: 'PUT', body: { pinned: !c.pinned } }).catch((er) => toast(er.message, true));
      load(true);
    } else if (b.dataset.a === 'del') {
      await api(`/api/clips/${id}`, { method: 'DELETE' }).catch((er) => toast(er.message, true));
      load(true);
    }
  }

  HL.pages.clip = {
    enter(el) {
      if (!root) { root = el; shell(); }
      lastSig = '';
      load(true);
      clearInterval(timer);
      timer = setInterval(() => { if (!document.hidden) load(); }, 4000);
    },
    leave() { clearInterval(timer); },
  };
})();
