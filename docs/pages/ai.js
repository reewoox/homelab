'use strict';
/* Assistant IA : tes modèles Ollama locaux, depuis n'importe quel appareil */
(() => {
  const { $, $$, esc, api, state, toast, timeAgo, store } = HL;
  let root, convs = [], current = null, messages = [], models = [], busy = null;

  // Mini-markdown sûr : on échappe tout, puis on ajoute blocs de code, code inline, gras, titres, listes
  function md(src) {
    const blocks = [];
    let s = String(src).replace(/```(\w*)\n?([\s\S]*?)(```|$)/g, (_, lang, code) => { blocks.push(`<pre class="code"><code>${esc(code.replace(/\n$/, ''))}</code></pre>`); return `\u0001${blocks.length - 1}\u0001`; });
    s = esc(s)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/^#{1,4} (.+)$/gm, '<b class="md-h">$1</b>')
      .replace(/^\s*[-*] (.+)$/gm, '• $1')
      .replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\n/g, '<br>');
    return s.replace(/\u0001(\d+)\u0001/g, (_, i) => blocks[i]);
  }
  // Sépare la réflexion (<think>…</think>) de la réponse
  function split(content, think = '') {
    let t = think, c = String(content);
    c = c.replace(/<think>([\s\S]*?)(<\/think>|$)/g, (_, x) => { t += x; return ''; });
    return { think: t.trim(), answer: c.trim() };
  }

  function shell() {
    root.innerHTML = `
      <div class="ai">
        <aside class="ai-side card" id="ai-side">
          <button class="btn primary w100" id="ai-new">+ Nouvelle discussion</button>
          <div class="ai-convs" id="ai-convs"></div>
        </aside>
        <section class="ai-main card">
          <div class="ai-head">
            <button class="icon-btn ai-toggle" id="ai-toggle" title="Discussions">☰</button>
            <select id="ai-model"></select>
            <span class="hint" id="ai-state"></span>
          </div>
          <div class="ai-msgs" id="ai-msgs"></div>
          <form class="ai-input" id="ai-form">
            <textarea id="ai-text" rows="1" placeholder="Écris ton message…  (Entrée pour envoyer, Maj+Entrée pour aller à la ligne)"></textarea>
            <button class="btn primary" id="ai-send" type="submit">Envoyer</button>
          </form>
        </section>
      </div>`;
    $('#ai-new', root).onclick = () => { current = null; messages = []; renderMsgs(); renderConvs(); closeSide(); $('#ai-text', root).focus(); };
    $('#ai-toggle', root).onclick = () => $('#ai-side', root).classList.toggle('open');
    $('#ai-model', root).onchange = (e) => store.set('hl_ai_model', e.target.value);
    const ta = $('#ai-text', root);
    ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'; });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#ai-form', root).requestSubmit(); } });
    $('#ai-form', root).onsubmit = (e) => { e.preventDefault(); busy ? busy.abort() : send(); };
    $('#ai-convs', root).addEventListener('click', async (e) => {
      const del = e.target.closest('[data-del]');
      const item = e.target.closest('[data-conv]');
      if (del) {
        e.stopPropagation();
        if (!confirm('Supprimer cette discussion ?')) return;
        await api(`/api/ai/conversations/${del.dataset.del}`, { method: 'DELETE' });
        if (current === Number(del.dataset.del)) { current = null; messages = []; renderMsgs(); }
        return loadConvs();
      }
      if (item) openConv(Number(item.dataset.conv));
    });
  }
  const closeSide = () => $('#ai-side', root).classList.remove('open');

  async function loadModels() {
    const r = await api('/api/ai/models').catch(() => ({ online: false, models: [] }));
    models = r.models;
    const sel = $('#ai-model', root);
    const saved = store.get('hl_ai_model');
    sel.innerHTML = models.length ? models.map((m) => `<option value="${esc(m.name)}" ${m.name === saved ? 'selected' : ''}>${esc(m.name)}${m.params ? ` · ${esc(m.params)}` : ''}</option>`).join('') : '<option value="">Aucun modèle</option>';
    $('#ai-state', root).innerHTML = r.online ? '<span class="ok-dot"></span> Ollama en ligne' : '⚠️ Ollama est éteint sur le PC';
  }
  async function loadConvs() {
    convs = await api('/api/ai/conversations').catch(() => []);
    renderConvs();
  }
  function renderConvs() {
    $('#ai-convs', root).innerHTML = convs.length ? convs.map((c) => `
      <div class="ai-conv ${c.id === current ? 'active' : ''}" data-conv="${c.id}" tabindex="0">
        <span class="t">${esc(c.title)}</span><span class="hint">${timeAgo(c.updated_at)}</span>
        <button class="x" data-del="${c.id}" title="Supprimer">✕</button>
      </div>`).join('') : '<p class="hint" style="padding:8px">Tes discussions apparaîtront ici, sur tous tes appareils.</p>';
  }
  async function openConv(id) {
    try {
      const c = await api(`/api/ai/conversations/${id}`);
      current = c.id;
      messages = c.messages.map((m) => ({ role: m.role, ...split(m.content) }));
      if (c.model && models.some((m) => m.name === c.model)) $('#ai-model', root).value = c.model;
      renderMsgs(); renderConvs(); closeSide();
    } catch (e) { toast(e.message, true); }
  }

  function msgHtml(m, i) {
    if (m.role === 'user') return `<div class="msg user"><div class="bubble">${esc(m.answer).replace(/\n/g, '<br>')}</div></div>`;
    const thinking = m.streaming && !m.answer;
    return `<div class="msg bot" data-i="${i}">
      <div class="avatar-bot">🤖</div>
      <div class="bubble">
        ${m.think ? `<details class="think" ${thinking ? 'open' : ''}><summary>${thinking ? '💭 Réflexion en cours…' : '💭 Réflexion'}</summary><div>${esc(m.think).replace(/\n/g, '<br>')}</div></details>` : ''}
        ${m.answer ? md(m.answer) : m.streaming && !m.think ? '<span class="typing"><i></i><i></i><i></i></span>' : ''}
        ${m.error ? `<p class="error">${esc(m.error)}</p>` : ''}
        ${!m.streaming && m.answer ? '<button class="copy-msg" type="button" title="Copier">📋</button>' : ''}
      </div></div>`;
  }
  function renderMsgs() {
    const box = $('#ai-msgs', root);
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.innerHTML = messages.length ? messages.map(msgHtml).join('') : `
      <div class="ai-empty">
        <div style="font-size:46px">🤖</div>
        <h3>Ton assistant IA privé</h3>
        <p class="muted">Il tourne sur ton PC avec Ollama : tes conversations ne quittent pas ta maison.</p>
        <div class="ai-sugg">
          ${['Explique-moi Tailscale simplement', 'Écris un script PowerShell qui liste les gros fichiers', 'Donne-moi 5 idées d’apps pour mon homelab', 'Résume ce texte : '].map((s) => `<button class="btn small" type="button">${esc(s)}</button>`).join('')}
        </div>
      </div>`;
    $$('.ai-sugg button', box).forEach((b) => (b.onclick = () => { const ta = $('#ai-text', root); ta.value = b.textContent; ta.focus(); }));
    $$('.copy-msg', box).forEach((b) => (b.onclick = () => {
      const m = messages[Number(b.closest('[data-i]').dataset.i)];
      navigator.clipboard.writeText(m.answer).then(() => toast('Copié 📋'), () => {});
    }));
    if (atBottom || busy) box.scrollTop = box.scrollHeight;
  }

  async function send() {
    const ta = $('#ai-text', root);
    const content = ta.value.trim();
    const model = $('#ai-model', root).value;
    if (!content) return;
    if (!model) return toast('Aucun modèle Ollama disponible', true);
    ta.value = ''; ta.style.height = 'auto';
    messages.push({ role: 'user', answer: content });
    const bot = { role: 'assistant', think: '', answer: '', raw: '', streaming: true };
    messages.push(bot);
    renderMsgs();
    busy = new AbortController();
    $('#ai-send', root).textContent = '■ Stop';
    try {
      const res = await fetch(`${state.api}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
        body: JSON.stringify({ conversation_id: current, model, content }),
        signal: busy.signal,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Erreur ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', think = '', pending = false;
      const paint = () => { pending = false; Object.assign(bot, split(bot.raw, think)); renderMsgs(); };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const j = JSON.parse(line);
          if (j.conversation_id && !current) current = j.conversation_id;
          if (j.think) think += j.think;
          if (j.delta) bot.raw += j.delta;
          if (j.error) bot.error = j.error;
        }
        if (!pending) { pending = true; requestAnimationFrame(paint); }
      }
      Object.assign(bot, split(bot.raw, think));
    } catch (e) {
      if (e.name !== 'AbortError') bot.error = e.message;
      else if (!bot.raw) bot.error = 'Arrêté.';
    } finally {
      bot.streaming = false;
      busy = null;
      $('#ai-send', root).textContent = 'Envoyer';
      renderMsgs();
      loadConvs();
    }
  }

  HL.pages.ai = {
    enter(el) {
      if (!root) { root = el; shell(); renderMsgs(); }
      loadModels();
      loadConvs();
      setTimeout(() => $('#ai-text', root)?.focus(), 50);
    },
  };
})();
