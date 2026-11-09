// Presse-papiers partagé : copie un texte/lien sur un appareil, récupère-le sur un autre.
'use strict';
module.exports = ({ db, route, httpError, readBody }) => {
  db.exec(`CREATE TABLE IF NOT EXISTS clips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    device TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`);

  route('GET', '/api/clips', { auth: 'user' }, (req) =>
    db.prepare('SELECT id, content, device, pinned, created_at FROM clips WHERE user_id = ? ORDER BY pinned DESC, created_at DESC LIMIT 100').all(req.user.id));

  route('POST', '/api/clips', { auth: 'user' }, async (req) => {
    const { content, device } = await readBody(req);
    const text = String(content ?? '').slice(0, 50000);
    if (!text.trim()) throw httpError(400, 'Rien à enregistrer');
    const id = db.prepare('INSERT INTO clips (user_id, content, device, created_at) VALUES (?, ?, ?, ?)').run(req.user.id, text, String(device || '').slice(0, 60), Date.now()).lastInsertRowid;
    // On garde les 200 derniers éléments non épinglés
    db.prepare(`DELETE FROM clips WHERE user_id = ? AND pinned = 0 AND id NOT IN (SELECT id FROM clips WHERE user_id = ? AND pinned = 0 ORDER BY created_at DESC LIMIT 200)`).run(req.user.id, req.user.id);
    return { id: Number(id) };
  });

  route('PUT', '/api/clips/:id', { auth: 'user' }, async (req, p) => {
    const { pinned } = await readBody(req);
    db.prepare('UPDATE clips SET pinned = ? WHERE id = ? AND user_id = ?').run(pinned ? 1 : 0, Number(p.id), req.user.id);
    return { ok: true };
  });

  route('DELETE', '/api/clips/:id', { auth: 'user' }, (req, p) => {
    if (p.id === 'all') db.prepare('DELETE FROM clips WHERE user_id = ? AND pinned = 0').run(req.user.id);
    else db.prepare('DELETE FROM clips WHERE id = ? AND user_id = ?').run(Number(p.id), req.user.id);
    return { ok: true };
  });
};
