// Récupère, répertorie, classe et COPIE toutes les photos / vidéos / audios du PC dans le Drive perso.
// Les originaux ne sont jamais modifiés. Doublons (même contenu) ignorés. Relançable sans risque.
// Usage : node organize-media.js <utilisateur> [--dry-run]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const USER = process.argv[2] || 'admin';
const DRY = process.argv.includes('--dry-run');
const HOME = os.homedir();
const SERVER = path.join(__dirname, '..', 'server');

// Dossier du Drive (réglage du homelab)
let driveRoot = path.join(HOME, 'HomelabDrive');
try {
  const db = new DatabaseSync(path.join(SERVER, 'data', 'homelab.db'), { readOnly: true });
  driveRoot = db.prepare("SELECT value FROM settings WHERE key = 'driveRoot'").get()?.value || driveRoot;
} catch {}
const DEST = path.join(driveRoot, 'Utilisateurs', USER);

const IMG = new Set('jpg jpeg png heic heif webp gif bmp tif tiff raw cr2 nef arw dng avif'.split(' '));
const VID = new Set('mp4 mov mkv avi wmv m4v webm 3gp mts m2ts flv mpg mpeg'.split(' '));
const AUD = new Set('mp3 wav m4a aac flac ogg opus wma aiff amr'.split(' '));
const SKIP = /^(AppData|\.cache|node_modules|\.git|\.venv|venv|site-packages|\.android|\.docker|\.ollama|\.VirtualBox|\.local|\.gemini|\.claude|\.t3|\.tabdesk|\.thumbnails|HomelabDrive|homelab|tools|\$Recycle\.Bin|System Volume Information|Recovery|Program Files.*|Windows|ProgramData|__pycache__|\.next|BlueStacks.*)$/i;
const MOIS = ['01 - Janvier', '02 - Février', '03 - Mars', '04 - Avril', '05 - Mai', '06 - Juin', '07 - Juillet', '08 - Août', '09 - Septembre', '10 - Octobre', '11 - Novembre', '12 - Décembre'];
const ROOTS = [HOME, 'D:\\'].filter((r) => fs.existsSync(r));

// Dossiers « projets » : on garde leur arborescence dans « Projets & ressources »
const PROJECT_ROOTS = [/^what-if-[^\\]+/i, /^sketch/i, /^dramabox-tts/i, /^voix/i, /^Elyndra/i, /^ComfyUI/i, /^dashboard/i];
function projectOf(file) {
  if (/^[A-Z]:\\$/i.test(path.parse(file).root) && !file.startsWith(HOME)) {
    const parts = path.relative(path.parse(file).root, file).split(path.sep);
    return { name: `${path.parse(file).root[0]}~ ${parts[0]}`, rel: parts.slice(1).join(path.sep) };
  }
  const rel = path.relative(HOME, file);
  const parts = rel.split(path.sep);
  if (PROJECT_ROOTS.some((re) => re.test(parts[0])) && parts.length > 1) return { name: parts[0], rel: parts.slice(1).join(path.sep) };
  if (parts[0] === 'Downloads' && parts.length > 2) return { name: parts[1], rel: parts.slice(2).join(path.sep) }; // packs téléchargés (dossiers clients…)
  return null;
}
// Créations finales (vidéos publiées / rendus)
function creationOf(file, kind) {
  const n = file.toLowerCase();
  if (kind !== 'video') return null;
  if (/what[ -]?if|et si/.test(n)) return 'What If';
  if (/sketch/.test(n)) return 'Sketch';
  if (/stickman/.test(n)) return 'Stickman';
  if (/comfyui\\output/.test(n)) return 'ComfyUI';
  if (/videos\\(shorts|bande-annonce)/.test(n)) return 'What If';
  if (/who_used/.test(n)) return 'Divers';
  return null;
}

// ---------- Date de prise de vue (EXIF) ----------
function exifDate(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (buf.readUInt16BE(0) !== 0xffd8) return null;
    let off = 2;
    while (off + 4 < n) {
      if (buf[off] !== 0xff) return null;
      const marker = buf[off + 1], len = buf.readUInt16BE(off + 2);
      if (marker === 0xe1 && buf.toString('ascii', off + 4, off + 8) === 'Exif') return parseTiff(buf, off + 10);
      if (marker === 0xda) return null;
      off += 2 + len;
    }
  } catch {} finally { if (fd) fs.closeSync(fd); }
  return null;
}
function parseTiff(b, t) {
  const le = b.toString('ascii', t, t + 2) === 'II';
  const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const readIfd = (o) => {
    const out = {};
    const count = u16(t + o);
    for (let i = 0; i < count; i++) {
      const e = t + o + 2 + i * 12;
      out[u16(e)] = { type: u16(e + 2), count: u32(e + 4), val: u32(e + 8) };
    }
    return out;
  };
  const str = (en) => b.toString('ascii', t + en.val, t + en.val + 19);
  const ifd0 = readIfd(u32(t + 4));
  let d = null;
  if (ifd0[0x8769]) { const ex = readIfd(ifd0[0x8769].val); if (ex[0x9003]) d = str(ex[0x9003]); }
  if (!d && ifd0[0x0132]) d = str(ifd0[0x0132]);
  const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(d || '');
  if (!m || m[1] < '1990') return null;
  return new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

// ---------- Inventaire ----------
const files = [];
function walk(dir) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    let isDir = e.isDirectory();
    if (!isDir && !e.isFile()) { try { isDir = fs.statSync(p).isDirectory(); } catch { continue; } } // dossiers OneDrive (points de réanalyse)
    if (isDir) { if (!SKIP.test(e.name)) walk(p); continue; }
    const ext = path.extname(e.name).slice(1).toLowerCase();
    const kind = IMG.has(ext) ? 'image' : VID.has(ext) ? 'video' : AUD.has(ext) ? 'audio' : null;
    if (!kind) continue;
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (!st.size) continue;
    files.push({ src: p, kind, ext, size: st.size, mtime: st.mtime });
  }
}
for (const r of ROOTS) walk(r);

