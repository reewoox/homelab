'use strict';
/* Drive : tes fichiers sur le PC, depuis tous tes appareils */
(() => {
  const { $, $$, esc, api, state, toast, openModal, fmtSize, absUrl, store } = HL;
  const CHUNK = 64 * 1024 * 1024; // < 100 Mo : limite par requête du tunnel Cloudflare
  const d = { space: 'perso', path: '', items: [], selected: new Set(), view: store.get('hl_drive_view') || 'grid', uploads: [] };
  let root;

  const ICONS = { folder: '📁', image: '🖼️', video: '🎬', audio: '🎵', pdf: '📕', text: '📄', zip: '🗜️', doc: '📝', sheet: '📊', slide: '📽️', other: '📦' };
  function kind(it) {
    if (it.dir) return 'folder';
    const t = it.type;
    if (t.startsWith('image/')) return 'image';
    if (t.startsWith('video/')) return 'video';
    if (t.startsWith('audio/')) return 'audio';
    if (t === 'application/pdf') return 'pdf';
    if (t.startsWith('text/') || t === 'application/json') return 'text';
    if (/zip|7z|rar/.test(t)) return 'zip';
    if (/word/.test(t)) return 'doc';
    if (/sheet|excel|csv/.test(t)) return 'sheet';
    if (/presentation|powerpoint/.test(t)) return 'slide';
    return 'other';
  }
  const previewable = (it) => ['image', 'video', 'audio', 'pdf', 'text'].includes(kind(it)) && !/heic|svg/.test(it.type);
  const join = (...p) => p.filter(Boolean).join('/');

  function shell() {
    root.innerHTML = `
      <div class="drive-top">
        <div class="tabs drive-tabs">
          <button data-space="perso">👤 Mes fichiers</button>
          <button data-space="commun">👥 Commun</button>
        </div>
        <div class="row">
          <button class="btn primary" id="dv-upload">⬆ Envoyer</button>
          <button class="btn" id="dv-mkdir">+ Dossier</button>
          <button class="icon-btn" id="dv-view" title="Changer l’affichage"></button>
          <input type="file" id="dv-file" multiple hidden>
        </div>
      </div>
      <div class="drive-bar">
        <nav class="crumbs" id="dv-crumbs"></nav>
        <div class="row" id="dv-selbar" hidden>
          <span class="muted" id="dv-selcount"></span>
          <button class="btn small" id="dv-move">Déplacer</button>
          <button class="btn small danger" id="dv-del">Supprimer</button>
          <button class="btn small ghost" id="dv-unsel">Annuler</button>
        </div>
      </div>
      <div id="dv-list"></div>
      <p class="hint drive-foot" id="dv-foot"></p>
      <div class="uploads card" id="dv-uploads" hidden></div>`;
    $$('.drive-tabs button', root).forEach((b) => (b.onclick = () => { d.space = b.dataset.space; d.path = ''; load(); }));
    $('#dv-upload', root).onclick = () => $('#dv-file', root).click();
    $('#dv-file', root).onchange = (e) => { upload([...e.target.files]); e.target.value = ''; };
    $('#dv-mkdir', root).onclick = mkdir;
    $('#dv-view', root).onclick = () => { d.view = d.view === 'grid' ? 'list' : 'grid'; store.set('hl_drive_view', d.view); render(); };
    $('#dv-unsel', root).onclick = () => { d.selected.clear(); render(); };
    $('#dv-del', root).onclick = () => remove([...d.selected]);
    $('#dv-move', root).onclick = () => move([...d.selected]);
    $('#dv-list', root).addEventListener('click', onClick);
  }

  async function load() {
    d.selected.clear();
    try {
      const r = await api(`/api/drive/list?space=${d.space}&path=${encodeURIComponent(d.path)}`);
      d.items = r.items; d.disk = r.disk;
    } catch (e) {
      if (e.status === 404 && d.path) { d.path = ''; return load(); }
      return toast(e.message, true);
    }
    render();
  }

  function render() {
    $$('.drive-tabs button', root).forEach((b) => b.classList.toggle('active', b.dataset.space === d.space));
    $('#dv-view', root).textContent = d.view === 'grid' ? '☰' : '▦';
    const parts = d.path ? d.path.split('/') : [];
    $('#dv-crumbs', root).innerHTML = [`<a data-go="">${d.space === 'commun' ? 'Commun' : 'Mes fichiers'}</a>`]
      .concat(parts.map((p, i) => `<a data-go="${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</a>`)).join('<span>›</span>');
    $$('#dv-crumbs a', root).forEach((a) => (a.onclick = () => { d.path = a.dataset.go; load(); }));
    $('#dv-selbar', root).hidden = !d.selected.size;
    $('#dv-selcount', root).textContent = `${d.selected.size} sélectionné(s)`;

    const list = $('#dv-list', root);
    if (!d.items.length) {
      list.innerHTML = `<div class="empty-drop card"><div style="font-size:42px">📂</div><b>Ce dossier est vide</b><span class="muted">Glisse des fichiers ici ou clique sur « Envoyer ».<br>Depuis ton téléphone : bouton Envoyer → Photos.</span></div>`;
    } else if (d.view === 'grid') {
      list.innerHTML = `<div class="files-grid">${d.items.map((it) => `
        <div class="card file ${d.selected.has(it.name) ? 'sel' : ''}" data-name="${esc(it.name)}" tabindex="0">
          <input type="checkbox" class="pick" ${d.selected.has(it.name) ? 'checked' : ''} aria-label="Sélectionner">
          <button class="more" data-act="menu" title="Actions">⋯</button>
          <div class="thumb">${kind(it) === 'image' && !/heic|svg/.test(it.type) ? `<img src="${esc(absUrl(it.url))}" loading="lazy" alt="">` : `<span>${ICONS[kind(it)]}</span>`}</div>
          <div class="fname" title="${esc(it.name)}">${esc(it.name)}</div>
          <div class="hint">${it.dir ? 'Dossier' : fmtSize(it.size)}</div>
        </div>`).join('')}</div>`;
    } else {
      list.innerHTML = `<div class="card files-list">${d.items.map((it) => `
        <div class="frow ${d.selected.has(it.name) ? 'sel' : ''}" data-name="${esc(it.name)}" tabindex="0">
          <input type="checkbox" class="pick" ${d.selected.has(it.name) ? 'checked' : ''} aria-label="Sélectionner">
          <span class="fi">${ICONS[kind(it)]}</span>
          <span class="fname">${esc(it.name)}</span>
          <span class="hint">${it.dir ? '' : fmtSize(it.size)}</span>
          <span class="hint hide-sm">${new Date(it.mtime).toLocaleDateString('fr-FR')}</span>
          <button class="more" data-act="menu" title="Actions">⋯</button>
        </div>`).join('')}</div>`;
    }
    const files = d.items.filter((i) => !i.dir);
    $('#dv-foot', root).textContent = `${d.items.length} élément(s) · ${fmtSize(files.reduce((s, i) => s + i.size, 0))}` + (d.disk ? ` · ${fmtSize(d.disk.free)} libres sur le PC` : '');
  }

  const itemOf = (el) => d.items.find((i) => i.name === el.closest('[data-name]')?.dataset.name);
  function onClick(e) {
    const el = e.target.closest('[data-name]');
    if (!el) return;
    const it = itemOf(el);
    if (e.target.classList.contains('pick')) {
      e.target.checked ? d.selected.add(it.name) : d.selected.delete(it.name);
      return render();
    }
    if (e.target.closest('[data-act=menu]')) return menu(it);
    if (d.selected.size) { d.selected.has(it.name) ? d.selected.delete(it.name) : d.selected.add(it.name); return render(); }
    open(it);
  }
  $('#page-drive').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('[data-name]')) open(itemOf(e.target)); });

  function open(it) {
    if (it.dir) { d.path = join(d.path, it.name); return load(); }
    if (previewable(it)) return view(it);
    download(it);
  }
  function download(it) {
    const a = document.createElement('a');
    a.href = absUrl(it.url) + '&download=1';
    a.download = it.name;
    document.body.append(a); a.click(); a.remove();
  }

  // ---------- Visionneuse ----------
  const viewer = $('#viewer');
  $('#viewer-close').onclick = () => viewer.close();
  viewer.addEventListener('close', () => { $('#viewer-body').innerHTML = ''; });
  viewer.addEventListener('click', (e) => { if (e.target === viewer) viewer.close(); });
  async function view(it) {
    const src = absUrl(it.url);
    const k = kind(it);
    $('#viewer-name').textContent = it.name;
    $('#viewer-dl').href = src + '&download=1';
    $('#viewer-dl').setAttribute('download', it.name);
    const body = $('#viewer-body');
    if (k === 'image') body.innerHTML = `<img src="${esc(src)}" alt="">`;
    else if (k === 'video') body.innerHTML = `<video src="${esc(src)}" controls autoplay playsinline></video>`;
    else if (k === 'audio') body.innerHTML = `<div class="audio-wrap"><div style="font-size:64px">🎵</div><audio src="${esc(src)}" controls autoplay></audio></div>`;
    else if (k === 'pdf') body.innerHTML = `<iframe src="${esc(src)}" title="PDF"></iframe>`;
    else {
      body.innerHTML = '<pre class="text-view">Chargement…</pre>';
      const txt = it.size > 2e6 ? 'Fichier trop gros pour l’aperçu, télécharge-le.' : await fetch(src).then((r) => r.text()).catch(() => 'Erreur de chargement');
      $('pre', body).textContent = txt;
    }
    viewer.showModal();
  }

  // ---------- Actions ----------
  function menu(it) {
    const full = join(d.path, it.name);
    openModal({
      title: it.name,
      body: `<div class="action-list">
        ${it.dir ? '<button type="button" data-a="open">📂 Ouvrir</button>' : `${previewable(it) ? '<button type="button" data-a="view">👁️ Aperçu</button>' : ''}<button type="button" data-a="dl">⬇ Télécharger</button><button type="button" data-a="share">🔗 Créer un lien de partage</button>`}
        <button type="button" data-a="rename">✎ Renommer</button>
        <button type="button" data-a="move">↪ Déplacer</button>
        <button type="button" data-a="del" class="danger-text">🗑 Supprimer</button>
      </div>
      ${it.dir ? '' : `<p class="hint">${fmtSize(it.size)} · modifié le ${new Date(it.mtime).toLocaleString('fr-FR')}</p>`}`,
      footer: '',
      onOpen() {
        $$('[data-a]', $('#modal-body')).forEach((b) => (b.onclick = () => {
          HL.modal.close();
          ({ open: () => open(it), view: () => view(it), dl: () => download(it), share: () => share(full),
            rename: () => rename(it), move: () => move([it.name]), del: () => remove([it.name]) })[b.dataset.a]();
        }));
      },
    });
  }

  function mkdir() {
    openModal({
      title: 'Nouveau dossier',
      body: '<label>Nom<input name="name" required maxlength="200" placeholder="Photos vacances"></label>',
      async onSubmit(fd) { await api('/api/drive/mkdir', { method: 'POST', body: { space: d.space, path: d.path, name: fd.get('name') } }); load(); },
    });
  }
  function rename(it) {
    openModal({
      title: 'Renommer',
      body: `<label>Nouveau nom<input name="name" required maxlength="200" value="${esc(it.name)}"></label>`,
      onOpen() { const i = $('#modal-body input'); const dot = it.dir ? -1 : it.name.lastIndexOf('.'); i.setSelectionRange(0, dot > 0 ? dot : it.name.length); },
      async onSubmit(fd) { await api('/api/drive/rename', { method: 'POST', body: { space: d.space, path: join(d.path, it.name), newName: fd.get('name') } }); load(); },
    });
  }
  async function remove(names) {
    if (!names.length || !confirm(names.length === 1 ? `Supprimer « ${names[0]} » ? C’est définitif.` : `Supprimer ${names.length} éléments ? C’est définitif.`)) return;
    try {
      await api('/api/drive/delete', { method: 'POST', body: { space: d.space, paths: names.map((n) => join(d.path, n)) } });
      toast('Supprimé');
    } catch (e) { toast(e.message, true); }
    load();
  }
  async function move(names) {
    // Liste des dossiers (2 niveaux) des deux espaces
    const folders = [];
    async function walk(space, p, depth) {
      folders.push({ space, path: p });
      if (depth >= 2) return;
      const r = await api(`/api/drive/list?space=${space}&path=${encodeURIComponent(p)}`).catch(() => ({ items: [] }));
      for (const it of r.items.filter((i) => i.dir)) {
        const sub = join(p, it.name);
        if (space === d.space && names.some((n) => sub === join(d.path, n) || sub.startsWith(join(d.path, n) + '/'))) continue;
        await walk(space, sub, depth + 1);
      }
    }
    await walk('perso', '', 0); await walk('commun', '', 0);
    openModal({
      title: `Déplacer ${names.length} élément(s)`,
      body: `<label>Destination<select name="dest">${folders.map((f, i) => `<option value="${i}" ${f.space === d.space && f.path === d.path ? 'disabled' : ''}>${f.space === 'commun' ? '👥 Commun' : '👤 Mes fichiers'}${f.path ? ' / ' + esc(f.path.replace(/\//g, ' / ')) : ''}</option>`).join('')}</select></label>`,
      async onSubmit(fd) {
        const f = folders[Number(fd.get('dest'))];
        await api('/api/drive/move', { method: 'POST', body: { space: d.space, paths: names.map((n) => join(d.path, n)), toSpace: f.space, to: f.path } });
        toast('Déplacé'); load();
      },
    });
  }
  function share(full) {
    openModal({
      title: 'Lien de partage',
      body: `<div class="stack">
        <p class="muted" style="margin:0">Toute personne ayant le lien pourra télécharger ce fichier, sans compte.</p>
        <label>Durée de validité<select name="days"><option value="1">1 jour</option><option value="7" selected>7 jours</option><option value="30">30 jours</option></select></label>
        <div id="share-out"></div>
      </div>`,
      footer: `<button class="btn ghost" value="cancel" formnovalidate>Fermer</button><button class="btn primary" value="ok">Créer le lien</button>`,
      async onSubmit(fd) {
        const r = await api('/api/drive/share', { method: 'POST', body: { space: d.space, path: full, days: Number(fd.get('days')) } });
        const base = state.health.publicUrl || state.api || location.origin;
        const url = base + r.url;
        $('#share-out').innerHTML = `<div class="copy-row"><input readonly value="${esc(url)}"><button class="btn" type="button">Copier</button></div>
          <p class="hint">⚠️ Le lien passe par le tunnel : il cesse de marcher si le PC redémarre (nouvelle adresse).</p>`;
        $('#share-out button').onclick = () => copy(url);
        if (navigator.share && /Mobi|Android|iPhone|iPad/.test(navigator.userAgent)) navigator.share({ url }).catch(() => {});
        return false; // on garde la fenêtre ouverte
      },
    });
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Copié 📋'); } catch { prompt('Copie ce lien :', text); }
  }

  // ---------- Envoi de fichiers (par morceaux, avec progression) ----------
  function upload(files) {
    if (!files.length) return;
    const target = { space: d.space, path: d.path };
    for (const f of files) d.uploads.push({ file: f, target, sent: 0, state: 'wait', id: crypto.randomUUID?.() || String(Math.random()).slice(2) });
    renderUploads();
    pump();
  }
  let pumping = false;
  async function pump() {
    if (pumping) return;
    pumping = true;
    let u;
    while ((u = d.uploads.find((x) => x.state === 'wait'))) {
      u.state = 'up';
      try {
        for (let off = 0; off < u.file.size || off === 0; off += CHUNK) {
          const end = Math.min(off + CHUNK, u.file.size);
          const final = end >= u.file.size;
          await sendChunk(u, off, u.file.slice(off, end), final);
          if (final) break;
        }
        u.state = 'done';
      } catch (e) { u.state = 'err'; u.error = e.message; }
      renderUploads();
      if (state.page === 'drive' && u.target.space === d.space && u.target.path === d.path) load();
    }
    pumping = false;
    if (d.uploads.every((x) => x.state === 'done')) {
      toast(`${d.uploads.length} fichier(s) envoyé(s) ✅`);
      setTimeout(() => { d.uploads = d.uploads.filter((x) => x.state !== 'done'); renderUploads(); }, 2500);
    }
  }
  function sendChunk(u, offset, blob, final) {
    return new Promise((resolve, reject) => {
      const qs = new URLSearchParams({ space: u.target.space, path: u.target.path, name: u.file.name, id: u.id, offset, final: final ? '1' : '0' });
      const x = new XMLHttpRequest();
      x.open('POST', `${state.api}/api/drive/upload?${qs}`);
      x.setRequestHeader('Authorization', `Bearer ${state.token}`);
      x.setRequestHeader('Content-Type', 'application/octet-stream');
      x.upload.onprogress = (e) => { u.sent = offset + e.loaded; renderUploads(); };
      x.onload = () => {
        if (x.status >= 200 && x.status < 300) return resolve();
        let msg = `Erreur ${x.status}`; try { msg = JSON.parse(x.responseText).error || msg; } catch {}
        reject(new Error(msg));
      };
      x.onerror = () => reject(new Error('Connexion perdue'));
      x.send(blob);
    });
  }
  function renderUploads() {
    const box = $('#dv-uploads');
    if (!box) return;
    box.hidden = !d.uploads.length;
    const pct = (u) => (u.file.size ? Math.round((100 * u.sent) / u.file.size) : 100);
    box.innerHTML = `<div class="head"><b>Envois</b><button class="btn small ghost" type="button" id="up-clear">Masquer</button></div>` + d.uploads.map((u) => `
      <div class="up">
        <div class="lbl"><span class="fname">${esc(u.file.name)}</span><span class="hint">${u.state === 'err' ? '❌ ' + esc(u.error) : u.state === 'done' ? '✅' : u.state === 'wait' ? 'en attente' : pct(u) + ' %'}</span></div>
        <div class="bar"><i style="width:${u.state === 'done' ? 100 : pct(u)}%" class="${u.state === 'err' ? 'crit' : ''}"></i></div>
      </div>`).join('');
    $('#up-clear').onclick = () => { d.uploads = d.uploads.filter((x) => x.state === 'up' || x.state === 'wait'); renderUploads(); };
  }

  // Glisser-déposer depuis le bureau
  const overlay = $('#drop-overlay');
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (state.page !== 'drive' || !hasFiles(e)) return; dragDepth++; overlay.hidden = false; });
  window.addEventListener('dragleave', (e) => { if (state.page !== 'drive' || !hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; overlay.hidden = true; } });
  window.addEventListener('dragover', (e) => { if (state.page === 'drive' && hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (state.page !== 'drive' || !hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; overlay.hidden = true;
    upload([...e.dataTransfer.files]);
  });
  // Coller une image/fichier (Ctrl+V)
  window.addEventListener('paste', (e) => {
    if (state.page !== 'drive' || e.target.closest('input, textarea') || HL.modal.open) return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); upload(files); }
  });

  HL.pages.drive = {
    enter(el) {
      if (!root) { root = el; shell(); }
      load();
      renderUploads();
    },
  };
})();
