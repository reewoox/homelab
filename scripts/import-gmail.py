"""Récupère toutes les photos / vidéos / audios en pièce jointe dans Gmail et les copie dans le Drive perso.
Lecture seule : les mails ne sont ni modifiés ni marqués comme lus (BODY.PEEK). Relançable (reprend où il en était).
Usage : python import-gmail.py <adresse> <fichier_mot_de_passe> <dossier_drive_utilisateur>
"""
import csv, email, hashlib, imaplib, json, os, re, sys, time
from email.header import decode_header, make_header
from email.utils import parseaddr, parsedate_to_datetime

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')
ADDR, PWFILE, DEST = sys.argv[1], sys.argv[2], sys.argv[3]
IMG = set('jpg jpeg png heic heif webp gif bmp tif tiff dng avif'.split())
VID = set('mp4 mov mkv avi wmv m4v webm 3gp mts flv mpg mpeg'.split())
AUD = set('mp3 wav m4a aac flac ogg opus wma aiff amr'.split())
EXTS = IMG | VID | AUD
MOIS = ['01 - Janvier', '02 - Février', '03 - Mars', '04 - Avril', '05 - Mai', '06 - Juin', '07 - Juillet',
        '08 - Août', '09 - Septembre', '10 - Octobre', '11 - Novembre', '12 - Décembre']
MIME_EXT = {'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/heic': 'heic', 'image/webp': 'webp',
            'video/mp4': 'mp4', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav',
            'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/amr': 'amr', 'video/3gpp': '3gp'}
SMALL_INLINE = 20_000  # images intégrées < 20 Ko = logos / signatures / pixels de suivi → ignorées

INDEX = os.path.join(DEST, '.homelab-media-index.json')
STATE = os.path.join(DEST, '.homelab-mail-state.json')
CSV = os.path.join(DEST, 'Inventaire des médias (Mails).csv')


def dec(s):
    try:
        return str(make_header(decode_header(s or '')))
    except Exception:
        return s or ''


def clean(name, maxlen=80):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', name).strip(' .')
    return (name or 'sans nom')[:maxlen].strip(' .') or 'sans nom'


def load(path, default):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return default


