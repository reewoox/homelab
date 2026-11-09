// Assistant IA : discute avec tes modèles Ollama locaux depuis n'importe quel appareil.
// Les conversations sont enregistrées sur le PC et synchronisées entre appareils.
'use strict';
module.exports = (ctx) => {
  const { db, route, httpError, readBody, str } = ctx;
  const OLLAMA = (ctx.config.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');

  db.exec(`
  CREATE TABLE IF NOT EXISTS ai_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    model TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ai_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );`);

  const own = (req, id) => {
    const c = db.prepare('SELECT * FROM ai_conversations WHERE id = ? AND user_id = ?').get(Number(id), req.user.id);
    if (!c) throw httpError(404, 'Conversation introuvable');
    return c;
  };

  route('GET', '/api/ai/models', { auth: 'user' }, async () => {
    try {
      const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(4000) });
      const j = await r.json();
      return { online: true, models: (j.models || []).map((m) => ({ name: m.name, size: m.size, family: m.details?.family, params: m.details?.parameter_size })) };
    } catch {
      return { online: false, models: [] };
    }
  });

  route('GET', '/api/ai/conversations', { auth: 'user' }, (req) =>
    db.prepare('SELECT id, title, model, updated_at FROM ai_conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100').all(req.user.id));

  route('GET', '/api/ai/conversations/:id', { auth: 'user' }, (req, p) => {
    const c = own(req, p.id);
    return { ...c, messages: db.prepare('SELECT role, content, created_at FROM ai_messages WHERE conversation_id = ? ORDER BY id').all(c.id) };
  });

  route('DELETE', '/api/ai/conversations/:id', { auth: 'user' }, (req, p) => {
    db.prepare('DELETE FROM ai_conversations WHERE id = ? AND user_id = ?').run(Number(p.id), req.user.id);
    return { ok: true };
  });

  // Réponse en flux (NDJSON) : {"delta":"..."} ... {"done":true,"conversation_id":n}
  route('POST', '/api/ai/chat', { auth: 'user' }, async (req, p, res) => {
    const b = await readBody(req);
    const content = String(b.content || '').trim().slice(0, 20000);
    const model = str(b.model, 100);
    if (!content) throw httpError(400, 'Message vide');
    if (!model) throw httpError(400, 'Choisis un modèle');
    let conv = b.conversation_id ? own(req, b.conversation_id) : null;
    if (!conv) {
      const id = db.prepare('INSERT INTO ai_conversations (user_id, title, model, updated_at) VALUES (?, ?, ?, ?)').run(req.user.id, content.slice(0, 60), model, Date.now()).lastInsertRowid;
      conv = own(req, id);
    }
    db.prepare('INSERT INTO ai_messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(conv.id, 'user', content, Date.now());
    const history = db.prepare('SELECT role, content FROM ai_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 40').all(conv.id).reverse()
      .map((m) => ({ role: m.role, content: m.role === 'assistant' ? m.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim() : m.content }));

    const abort = new AbortController();
    res.on('close', () => abort.abort());
    let upstream;
    try {
      upstream = await fetch(`${OLLAMA}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: 'Tu es un assistant utile. Réponds en français sauf si on te parle dans une autre langue.' }, ...history], stream: true }),
        signal: abort.signal,
      });
    } catch {
      throw httpError(502, 'Ollama ne répond pas — est-il lancé sur le PC ?');
    }
    if (!upstream.ok) throw httpError(502, `Ollama : ${(await upstream.text()).slice(0, 200)}`);

    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    res.write(JSON.stringify({ conversation_id: conv.id }) + '\n');
    let full = '', buf = '';
    const decoder = new TextDecoder();
    try {
      for await (const chunk of upstream.body) {
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const j = JSON.parse(line);
          if (j.error) { res.write(JSON.stringify({ error: j.error }) + '\n'); continue; }
          if (j.message?.thinking) res.write(JSON.stringify({ think: j.message.thinking }) + '\n'); // réflexion (non enregistrée)
          if (j.message?.content) { full += j.message.content; res.write(JSON.stringify({ delta: j.message.content }) + '\n'); }
        }
      }
    } catch (e) {
      if (!abort.signal.aborted) res.write(JSON.stringify({ error: 'Flux interrompu' }) + '\n');
    }
    if (full.trim()) {
      db.prepare('INSERT INTO ai_messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(conv.id, 'assistant', full, Date.now());
      db.prepare('UPDATE ai_conversations SET updated_at = ?, model = ? WHERE id = ?').run(Date.now(), model, conv.id);
    }
    if (!res.writableEnded) res.end(JSON.stringify({ done: true, conversation_id: conv.id }) + '\n');
  });
};