const hashOf = (p) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(p).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});
const TYPE_DIR = { image: 'Photos', video: 'Vidéos', audio: 'Audio' };

function destinationOf(f) {
  const base = path.basename(f.src);
  const creation = creationOf(f.src, f.kind);
  if (creation) return path.join('Créations', creation, base);
  const proj = projectOf(f.src);
  if (proj) return path.join('Projets & ressources', proj.name, proj.rel);
  const date = (f.kind === 'image' && exifDate(f.src)) || f.mtime;
  f.date = date;
  const sub = /\\Screenshots\\|capture d.?écran|screenshot/i.test(f.src) ? "Captures d'écran"
    : /\\Videos\\Captures\\/i.test(f.src) ? "Captures d'écran" : '';
  return path.join(TYPE_DIR[f.kind], sub, String(date.getFullYear()), MOIS[date.getMonth()], base);
}

(async () => {
  console.log(`${files.length} fichiers médias trouvés → ${DEST}${DRY ? '  (SIMULATION)' : ''}`);
  // Index des fichiers déjà présents dans le Drive (pour la reprise / les doublons)
  const seen = new Map();
  const indexFile = path.join(DEST, '.homelab-media-index.json');
  if (fs.existsSync(indexFile)) for (const [h, d] of Object.entries(JSON.parse(fs.readFileSync(indexFile, 'utf8')))) seen.set(h, d);

  const rows = [];
  const stats = { copied: 0, dup: 0, err: 0, bytes: 0, byTop: {} };
  let i = 0;
  for (const f of files) {
    i++;
    if (i % 500 === 0) process.stdout.write(`  … ${i}/${files.length}\n`);
    try {
      const hash = await hashOf(f.src);
      if (seen.has(hash)) { stats.dup++; rows.push([f.src, seen.get(hash), f.kind, f.size, 'doublon']); continue; }
      let rel = destinationOf(f);
      let target = path.join(DEST, rel);
      // Nom déjà pris par un autre contenu → « nom (1).ext »
      const ext = path.extname(target), stem = target.slice(0, -ext.length);
      for (let k = 1; fs.existsSync(target); k++) target = `${stem} (${k})${ext}`;
      rel = path.relative(DEST, target);
      if (!DRY) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(f.src, target, fs.constants.COPYFILE_EXCL);
        fs.utimesSync(target, f.mtime, f.date && f.date < f.mtime ? f.date : f.mtime);
      }
      seen.set(hash, rel);
      stats.copied++; stats.bytes += f.size;
      const top = rel.split(path.sep).slice(0, 2).join(' / ');
      stats.byTop[top] = (stats.byTop[top] || 0) + 1;
      rows.push([f.src, rel, f.kind, f.size, (f.date || f.mtime).toISOString().slice(0, 10)]);
    } catch (e) {
      stats.err++; rows.push([f.src, '', f.kind, f.size, `ERREUR ${e.code || e.message}`]);
    }
  }
  if (!DRY) {
    fs.mkdirSync(DEST, { recursive: true });
    fs.writeFileSync(indexFile, JSON.stringify(Object.fromEntries(seen)));
    const csv = '\ufeffOrigine;Emplacement dans le Drive;Type;Taille (octets);Date / statut\n' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\n');
    fs.writeFileSync(path.join(DEST, 'Inventaire des médias (PC).csv'), csv);
  }
  console.log('\nRépartition :');
  for (const [k, v] of Object.entries(stats.byTop).sort()) console.log(`  ${String(v).padStart(6)}  ${k}`);
  console.log(`\nCopiés : ${stats.copied} (${(stats.bytes / 1e9).toFixed(2)} Go) · doublons ignorés : ${stats.dup} · erreurs : ${stats.err}`);
  if (stats.err) for (const r of rows.filter((x) => String(x[4]).startsWith('ERREUR')).slice(0, 15)) console.log('  ⚠️', r[0], r[4]);
})();