def main():
    seen = load(INDEX, {})            # hash -> chemin relatif (partagé avec organize-media.js)
    state = load(STATE, {'done': []})
    done = set(state['done'])
    # « - » : mot de passe lu sur l'entrée standard (utilisé par la page Gmail du homelab, jamais écrit sur disque)
    pw = (sys.stdin.readline() if PWFILE == '-' else open(PWFILE, encoding='utf-8').read()).strip().replace(' ', '')

    M = imaplib.IMAP4_SSL('imap.gmail.com')
    M.login(ADDR, pw)
    # Dossier « Tous les messages » (nom localisé) via l'attribut \All
    typ, boxes = M.list()
    allbox = '[Gmail]/All Mail'
    for b in boxes:
        line = b.decode('utf-8', 'replace')
        if '\\All' in line:
            m = re.search(r'"([^"]+)"\s*$', line) or re.search(r'(\S+)\s*$', line)
            allbox = m.group(1)
            break
    typ, _ = M.select(f'"{allbox}"', readonly=True)
    if typ != 'OK':
        raise SystemExit(f'Impossible d’ouvrir le dossier « {allbox} »')
    print(f'Dossier : {allbox}', flush=True)
    query = 'has:attachment (' + ' OR '.join(f'filename:{e}' for e in sorted(EXTS)) + ')'
    typ, data = M.uid('SEARCH', 'X-GM-RAW', f'"{query}"')
    uids = data[0].split()
    todo = [u for u in uids if u.decode() not in done]
    print(f'{len(uids)} mails avec médias en pièce jointe, {len(todo)} à traiter', flush=True)
    progress = lambda i, final=False: print('@@' + json.dumps({'done': i, 'total': len(todo), 'all': len(uids), 'final': final, **stats}), flush=True)

    new_file = not os.path.exists(CSV)
    out = open(CSV, 'a', newline='', encoding='utf-8-sig')
    w = csv.writer(out, delimiter=';')
    if new_file:
        w.writerow(['Date', 'Expéditeur', 'Objet', 'Fichier', 'Emplacement dans le Drive', 'Taille (octets)', 'Statut'])

    stats = {'saved': 0, 'dup': 0, 'small': 0, 'bytes': 0, 'err': 0}
    progress(0)
    for i, uid in enumerate(todo, 1):
        try:
            typ, msgdata = M.uid('FETCH', uid, '(BODY.PEEK[])')
            raw = next((p[1] for p in msgdata if isinstance(p, tuple)), None)
            if not raw:
                continue
            msg = email.message_from_bytes(raw)
            try:
                dt = parsedate_to_datetime(msg['Date'])
            except Exception:
                dt = None
            ts = dt.timestamp() if dt else time.time()
            lt = time.localtime(ts)
            name, addr = parseaddr(dec(msg['From']))
            sender = clean(name or addr.split('@')[0] or 'Inconnu', 50)
            subject = dec(msg['Subject'])
            for part in msg.walk():
                if part.is_multipart():
                    continue
                fname = dec(part.get_filename() or '')
                ctype = part.get_content_type()
                ext = (os.path.splitext(fname)[1][1:] or MIME_EXT.get(ctype, '')).lower()
                if ext not in EXTS:
                    continue
                payload = part.get_payload(decode=True) or b''
                if not payload:
                    continue
                inline = (part.get('Content-Disposition') or '').lower().startswith('inline') or not part.get_filename()
                if ext in IMG and inline and len(payload) < SMALL_INLINE:
                    stats['small'] += 1
                    continue
                h = hashlib.sha256(payload).hexdigest()
                if not fname:
                    fname = f'piece-jointe-{time.strftime("%Y%m%d", lt)}.{ext}'
                if h in seen:
                    stats['dup'] += 1
                    w.writerow([time.strftime('%Y-%m-%d', lt), f'{name} <{addr}>', subject, fname, seen[h], len(payload), 'doublon'])
                    continue
                kind = 'Photos' if ext in IMG else 'Vidéos' if ext in VID else 'Audio'
                rel_dir = os.path.join('Mails', kind, str(lt.tm_year), MOIS[lt.tm_mon - 1], sender)
                os.makedirs(os.path.join(DEST, rel_dir), exist_ok=True)
                base, e = os.path.splitext(clean(fname, 120))
                target = os.path.join(DEST, rel_dir, base + e)
                k = 1
                while os.path.exists(target):
                    target = os.path.join(DEST, rel_dir, f'{base} ({k}){e}')
                    k += 1
                with open(target, 'xb') as f:
                    f.write(payload)
                os.utime(target, (ts, ts))
                rel = os.path.relpath(target, DEST)
                seen[h] = rel
                stats['saved'] += 1
                stats['bytes'] += len(payload)
                w.writerow([time.strftime('%Y-%m-%d', lt), f'{name} <{addr}>', subject, fname, rel, len(payload), 'copié'])
            done.add(uid.decode())
        except Exception as ex:
            stats['err'] += 1
            print(f'  ⚠️ mail {uid.decode()} : {ex}', flush=True)
        if i % 25 == 0 or i == len(todo):
            out.flush()
            with open(INDEX, 'w', encoding='utf-8') as f:
                json.dump(seen, f)
            with open(STATE, 'w', encoding='utf-8') as f:
                json.dump({'done': sorted(done)}, f)
        if i % 5 == 0 or i == len(todo):
            progress(i)
    out.close()
    M.logout()
    progress(len(todo), True)
    print(f'\nTerminé : {stats["saved"]} fichiers copiés ({stats["bytes"] / 1e9:.2f} Go) · doublons : {stats["dup"]} · '
          f'petites images intégrées ignorées (logos/signatures) : {stats["small"]} · erreurs : {stats["err"]}')


if __name__ == '__main__':
    try:
        main()
    except imaplib.IMAP4.error as e:
        msg = str(e)
        if 'AUTHENTICATIONFAILED' in msg or 'Invalid credentials' in msg or 'Application-specific' in msg:
            print('ÉCHEC DE CONNEXION : mot de passe d’application refusé (vérifie-le, ou que l’IMAP est activé).')
        else:
            print('Erreur IMAP :', msg)
        sys.exit(2)
