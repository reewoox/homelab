// L'île du homelab : la scène 3D en direct en haut de l'accueil (Three.js chargé depuis un CDN, rien à installer).
// Chaque appli est un bâtiment de son quartier (= sa catégorie), avec une épingle verte (en ligne), rouge (en panne)
// ou grise (non surveillée). Le PC est au centre, ses anneaux montrent le processeur et la mémoire, et les appareils
// Tailscale volent autour en drones (ou attendent sur leur piste quand ils sont hors ligne).
// Le ciel suit l'heure réelle (position du soleil) et la météo de la ville des réglages.
// Données : window.HL (app.js) + événements hl:board, hl:status, hl:system, hl:devices, hl:weather.

const HL = window.HL;
const hero = document.getElementById('hero');
const canvas = document.getElementById('island');
const tipEl = document.getElementById('island-tip');
const labelsEl = document.getElementById('island-labels');
const hintEl = document.getElementById('hero-hint');

const THREE_URLS = [
  'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.min.js',
  'https://unpkg.com/three@0.169.0/build/three.module.min.js',
];
const REDUCE = matchMedia('(prefers-reduced-motion: reduce)');
const COARSE = matchMedia('(hover: none), (pointer: coarse)');
const ST_COLOR = { up: '#34d399', down: '#fb7185', idle: '#94a3b8', wait: '#e2e8f0' };
const ST_TEXT = { up: 'En ligne', down: 'Hors ligne', idle: 'Non surveillé', wait: 'Vérification…' };
const R = 10; // rayon de l'île
const ROWS = [6.2, 4.6, 7.8]; // rangées de bâtiments (remplies dans cet ordre)
const RINGS = [5.4, 7.0]; // routes circulaires entre les rangées
const SPACING = 1.25;

let T = null; // module three
let W = null; // l'état du monde

// ---------- Petits outils ----------
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hash3 = (x, y, z) => { const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return s - Math.floor(s); };
const rimK = (a) => 1 + 0.035 * Math.sin(3 * a + 0.7) + 0.025 * Math.sin(7 * a + 1.3) + 0.015 * Math.sin(11 * a + 2.1);
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const mixc = (a, b, t) => a.map((v, i) => lerp(v, b[i], t));
const hexc = (c) => '#' + c.map((v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0')).join('');
const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

// ---------- Soleil (formules de SunCalc) ----------
function sunPosition(date, lat, lon) {
  const rad = Math.PI / 180;
  const d = date.valueOf() / 864e5 - 0.5 + 2440588 - 2451545;
  const M = rad * (357.5291 + 0.98560028 * d);
  const L = M + rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + rad * 102.9372 + Math.PI;
  const e = rad * 23.4397;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.sin(L) * Math.cos(e), Math.cos(L));
  const H = rad * (280.16 + 360.9856235 * d) + rad * lon - ra;
  const phi = rad * lat;
  return {
    altitude: Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)),
    azimuth: Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)), // depuis le sud, vers l'ouest
  };
}
// Monde : +z = sud, +x = est, y = haut
const dirFrom = (alt, az) => [-Math.sin(az) * Math.cos(alt), Math.sin(alt), Math.cos(az) * Math.cos(alt)];

// ---------- Ciel : couleurs selon la hauteur du soleil, puis la météo ----------
// [hauteur du soleil en degrés, haut du ciel, bande de l'horizon, bas]
const SKY = [
  [-18, '#02040b', '#0a1230', '#03050f'],
  [-9, '#060c2c', '#1c2660', '#070b20'],
  [-3, '#141f62', '#5d4596', '#1a1440'],
  [1, '#283d90', '#ff8c69', '#3a2752'],
  [6, '#3765c4', '#ffc49a', '#5568a0'],
  [16, '#3681e2', '#b3daff', '#7a9ed6'],
  [40, '#2c78ee', '#cde9ff', '#93b8e6'],
];
function weatherNow() {
  const c = HL.state.weather?.current;
  const code = c?.weather_code ?? 1;
  return {
    code,
    cover: clamp((c?.cloud_cover ?? (code >= 3 ? 90 : code * 25)) / 100, 0, 1),
    wind: c?.wind_speed_10m ?? 8,
    rain: (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95,
    snow: (code >= 71 && code <= 77) || code === 85 || code === 86,
    storm: code >= 95,
    fog: code === 45 || code === 48,
  };
}
function skyState(date = new Date()) {
  const s = HL.state.board?.settings || {};
  const lat = Number(s.weatherLat) || 48.8566, lon = Number(s.weatherLon) || 2.3522;
  const sp = sunPosition(date, lat, lon);
  const alt = (sp.altitude * 180) / Math.PI;
  const i = SKY.findIndex((k) => k[0] > alt);
  let top, mid, bot;
  if (i <= 0) [top, mid, bot] = SKY[i === 0 ? 0 : SKY.length - 1].slice(1).map(rgb);
  else {
    const a = SKY[i - 1], b = SKY[i], t = (alt - a[0]) / (b[0] - a[0]);
    [top, mid, bot] = [1, 2, 3].map((j) => mixc(rgb(a[j]), rgb(b[j]), t));
  }
  const w = weatherNow();
  const night = 1 - smooth(-7, 2, alt);
  const gray = clamp(w.cover * 0.7 + (w.rain || w.snow ? 0.3 : 0) + (w.fog ? 0.4 : 0), 0, 1) * (1 - night * 0.55);
  const desat = (c, k) => { const l = c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11; return mixc(c, [l * 0.94, l * 0.97, l * 1.06], k); };
  top = desat(top, gray * 0.55); mid = desat(mid, gray * 0.5); bot = desat(bot, gray * 0.6);
  if (w.rain) { top = mixc(top, [0.18, 0.21, 0.28], 0.3 * (1 - night)); mid = mixc(mid, [0.45, 0.5, 0.58], 0.25 * (1 - night)); }
  const day = smooth(-4, 6, alt);
  const phase = alt > 6 ? 'jour' : alt > -6 ? (sp.azimuth < 0 ? 'aube' : 'crepuscule') : 'nuit';
  return {
    alt, az: sp.azimuth, phase, night, day, gray, w, top, mid, bot,
    sunDir: dirFrom(Math.max(sp.altitude, (4 * Math.PI) / 180), sp.azimuth),
    moonDir: dirFrom((38 * Math.PI) / 180, sp.azimuth + Math.PI),
    sunCol: mixc(rgb('#ff9a62'), rgb('#fff4e0'), smooth(2, 25, alt)),
    sunI: day * lerp(1.8, 3.1, smooth(5, 35, alt)) * (1 - gray * 0.4),
    moonI: night * 0.8 * (1 - gray * 0.45),
    hemiI: lerp(1.5, 0.62, night) + gray * 0.6 * (1 - night * 0.6),
  };
}
// Le ciel en CSS (avant la 3D, ou si la 3D ne peut pas se charger)
function paintCssSky() {
  const k = skyState();
  hero.style.setProperty('--sky-top', hexc(k.top));
  hero.style.setProperty('--sky-mid', hexc(k.mid));
  hero.style.setProperty('--sky-bot', hexc(k.bot));
  hero.dataset.phase = k.phase;
  return k;
}

// ---------- Démarrage ----------
let starting = false;
async function loadThree() {
  for (const u of THREE_URLS) { try { return await import(u); } catch {} }
  throw new Error('three introuvable');
}
function webglOk() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; }
}
function fallback() {
  hero.classList.add('no3d');
  hero.classList.remove('loading3d');
}
async function start() {
  if (starting || W || !HL.state.board) return;
  starting = true;
  paintCssSky();
  if (!webglOk()) return fallback();
  hero.classList.add('loading3d');
  try { T = await loadThree(); } catch { return fallback(); }
  try { init(); } catch (e) { console.error('Île 3D :', e); W = null; return fallback(); }
  hero.classList.remove('loading3d');
}

// ---------- Matériaux et formes ----------
const MAT = new Map();
function lam(color, extra = {}) {
  const k = `l${color}${JSON.stringify(extra)}`;
  if (!MAT.has(k)) MAT.set(k, new T.MeshLambertMaterial({ color, flatShading: true, ...extra }));
  return MAT.get(k);
}
function std(color, metalness, roughness, extra = {}) {
  const k = `s${color}${metalness}${roughness}${JSON.stringify(extra)}`;
  if (!MAT.has(k)) MAT.set(k, new T.MeshStandardMaterial({ color, metalness, roughness, flatShading: true, ...extra }));
  return MAT.get(k);
}
const glow = (color, i = 1.4) => lam('#101420', { emissive: color, emissiveIntensity: i });
const GEO = new Map();
const geo = (k, make) => { if (!GEO.has(k)) GEO.set(k, make()); return GEO.get(k); };
const box = (w, h, d) => geo(`b${w},${h},${d}`, () => new T.BoxGeometry(w, h, d));
const cyl = (rt, rb, h, s = 8) => geo(`c${rt},${rb},${h},${s}`, () => new T.CylinderGeometry(rt, rb, h, s));
const cone = (r, h, s = 8) => geo(`k${r},${h},${s}`, () => new T.ConeGeometry(r, h, s));
const hemi = (r, s = 12) => geo(`h${r},${s}`, () => new T.SphereGeometry(r, s, Math.max(3, s >> 1), 0, Math.PI * 2, 0, Math.PI / 2));
const ball = (r, s = 8) => geo(`s${r},${s}`, () => new T.SphereGeometry(r, s, Math.max(3, s >> 1)));
const torus = (r, t, s = 32) => geo(`t${r},${t},${s}`, () => new T.TorusGeometry(r, t, 6, s));
function prism(w, h, d) { // toit à deux pans : faîte le long de x, base à y = 0
  return geo(`p${w},${h},${d}`, () => {
    const s = new T.Shape();
    s.moveTo(-d / 2, 0); s.lineTo(d / 2, 0); s.lineTo(0, h); s.closePath();
    const g = new T.ExtrudeGeometry(s, { depth: w, bevelEnabled: false });
    g.rotateY(Math.PI / 2); g.translate(-w / 2, 0, 0);
    return g;
  });
}
function arch(r, len) { // demi-cylindre couché le long de x
  return geo(`a${r},${len}`, () => { const g = new T.CylinderGeometry(r, r, len, 12, 1, false, 0, Math.PI); g.rotateZ(Math.PI / 2); return g; });
}
function part(parent, g, m, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const mesh = new T.Mesh(g, m);
  mesh.position.set(x, y, z); mesh.rotation.set(rx, ry, rz);
  parent.add(mesh);
  return mesh;
}

// Fusionne des maillages statiques par matériau (une poignée d'appels de dessin pour toute la ville)
function mergeByMaterial(meshes) {
  const groups = new Map();
  for (const m of meshes) {
    m.updateWorldMatrix(true, false);
    const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    g.applyMatrix4(m.matrixWorld);
    if (!groups.has(m.material)) groups.set(m.material, []);
    groups.get(m.material).push(g);
  }
  const out = [];
  for (const [mat, list] of groups) {
    let n = 0;
    for (const g of list) n += g.attributes.position.count;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
    const col = mat.vertexColors ? new Float32Array(n * 3) : null;
    let o = 0;
    for (const g of list) {
      const c = g.attributes.position.count;
      pos.set(g.attributes.position.array, o * 3);
      if (g.attributes.normal) nor.set(g.attributes.normal.array, o * 3);
      if (col) { if (g.attributes.color) col.set(g.attributes.color.array, o * 3); else col.fill(1, o * 3, (o + c) * 3); }
      o += c;
      g.dispose();
    }
    const geom = new T.BufferGeometry();
    geom.setAttribute('position', new T.BufferAttribute(pos, 3));
    geom.setAttribute('normal', new T.BufferAttribute(nor, 3));
    if (col) geom.setAttribute('color', new T.BufferAttribute(col, 3));
    geom.computeBoundingSphere();
    const mesh = new T.Mesh(geom, mat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    out.push(mesh);
  }
  return out;
}
// Couleur par facette (géométrie non indexée)
function paintFaces(g, pick) {
  const p = g.attributes.position, n = p.count;
  const col = new Float32Array(n * 3);
  const a = new T.Vector3(), b = new T.Vector3(), c = new T.Vector3(), ab = new T.Vector3(), ac = new T.Vector3();
  const tmp = new T.Color();
  for (let i = 0; i < n; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    const normal = ab.subVectors(b, a).cross(ac.subVectors(c, a)).normalize();
    const cx = (a.x + b.x + c.x) / 3, cy = (a.y + b.y + c.y) / 3, cz = (a.z + b.z + c.z) / 3;
    tmp.set(pick(cx, cy, cz, normal, i / 3));
    for (let k = 0; k < 3; k++) tmp.toArray(col, (i + k) * 3);
  }
  g.setAttribute('color', new T.BufferAttribute(col, 3));
  return g;
}

// Texture de halo (dégradé radial), partagée
let glowTex = null;
function glowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  glowTex = new T.CanvasTexture(c);
  glowTex.colorSpace = T.SRGBColorSpace;
  return glowTex;
}
const additive = (color, opacity = 1) => new T.SpriteMaterial({ map: glowTexture(), color, transparent: true, opacity, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false, fog: false });

// ---------- La scène ----------
function init() {
  const small = Math.min(hero.clientWidth || innerWidth, innerWidth) < 700;
  const renderer = new T.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, small ? 2 : 1.5));
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.toneMapping = T.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false; // l'île ne bouge pas : ombres recalculées seulement quand il faut

  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(30, 2, 0.5, 400);
  scene.fog = new T.Fog('#7a9ed6', 46, 90);

  W = {
    renderer, scene, camera, small,
    clock: 0, last: 0, raf: 0, visible: true, running: false, dirtyShadow: true,
    ray: new T.Raycaster(), ndc: new T.Vector2(), v: new T.Vector3(), v2: new T.Vector3(),
    pickables: [], fans: [], rocks: [], clouds: [], drones: [], pads: [],
    ctl: { theta: 0.55, phi: 0.5, vel: 0, dist: 34, drag: null, idle: 0, lastMoved: 0 },
    hover: null, selected: null, query: '', tileHover: null,
    sys: { cpu: 0, mem: 0, cpuShown: 0, memShown: 0 },
    flash: 0, nextFlash: 4, boardSig: '', devSig: '',
  };

  // Ciel (fond plein écran), étoiles, lumières
  W.backdrop = makeBackdrop(); scene.add(W.backdrop);
  W.stars = makeStars(); scene.add(W.stars);
  W.hemi = new T.HemisphereLight('#bcd4ff', '#5b4a6e', 1.1);
  W.sun = new T.DirectionalLight('#ffffff', 2.6);
  W.sun.castShadow = true;
  const sm = small ? 1024 : 2048;
  W.sun.shadow.mapSize.set(sm, sm);
  Object.assign(W.sun.shadow.camera, { left: -13, right: 13, top: 13, bottom: -13, near: 1, far: 100 });
  W.sun.shadow.camera.updateProjectionMatrix();
  W.sun.shadow.bias = -0.0004; W.sun.shadow.normalBias = 0.035;
  scene.add(W.hemi, W.sun, W.sun.target);

  W.world = new T.Group(); scene.add(W.world);
  buildIsland();
  buildPC();
  makeClouds();
  makeWeatherFx();
  rebuildCity();
  updateDrones();
  updateSky();
  updateSystem();
  setupInput();
  resize();

  new ResizeObserver(() => resize()).observe(hero);
  new IntersectionObserver((e) => { W.visible = e[0].isIntersecting; schedule(); }, { threshold: 0.01 }).observe(hero);
  document.addEventListener('visibilitychange', schedule);
  REDUCE.addEventListener?.('change', schedule);
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); stop(); fallback(); });
  setInterval(() => { updateSky(); requestRender(); }, 60e3);

  W.renderer.shadowMap.needsUpdate = true;
  W.renderer.render(scene, camera);
  hero.classList.add('ready3d');
  schedule();
}

// Fond : dégradé vertical + soleil et lune dessinés à l'écran selon leur direction réelle
function makeBackdrop() {
  const u = {
    top: { value: new T.Color() }, mid: { value: new T.Color() }, bot: { value: new T.Color() },
    sunPos: { value: new T.Vector2(0.5, 0.8) }, sunCol: { value: new T.Color('#fff2d6') }, sunAmt: { value: 0 },
    moonPos: { value: new T.Vector2(0.3, 0.8) }, moonAmt: { value: 0 }, aspect: { value: 2 }, flash: { value: 0 },
  };
  const m = new T.ShaderMaterial({
    uniforms: u, depthTest: false, depthWrite: false,
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `uniform vec3 top, mid, bot, sunCol; uniform vec2 sunPos, moonPos; uniform float sunAmt, moonAmt, aspect, flash;
      varying vec2 vUv;
      void main() {
        float y = vUv.y;
        vec3 c = mix(bot, mid, smoothstep(0.0, 0.42, y));
        c = mix(c, top, smoothstep(0.36, 1.0, y));
        vec2 d = (vUv - sunPos) * vec2(aspect, 1.0); float r = length(d);
        c += sunCol * ((1.0 - smoothstep(0.04, 0.05, r)) * 1.3 + exp(-r * 7.0) * 0.5 + exp(-r * 2.4) * 0.16) * sunAmt;
        vec2 m = (vUv - moonPos) * vec2(aspect, 1.0); float rm = length(m);
        float disc = (1.0 - smoothstep(0.025, 0.03, rm)) * (1.0 - (1.0 - smoothstep(0.024, 0.03, length(m - vec2(0.012, 0.006)))) * 0.85);
        c += vec3(0.86, 0.9, 1.0) * (disc * 0.95 + exp(-rm * 9.0) * 0.14) * moonAmt;
        c += flash * vec3(0.55, 0.6, 0.78);
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new T.Mesh(new T.PlaneGeometry(2, 2), m);
  mesh.frustumCulled = false; mesh.renderOrder = -1000;
  return mesh;
}
function makeStars() {
  const n = 900, pos = new Float32Array(n * 3), r = rng(11);
  for (let i = 0; i < n; i++) {
    const u = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    pos.set([Math.cos(a) * s * 170, u * 170, Math.sin(a) * s * 170], i * 3);
  }
  const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(pos, 3));
  const m = new T.PointsMaterial({ size: 1.7, sizeAttenuation: false, color: '#ffffff', transparent: true, opacity: 0, depthWrite: false, fog: false, map: glowTexture() });
  const p = new T.Points(g, m); p.renderOrder = -900;
  return p;
}

// ---------- L'île : herbe, terre, roche, place centrale, bassin et cascade ----------
const GRASS = ['#86d69a', '#7ccd90', '#93dda5', '#74c588', '#82d395'];
function buildIsland() {
  const g = new T.Group();
  W.island = g; W.world.add(g);
  const rnd = rng(7);

  // Herbe (dessus à y = 0), bord irrégulier
  const grass = new T.CylinderGeometry(R, R * 0.985, 0.42, 80, 1).toNonIndexed();
  jitterRim(grass, 0);
  grass.translate(0, -0.21, 0);
  paintFaces(grass, (x, y, z, n) => (n.y > 0.6 ? GRASS[Math.floor(rnd() * GRASS.length)] : '#5fa56a'));
  const grassMesh = new T.Mesh(grass, lam('#ffffff', { vertexColors: true }));
  grassMesh.receiveShadow = true;
  g.add(grassMesh);

  // Couche de terre
  const dirt = new T.CylinderGeometry(R * 0.985, R * 0.93, 1.05, 80, 2).toNonIndexed();
  jitterRim(dirt, 0.06);
  dirt.translate(0, -0.42 - 0.525, 0);
  paintFaces(dirt, (x, y) => (y > -0.7 ? ['#c58a5b', '#bb8052', '#cf9668'][Math.floor(rnd() * 3)] : ['#a97250', '#9c6849'][Math.floor(rnd() * 2)]));
  const dirtMesh = new T.Mesh(dirt, lam('#ffffff', { vertexColors: true }));
  g.add(dirtMesh);

  // Roche sous l'île (cône pointe en bas, bosselé) + deux lobes
  const rock = [];
  const mk = (r0, h, seg, rows, x, z, yTop) => {
    const c = new T.ConeGeometry(r0, h, seg, rows).toNonIndexed();
    c.rotateX(Math.PI);
    c.translate(0, -h / 2, 0);
    const p = c.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const px = p.getX(i), py = p.getY(i), pz = p.getZ(i);
      const kx = Math.round(px * 1000) / 1000, ky = Math.round(py * 1000) / 1000, kz = Math.round(pz * 1000) / 1000;
      const top = py > -0.01;
      const a = Math.atan2(pz, px);
      const j = top ? rimK(a) * 0.985 : 1 + (hash3(kx, ky, kz) - 0.5) * 0.42;
      p.setXYZ(i, px * j, py + (top ? 0 : (hash3(kz, kx, ky) - 0.5) * 0.5), pz * j);
    }
    c.translate(x, yTop, z);
    rock.push(c);
  };
  mk(R * 0.93, 7.4, 22, 6, 0, 0, -1.47);
  mk(4.2, 4.6, 10, 3, 3.6, -2.2, -1.9);
  mk(3.6, 3.8, 9, 3, -4.1, 1.8, -1.9);
  for (const c of rock) {
    paintFaces(c, (x, y) => {
      const t = clamp((-y - 1.4) / 7, 0, 1);
      const base = mixc(rgb('#8f84b8'), rgb('#3a3460'), t);
      const k = 0.9 + rnd() * 0.2;
      return new T.Color().setRGB(base[0] * k, base[1] * k, base[2] * k, T.SRGBColorSpace);
    });
    g.add(new T.Mesh(c, lam('#ffffff', { vertexColors: true })));
  }

  // Petits rochers qui flottent autour
  for (let i = 0; i < 6; i++) {
    const s = 0.2 + rnd() * 0.38;
    const m = new T.Mesh(new T.DodecahedronGeometry(s, 0), lam(['#7d72a8', '#6a6096', '#8f84b8'][i % 3]));
    const a = (i / 6) * Math.PI * 2 + rnd() * 0.6, r = 9.6 + rnd() * 2.6;
    m.position.set(Math.cos(a) * r, -3 - rnd() * 4.5, Math.sin(a) * r);
    m.userData = { y: m.position.y, ph: rnd() * 6, sp: 0.3 + rnd() * 0.4 };
    W.rocks.push(m); g.add(m);
  }

  // Place centrale (le PC est posé dessus)
  const plaza = new T.CylinderGeometry(2.75, 2.85, 0.24, 40).toNonIndexed();
  paintFaces(plaza, (x, y, z, n) => (n.y > 0.6 ? ((Math.floor(Math.atan2(z, x) / (Math.PI / 10)) + Math.floor(Math.hypot(x, z) / 0.9)) % 2 ? '#d9dcea' : '#cdd1e2') : '#a9afc6'));
  const pm = new T.Mesh(plaza, lam('#ffffff', { vertexColors: true }));
  pm.position.y = 0.12; pm.receiveShadow = true; pm.castShadow = true;
  g.add(pm);
  const ringGlow = new T.Mesh(torus(2.5, 0.035, 96), new T.MeshBasicMaterial({ color: accent(), toneMapped: false }));
  ringGlow.rotation.x = Math.PI / 2; ringGlow.position.y = 0.245;
  W.plazaRing = ringGlow; g.add(ringGlow);

  // Bassin, ruisseau et cascade au bord de l'île ; pistes des drones à l'opposé
  W.pondAngle = -Math.PI / 2 - 0.35;
  W.padAngle = W.pondAngle + Math.PI;
  const a = W.pondAngle, rr = R * rimK(a);
  const water = lam('#55c2f2', { emissive: '#1d6fa3', emissiveIntensity: 0.35 });
  const pond = new T.Mesh(new T.CircleGeometry(0.7, 18), water);
  pond.rotation.x = -Math.PI / 2; pond.position.set(Math.cos(a) * 8.75, 0.02, Math.sin(a) * 8.75);
  g.add(pond);
  const creekLen = rr - 8.75 + 0.1;
  const creek = new T.Mesh(new T.PlaneGeometry(0.34, creekLen), water);
  creek.rotation.set(-Math.PI / 2, 0, -a + Math.PI / 2);
  const cr = 8.75 + creekLen / 2;
  creek.position.set(Math.cos(a) * cr, 0.021, Math.sin(a) * cr);
  g.add(creek);
  W.fall = makeWaterfall();
  W.fall.position.set(Math.cos(a) * (rr + 0.04), -0.05, Math.sin(a) * (rr + 0.04));
  W.fall.rotation.y = Math.atan2(Math.cos(a), Math.sin(a));
  g.add(W.fall);
}
function jitterRim(geom, extra) {
  const p = geom.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i), r = Math.hypot(x, z);
    if (r < 0.01) continue;
    const k = rimK(Math.atan2(z, x)) * (1 - extra * hash3(Math.round(x * 100), 0, Math.round(z * 100)));
    p.setX(i, x * k); p.setZ(i, z * k);
  }
}
function makeWaterfall() {
  const c = document.createElement('canvas'); c.width = 32; c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = 'rgba(140,215,255,0.55)'; x.fillRect(0, 0, 32, 128);
  for (let i = 0; i < 26; i++) {
    x.fillStyle = `rgba(255,255,255,${0.35 + Math.random() * 0.5})`;
    x.fillRect(Math.random() * 30, Math.random() * 128, 1 + Math.random() * 2, 12 + Math.random() * 30);
  }
  const tex = new T.CanvasTexture(c);
  tex.wrapS = tex.wrapT = T.RepeatWrapping; tex.repeat.set(1, 2.2);
  tex.colorSpace = T.SRGBColorSpace;
  const g = new T.PlaneGeometry(0.42, 5.2, 1, 8);
  g.translate(0, -2.6, 0);
  const pc = g.attributes.position, col = new Float32Array(pc.count * 4);
  for (let i = 0; i < pc.count; i++) col.set([1, 1, 1, clamp(1 + pc.getY(i) / 5.2, 0, 1) ** 1.4], i * 4);
  g.setAttribute('color', new T.BufferAttribute(col, 4));
  const m = new T.MeshBasicMaterial({ map: tex, transparent: true, vertexColors: true, depthWrite: false, side: T.DoubleSide, toneMapped: false });
  const mesh = new T.Mesh(g, m);
  mesh.userData.tex = tex;
  return mesh;
}

// ---------- Le PC au centre : le Beelink GTi14 (argenté) sur son dock EX, et ses anneaux CPU/RAM ----------
function roundedSquare(w, d, r) {
  const s = new T.Shape();
  s.moveTo(-w / 2 + r, -d / 2); s.lineTo(w / 2 - r, -d / 2); s.quadraticCurveTo(w / 2, -d / 2, w / 2, -d / 2 + r);
  s.lineTo(w / 2, d / 2 - r); s.quadraticCurveTo(w / 2, d / 2, w / 2 - r, d / 2); s.lineTo(-w / 2 + r, d / 2);
  s.quadraticCurveTo(-w / 2, d / 2, -w / 2, d / 2 - r); s.lineTo(-w / 2, -d / 2 + r); s.quadraticCurveTo(-w / 2, -d / 2, -w / 2 + r, -d / 2);
  return s;
}
function buildPC() {
  const g = new T.Group();
  g.position.y = 0.24;
  g.scale.setScalar(1.15);
  W.pc = g; W.world.add(g);
  W.pcLed = new T.MeshLambertMaterial({ color: '#101420', emissive: accentHex(), emissiveIntensity: 2.2, flatShading: true });
  const vent = glow('#a78bfa', 1.8);
  const tmp = new T.Group();
  // Le dock : socle sombre, liseré lumineux tout autour, fentes d'aération violettes sur les 4 côtés
  part(tmp, box(2.5, 0.4, 2.5), std('#232a42', 0.15, 0.6), 0, 0.2, 0);
  part(tmp, box(2.56, 0.05, 2.56), W.pcLed, 0, 0.3, 0);
  part(tmp, box(2.6, 0.06, 2.6), std('#39425f', 0.2, 0.45), 0, 0.43, 0);
  for (let side = 0; side < 4; side++) {
    for (let i = -2; i <= 2; i++) {
      const m = part(tmp, box(0.08, 0.16, 0.02), vent, i * 0.32, 0.14, 1.26);
      const holder = new T.Group(); holder.rotation.y = (side * Math.PI) / 2; holder.add(m); tmp.add(holder);
    }
  }
  // Le mini PC : boîtier argenté aux coins arrondis, dessus sombre et brillant
  const shape = roundedSquare(1.5, 1.5, 0.26);
  const body = new T.ExtrudeGeometry(shape, { depth: 0.5, bevelEnabled: true, bevelThickness: 0.035, bevelSize: 0.035, bevelSegments: 2, curveSegments: 5 });
  body.rotateX(-Math.PI / 2);
  part(tmp, body, std('#cdd5e6', 0.3, 0.3), 0, 0.46, 0);
  const top = new T.ExtrudeGeometry(shape, { depth: 0.02, bevelEnabled: false, curveSegments: 5 });
  top.rotateX(-Math.PI / 2); top.scale(0.9, 1, 0.9);
  part(tmp, top, std('#dfe5f1', 0.25, 0.35), 0, 0.46 + 0.535, 0);
  part(tmp, cyl(0.5, 0.5, 0.025, 32), std('#1a2030', 0.2, 0.5), 0, 0.46 + 0.56, 0);
  // Liseré lumineux en façade et voyant d'alimentation
  part(tmp, box(1.0, 0.05, 0.02), W.pcLed, 0, 0.62, 0.785);
  part(tmp, ball(0.04, 8), W.pcLed, 0.52, 0.8, 0.775);
  part(tmp, box(0.02, 0.05, 1.0), W.pcLed, 0.785, 0.62, 0);
  part(tmp, box(0.02, 0.05, 1.0), W.pcLed, -0.785, 0.62, 0);
  part(tmp, box(1.0, 0.05, 0.02), W.pcLed, 0, 0.62, -0.785);
  tmp.updateMatrixWorld(true);
  const meshes = []; tmp.traverse((o) => o.isMesh && meshes.push(o));
  for (const m of mergeByMaterial(meshes)) g.add(m);

  // Ventilateur sur le dessus (tourne plus vite quand le processeur travaille)
  const fan = new T.Group();
  fan.position.set(0, 1.045, 0);
  const rim = new T.Mesh(torus(0.4, 0.035, 32), vent); rim.rotation.x = Math.PI / 2; fan.add(rim);
  const hub = new T.Mesh(cyl(0.1, 0.1, 0.04, 12), std('#2b3248', 0.5, 0.4)); fan.add(hub);
  const blades = new T.Group();
  for (let i = 0; i < 7; i++) {
    const p = new T.Group(); p.rotation.y = (i / 7) * Math.PI * 2;
    const bl = new T.Mesh(box(0.3, 0.015, 0.1), std('#4a5370', 0.4, 0.5)); bl.position.x = 0.21; bl.rotation.x = 0.35; p.add(bl);
    blades.add(p);
  }
  fan.add(blades);
  W.fans.push(blades);
  g.add(fan);

  // Anneaux holographiques : processeur (cyan, intérieur) et mémoire (violet, extérieur)
  const ringY = 2.75;
  const mkRing = (rad, color, op) => { const m = new T.Mesh(new T.TorusGeometry(rad, 0.055, 6, 96), gaugeMat(color, op)); m.rotation.x = Math.PI / 2; m.position.y = ringY; g.add(m); return m; };
  mkRing(1.05, '#7dd3fc', 0.16); mkRing(1.36, '#c4b5fd', 0.16);
  W.cpuRing = mkRing(1.05, accentHex(), 0.95);
  W.memRing = mkRing(1.36, '#a78bfa', 0.95);
  const beam = new T.Mesh(new T.CylinderGeometry(0.07, 0.5, ringY - 1.1, 24, 1, true), new T.MeshBasicMaterial({ color: accent(), transparent: true, opacity: 0.1, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide, toneMapped: false }));
  beam.position.y = 1.1 + (ringY - 1.1) / 2;
  W.beam = beam; g.add(beam);
  const halo = new T.Sprite(additive(accentHex(), 0.5)); halo.scale.set(1.6, 1.6, 1); halo.position.y = ringY; W.pcHalo = halo; g.add(halo);

  // Zone cliquable du PC
  const hit = new T.Mesh(new T.BoxGeometry(2.6, 3.4, 2.6), new T.MeshBasicMaterial({ visible: false }));
  hit.position.y = 1.5; hit.userData.ref = { type: 'pc' };
  g.add(hit); W.pcHit = hit;
}
function gaugeMat(hex, opacity) {
  return new T.ShaderMaterial({
    uniforms: { color: { value: new T.Vector3(...rgb(hex)) }, fill: { value: 1 }, opacity: { value: opacity }, time: { value: 0 } },
    transparent: true, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false,
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 color; uniform float fill, opacity, time; varying vec2 vUv; void main() { if (vUv.x > fill) discard; float s = 0.78 + 0.22 * sin(vUv.x * 40.0 - time * 3.0); gl_FragColor = vec4(color * s, opacity); }',
  });
}
const accentHex = () => (getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#22d3ee').slice(0, 7);
const accent = () => new T.Color(accentHex());

// ---------- La ville : quartiers, bâtiments, routes, arbres, épingles ----------
function kindOf(cat, app) {
  const c = String(cat.name).toLowerCase(), a = `${app.name} ${app.icon || ''}`.toLowerCase();
  if (/mathu|🐕|chien|\bdog\b/.test(a)) return 'kennel';
  if (/\bqg\b|🏰|château|castle/.test(a)) return 'keep';
  if (/immich|📷|photo/.test(a)) return 'camera';
  if (/a[iï]ko|🐱|🐈/.test(a)) return 'catdome';
  if (/draco/.test(c)) return 'tower';
  if (/cha[iî]ne|direct|m[ée]dia|vid[ée]o|stream/.test(c)) return 'studio';
  if (/site|web/.test(c)) return 'house';
  if (/\bia\b|\bai\b|auto|intelligence/.test(c)) return 'dome';
  if (/sauvegarde|backup|photo/.test(c)) return 'silo';
  if (/fichier|file|drive|stockage|cloud/.test(c)) return 'warehouse';
  if (/outil|tool|dev/.test(c)) return 'spire';
  return 'pod';
}
const SCREEN_COLORS = ['#f472b6', '#fb923c', '#fbbf24', '#38bdf8', '#c084fc'];
const M = {
  get wall() { return lam('#eef1f8'); }, get warm() { return lam('#f4e8d8'); }, get stone() { return lam('#b9b4cf'); },
  get stoneLight() { return lam('#cfcbe0'); }, get stoneDark() { return lam('#8e88aa'); }, get dark() { return lam('#2a2f45'); },
  get door() { return lam('#5b4636'); }, get wood() { return lam('#b98556'); }, get metal() { return std('#d5dcea', 0.15, 0.4); },
  get dog() { return lam('#d9a066'); }, roof: (c) => lam(c), glass: (c) => lam('#9fb4d8', { emissive: c, emissiveIntensity: 0.25 }),
};
const BUILD = {
  tower(g, r, c) {
    const h = 1.2 + r() * 0.75, rad = 0.36 + r() * 0.07, rh = 0.72 + r() * 0.25;
    part(g, cyl(rad, rad * 1.12, h, 8), M.stone, 0, h / 2, 0, 0, Math.PI / 8);
    part(g, cyl(rad * 1.2, rad * 1.2, 0.12, 8), M.stoneDark, 0, h + 0.06, 0, 0, Math.PI / 8);
    part(g, cone(rad * 1.32, rh, 8), M.roof(c), 0, h + 0.12 + rh / 2, 0, 0, Math.PI / 8);
    part(g, box(0.2, 0.32, 0.08), M.door, 0, 0.16, rad * 1.02);
    part(g, cyl(0.015, 0.015, 0.42, 4), M.dark, 0, h + 0.12 + rh + 0.12, 0);
    part(g, box(0.22, 0.13, 0.015), M.roof(c), 0.11, h + 0.12 + rh + 0.26, 0);
    return { h: h + 0.12 + rh + 0.36, win: [[0, h * 0.62, rad * 1.02], [0, h * 0.36 + 0.12, rad * 1.04]] };
  },
  studio(g, r, c, app) {
    const w = 0.95, d = 0.8, h = 0.75 + r() * 0.35;
    const sc = /twitch/i.test(app.name) ? '#a970ff' : SCREEN_COLORS[app.id % SCREEN_COLORS.length];
    part(g, box(w, h, d), M.wall, 0, h / 2, 0);
    part(g, box(w + 0.08, 0.08, d + 0.08), M.roof(c), 0, h + 0.04, 0);
    part(g, box(w * 0.86, h * 0.6, 0.03), M.dark, 0, h * 0.56, d / 2 + 0.012);
    part(g, box(w * 0.76, h * 0.5, 0.03), glow(sc, 1.5), 0, h * 0.56, d / 2 + 0.03);
    part(g, cyl(0.018, 0.018, 0.55, 4), M.dark, w * 0.3, h + 0.33, -d * 0.2);
    part(g, ball(0.05, 6), glow(sc, 2), w * 0.3, h + 0.62, -d * 0.2);
    return { h: h + 0.7, win: [[-w / 2 - 0.006, h * 0.6, 0, -Math.PI / 2], [w / 2 + 0.006, h * 0.6, 0, Math.PI / 2]] };
  },
  house(g, r, c) {
    const w = 0.85 + r() * 0.15, d = 0.75, h = 0.55 + r() * 0.3, rh = 0.42;
    part(g, box(w, h, d), M.warm, 0, h / 2, 0);
    part(g, prism(w + 0.12, rh, d + 0.12), M.roof(c), 0, h, 0);
    part(g, box(0.12, 0.3, 0.12), M.stone, w * 0.25, h + rh * 0.55, -d * 0.16);
    part(g, box(0.18, 0.3, 0.05), M.door, 0, 0.15, d / 2 + 0.01);
    return { h: h + rh + 0.12, win: [[-w * 0.28, h * 0.62, d / 2 + 0.006], [w * 0.28, h * 0.62, d / 2 + 0.006]] };
  },
  keep(g, r, c) {
    const s = 0.86, h = 1.1;
    part(g, box(s, h, s), M.stone, 0, h / 2, 0);
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      part(g, cyl(0.17, 0.18, h + 0.32, 8), M.stoneLight, (x * s) / 2, (h + 0.32) / 2, (z * s) / 2);
      part(g, cone(0.23, 0.4, 8), M.roof(c), (x * s) / 2, h + 0.32 + 0.2, (z * s) / 2);
    }
    for (let i = -1; i <= 1; i++) for (const [x, z] of [[i * 0.24, s / 2 - 0.05], [i * 0.24, -s / 2 + 0.05], [s / 2 - 0.05, i * 0.24], [-s / 2 + 0.05, i * 0.24]]) part(g, box(0.11, 0.13, 0.11), M.stoneLight, x, h + 0.065, z);
    part(g, box(0.24, 0.36, 0.05), M.door, 0, 0.18, s / 2 + 0.01);
    part(g, cyl(0.015, 0.015, 0.5, 4), M.dark, 0, h + 0.3, 0);
    part(g, box(0.24, 0.14, 0.015), M.roof(c), 0.12, h + 0.48, 0);
    return { h: h + 0.85, win: [[-0.2, h * 0.68, s / 2 + 0.006], [0.2, h * 0.68, s / 2 + 0.006]] };
  },
  dome(g, r, c) {
    part(g, cyl(0.5, 0.55, 0.32, 12), M.wall, 0, 0.16, 0);
    part(g, hemi(0.47), M.glass(c), 0, 0.32, 0);
    part(g, torus(0.3, 0.025, 20), glow(c, 1.6), 0, 0.98, 0, Math.PI / 2);
    part(g, cyl(0.015, 0.015, 0.25, 4), M.dark, 0, 0.86, 0);
    return { h: 1.12, win: [[0, 0.17, 0.53]] };
  },
  catdome(g, r, c) {
    BUILD.dome(g, r, c);
    for (const s of [-1, 1]) {
      part(g, cone(0.13, 0.28, 4), M.roof(c), s * 0.23, 0.32 + 0.38, 0, 0, Math.PI / 4, -s * 0.38);
      part(g, ball(0.045, 6), glow('#22d3ee', 2.2), s * 0.14, 0.55, 0.37);
    }
    return { h: 1.15, win: [] };
  },
  silo(g, r, c) {
    const h = 1.45 + r() * 0.3;
    part(g, cyl(0.38, 0.4, h, 12), M.metal, 0, h / 2, 0);
    part(g, hemi(0.385), M.roof(c), 0, h, 0);
    for (const y of [h * 0.3, h * 0.66]) part(g, cyl(0.41, 0.41, 0.06, 12), M.roof(c), 0, y, 0);
    part(g, box(0.42, 0.4, 0.4), M.wall, 0.46, 0.2, 0.16);
    return { h: h + 0.5, win: [[0.46, 0.24, 0.365]] };
  },
  camera(g, r, c) {
    part(g, box(0.95, 0.62, 0.72), M.wall, 0, 0.31, 0);
    part(g, box(0.3, 0.13, 0.26), M.dark, -0.24, 0.685, 0);
    part(g, cyl(0.25, 0.28, 0.16, 16), M.dark, 0.1, 0.33, 0.36 + 0.08, Math.PI / 2);
    part(g, cyl(0.17, 0.17, 0.03, 16), glow('#7dd3fc', 1.1), 0.1, 0.33, 0.36 + 0.17, Math.PI / 2);
    ['#fbbf24', '#f472b6', '#60a5fa', '#a78bfa'].forEach((col, i) => part(g, ball(0.07, 6), lam(col), 0.2 + (i % 2) * 0.14, 0.66, -0.12 + Math.floor(i / 2) * 0.14));
    return { h: 1.0, win: [] };
  },
  warehouse(g, r, c) {
    const w = 1.1, d = 0.8, h = 0.5;
    part(g, box(w, h, d), M.wall, 0, h / 2, 0);
    part(g, arch(d / 2 + 0.04, w + 0.06), M.roof(c), 0, h, 0);
    part(g, box(0.42, 0.36, 0.04), M.door, 0, 0.18, d / 2 + 0.01);
    return { h: h + d / 2 + 0.22, win: [[-w * 0.36, h * 0.62, d / 2 + 0.006], [w * 0.36, h * 0.62, d / 2 + 0.006]] };
  },
  spire(g, r, c) {
    const h = 1.4 + r() * 0.6;
    part(g, box(0.56, h, 0.56), M.glass(c), 0, h / 2, 0);
    part(g, box(0.62, 0.08, 0.62), M.roof(c), 0, h * 0.5, 0);
    part(g, box(0.64, 0.1, 0.64), M.roof(c), 0, h + 0.05, 0);
    part(g, cyl(0.015, 0.015, 0.5, 4), M.dark, 0, h + 0.35, 0);
    part(g, ball(0.04, 6), glow('#f472b6', 2), 0, h + 0.62, 0);
    return { h: h + 0.72, win: [[0, h * 0.76, 0.285], [0, h * 0.27, 0.285]] };
  },
  pod(g, r, c) {
    const h = 0.6 + r() * 0.4;
    part(g, box(0.82, h, 0.82), M.wall, 0, h / 2, 0);
    part(g, box(0.64, 0.16, 0.64), M.roof(c), 0, h + 0.08, 0);
    part(g, cyl(0.02, 0.02, 0.2, 4), M.dark, 0.18, h + 0.26, 0.1);
    part(g, hemi(0.2, 10), M.metal, 0.18, h + 0.36, 0.1, -0.7, 0, 0.2);
    return { h: h + 0.62, win: [[-0.2, h * 0.55, 0.416], [0.2, h * 0.55, 0.416]] };
  },
  kennel(g, r, c) {
    part(g, box(0.62, 0.42, 0.55), M.wood, 0, 0.21, 0);
    part(g, prism(0.74, 0.32, 0.68), M.roof('#c2410c'), 0, 0.42, 0);
    part(g, box(0.24, 0.27, 0.04), M.dark, 0, 0.14, 0.28);
    // Mathu, assis devant sa niche
    const dog = M.dog;
    part(g, box(0.26, 0.13, 0.12), dog, 0.24, 0.15, 0.48);
    part(g, box(0.13, 0.13, 0.13), dog, 0.41, 0.26, 0.48);
    part(g, box(0.06, 0.05, 0.07), lam('#3b2a20'), 0.49, 0.24, 0.48);
    for (const z of [0.44, 0.52]) part(g, box(0.04, 0.07, 0.03), lam('#8a5a32'), 0.4, 0.35, z);
    for (const [x, z] of [[0.15, 0.44], [0.15, 0.52], [0.33, 0.44], [0.33, 0.52]]) part(g, box(0.04, 0.1, 0.04), dog, x, 0.05, z);
    part(g, box(0.12, 0.03, 0.03), dog, 0.07, 0.25, 0.48, 0, 0, -0.7);
    return { h: 0.98, win: [] };
  },
};

function signature() {
  return JSON.stringify(HL.state.board.categories.filter((c) => c.apps.length).map((c) => [c.id, c.name, c.apps.map((a) => [a.id, a.name, a.icon, a.ping])]));
}
function disposeCity() {
  const c = W.city;
  W.world.remove(c.group);
  const cachedMats = new Set(MAT.values()), cachedGeos = new Set(GEO.values());
  c.group.traverse((o) => {
    if (o.geometry && !o.isSprite && !cachedGeos.has(o.geometry)) o.geometry.dispose();
    if (o.material && !cachedMats.has(o.material)) {
      if (o.material.map && o.material.map !== glowTex) o.material.map.dispose();
      o.material.dispose();
    }
  });
  labelsEl.innerHTML = '';
  W.pickables = W.pickables.filter((p) => p.userData.ref?.type !== 'app');
  W.hover = W.selected = W.tileHover = null;
  hideTip();
}

function rebuildCity() {
  if (W.city) disposeCity();
  W.boardSig = signature();
  const cats = HL.state.board.categories.filter((c) => c.apps.length);
  const group = new T.Group();
  const city = (W.city = { group, buildings: [], cats: [], byId: new Map() });
  W.world.add(group);
  const temp = new T.Group(); // pièces avant fusion
  const winOn = [], winOff = [];
  const m4 = new T.Matrix4(), q = new T.Quaternion(), one = new T.Vector3(1, 1, 1), e = new T.Euler();
  const total = cats.reduce((s, c) => s + Math.max(c.apps.length, 1.6) + 0.8, 0) || 1;
  let a = W.pondAngle + 0.18;
  const occupied = []; // [x, z, rayon] pour placer les arbres ensuite
  const spokes = [];

  cats.forEach((cat, ci) => {
    const span = ((Math.max(cat.apps.length, 1.6) + 0.8) / total) * (Math.PI * 2 - 0.36);
    const a0 = a, a1 = a + span;
    a = a1;
    spokes.push(a0);
    const color = HL.catColor(cat, ci);
    const mid = (a0 + a1) / 2;
    city.cats.push({ cat, a0, a1, mid, color });
    // Répartition dans les rangées
    const rows = ROWS.map((r) => ({ r, cap: Math.max(1, Math.floor((r * span - 0.9) / SPACING) + 1), apps: [] }));
    let i = 0;
    for (const row of rows) while (row.apps.length < row.cap && i < cat.apps.length) row.apps.push(cat.apps[i++]);
    while (i < cat.apps.length) rows[i % 3].apps.push(cat.apps[i++]); // très grosse catégorie : on tasse
    for (const row of rows) {
      row.apps.forEach((app, k) => {
        const rnd = rng(app.id * 7919 + 13);
        const ang = a0 + (span * (k + 0.5)) / row.apps.length + (rnd() - 0.5) * (0.12 / row.r);
        const rr = row.r + (rnd() - 0.5) * 0.22;
        const x = Math.cos(ang) * rr, z = Math.sin(ang) * rr;
        const bg = new T.Group();
        bg.position.set(x, 0, z);
        bg.rotation.y = Math.atan2(-Math.cos(ang), -Math.sin(ang));
        const kind = kindOf(cat, app);
        const out = BUILD[kind](bg, rnd, color, app);
        temp.add(bg);
        bg.updateMatrixWorld(true);
        for (const [wx, wy, wz, wr = 0] of out.win) {
          e.set(0, wr, 0); q.setFromEuler(e);
          m4.compose(new T.Vector3(wx, wy, wz), q, one).premultiply(bg.matrixWorld);
          (rnd() < 0.78 ? winOn : winOff).push(m4.clone());
        }
        occupied.push([x, z, 0.75]);
        city.buildings.push(makeBuilding(app, cat, x, z, out.h, color, group));
      });
    }
  });

  // Routes : deux anneaux + des rayons entre les quartiers
  const road = lam('#e6dcc4', { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  for (const r of RINGS) {
    const ring = new T.Mesh(new T.RingGeometry(r - 0.17, r + 0.17, 128), road);
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.012;
    temp.add(ring);
  }
  const lampPos = [];
  for (const s of spokes) {
    const len = 8.45 - 2.85;
    const sp = new T.Mesh(new T.PlaneGeometry(0.32, len), road);
    sp.rotation.set(-Math.PI / 2, 0, -s + Math.PI / 2);
    const rm = 2.85 + len / 2;
    sp.position.set(Math.cos(s) * rm, 0.013, Math.sin(s) * rm);
    temp.add(sp);
    for (const r of RINGS) { const la = s + 0.32 / r; lampPos.push([Math.cos(la) * (r + 0.3), Math.sin(la) * (r + 0.3)]); }
  }
  temp.updateMatrixWorld(true);
  const meshes = [];
  temp.traverse((o) => { if (o.isMesh) meshes.push(o); });
  for (const m of mergeByMaterial(meshes)) group.add(m);

  // Fenêtres (allumées la nuit) et lampadaires
  const winGeo = new T.PlaneGeometry(0.14, 0.18);
  const mkInst = (list, mat) => {
    if (!list.length) return null;
    const im = new T.InstancedMesh(winGeo, mat, list.length);
    list.forEach((mm, i) => im.setMatrixAt(i, mm));
    im.frustumCulled = false;
    group.add(im);
    return im;
  };
  W.winMat = W.winMat || lam('#3d4a6b', { emissive: '#ffcf7a', emissiveIntensity: 0, side: T.DoubleSide });
  mkInst(winOn, W.winMat);
  mkInst(winOff, lam('#3d4a6b', { side: T.DoubleSide }));
  const poles = new T.InstancedMesh(cyl(0.025, 0.03, 0.55, 5), lam('#4a5068'), lampPos.length);
  W.lampMat = W.lampMat || lam('#fff3d6', { emissive: '#ffd27a', emissiveIntensity: 0 });
  const bulbs = new T.InstancedMesh(ball(0.065, 6), W.lampMat, lampPos.length);
  const glowPts = new Float32Array(lampPos.length * 3);
  lampPos.forEach(([x, z], i) => {
    m4.makeTranslation(x, 0.275, z); poles.setMatrixAt(i, m4);
    m4.makeTranslation(x, 0.58, z); bulbs.setMatrixAt(i, m4);
    glowPts.set([x, 0.58, z], i * 3);
    occupied.push([x, z, 0.25]);
  });
  poles.castShadow = true; poles.frustumCulled = bulbs.frustumCulled = false;
  group.add(poles, bulbs);
  const lg = new T.BufferGeometry(); lg.setAttribute('position', new T.BufferAttribute(glowPts, 3));
  W.lampGlow = new T.Points(lg, new T.PointsMaterial({ size: 1.4, map: glowTexture(), color: '#ffcf7a', transparent: true, opacity: 0, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false }));
  group.add(W.lampGlow);

  plantTrees(group, occupied, spokes);
  buildArcs(group);
  buildLabels();
  for (const b of city.buildings) city.byId.set(b.app.id, b);
  applyHighlight();
  W.dirtyShadow = true;
}

// Une épingle (icône + anneau d'état), son halo, l'anneau de sélection au sol et la zone cliquable
function makeBuilding(app, cat, x, z, h, color, group) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const tex = new T.CanvasTexture(c);
  tex.colorSpace = T.SRGBColorSpace; tex.anisotropy = 4;
  const pin = new T.Sprite(new T.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false, fog: false }));
  pin.center.set(0.5, 0.02);
  const ps = W.small ? 1.1 : 1.12;
  pin.scale.set(ps, ps, 1);
  pin.position.set(x, h + 0.1, z);
  pin.renderOrder = 10;
  const halo = new T.Sprite(additive('#ffffff', 0));
  halo.scale.set(1.5, 1.5, 1); halo.position.set(x, h + 0.1 + ps * 0.42, z); halo.renderOrder = 9;
  const ring = new T.Mesh(new T.RingGeometry(0.62, 0.76, 40), new T.MeshBasicMaterial({ color: accentHex(), transparent: true, opacity: 0, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false }));
  ring.rotation.x = -Math.PI / 2; ring.position.set(x, 0.04, z);
  const hit = new T.Mesh(new T.BoxGeometry(1.15, h + 1.15, 1.15), new T.MeshBasicMaterial({ visible: false }));
  hit.position.set(x, (h + 1.15) / 2, z);
  const b = { app, cat, x, z, h, color, pin, halo, ring, hit, canvas: c, tex, icon: null, st: null, scale: 1, target: 1, dim: 1, phase: (app.id * 1.7) % 6.28 };
  hit.userData.ref = { type: 'app', b };
  group.add(pin, halo, ring, hit);
  W.pickables.push(hit);
  drawPin(b);
  iconFor(app).then((ic) => { b.icon = ic; drawPin(b); requestRender(); });
  return b;
}
function statusOf(app) {
  if (!app.ping) return 'idle';
  const s = HL.state.status?.[app.id];
  if (!s) return 'wait';
  return s.up ? 'up' : 'down';
}
const ICON_CACHE = new Map();
function loadImg(url) {
  return new Promise((res) => {
    const i = new Image(); i.crossOrigin = 'anonymous'; i.decoding = 'async';
    i.onload = () => res(i.naturalWidth ? i : null); i.onerror = () => res(null);
    i.src = url;
  });
}
function iconFor(app) {
  let icon = app.icon || HL.slug(app.name);
  if (HL.isEmoji(icon)) return Promise.resolve({ emoji: icon });
  if (!ICON_CACHE.has(icon)) {
    const urls = /^https?:\/\//.test(icon) ? [icon] : [`${HL.ICON_CDN}/svg/${HL.slug(icon)}.svg`, `${HL.ICON_CDN}/png/${HL.slug(icon)}.png`];
    ICON_CACHE.set(icon, (async () => { for (const u of urls) { const img = await loadImg(u); if (img) return { img }; } return null; })());
  }
  return ICON_CACHE.get(icon).then((r) => r || { letter: String(app.name || '?')[0].toUpperCase(), color: HL.letterColor(app.name) });
}
function drawPin(b) {
  const x = b.canvas.getContext('2d');
  const st = (b.st = statusOf(b.app));
  x.clearRect(0, 0, 128, 128);
  x.save();
  x.shadowColor = 'rgba(6,10,28,.45)'; x.shadowBlur = 10; x.shadowOffsetY = 3;
  x.fillStyle = '#ffffff';
  x.beginPath(); x.moveTo(50, 92); x.lineTo(64, 124); x.lineTo(78, 92); x.closePath(); x.fill();
  x.beginPath(); x.arc(64, 52, 46, 0, Math.PI * 2); x.fill();
  x.restore();
  x.lineWidth = 8; x.strokeStyle = ST_COLOR[st];
  x.beginPath(); x.arc(64, 52, 41, 0, Math.PI * 2); x.stroke();
  const ic = b.icon;
  if (ic?.img) {
    const s = 50, k = ic.img.naturalWidth / ic.img.naturalHeight || 1;
    const w = k >= 1 ? s : s * k, h = k >= 1 ? s / k : s;
    x.drawImage(ic.img, 64 - w / 2, 52 - h / 2, w, h);
  } else if (ic?.emoji) {
    x.font = '50px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(ic.emoji, 64, 56);
  } else if (ic?.letter) {
    x.fillStyle = ic.color; x.beginPath(); x.arc(64, 52, 28, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#fff'; x.font = '700 32px Inter, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(ic.letter, 64, 54);
  }
  b.tex.needsUpdate = true;
  const hc = st === 'down' ? ST_COLOR.down : st === 'up' ? ST_COLOR.up : null;
  b.halo.material.color.set(hc || '#ffffff');
  b.halo.material.opacity = hc ? (st === 'down' ? 0.9 : 0.35) : 0;
}

function plantTrees(group, occupied, spokes) {
  const rnd = rng(42);
  const spots = [];
  const free = (x, z, rad) => {
    const r = Math.hypot(x, z), a = Math.atan2(z, x);
    if (r < 3.15 || r > R * rimK(a) - 0.75) return false;
    for (const rg of RINGS) if (Math.abs(r - rg) < 0.36) return false;
    for (const s of spokes) if (Math.abs(angDiff(a, s)) * r < 0.36 && r < 8.6) return false;
    if (Math.abs(angDiff(a, W.pondAngle)) * r < 1.1 && r > 7.6) return false;
    if (Math.abs(angDiff(a, W.padAngle)) * r < 1.6 && r > 7.8) return false;
    for (const [ox, oz, or] of occupied) if (Math.hypot(x - ox, z - oz) < or + rad) return false;
    for (const [ox, oz, or] of spots) if (Math.hypot(x - ox, z - oz) < or + rad) return false;
    return true;
  };
  for (let i = 0; i < 1600 && spots.length < 120; i++) {
    const a = rnd() * Math.PI * 2;
    const band = rnd();
    const r = band < 0.62 ? 8.35 + rnd() * 1.2 : 3.2 + rnd() * 5.2;
    const s = 0.75 + rnd() * 0.55;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (free(x, z, 0.26 * s)) spots.push([x, z, 0.26 * s, s, rnd() < 0.45 ? 1 : 0, rnd()]);
  }
  if (!spots.length) return;
  const trunks = new T.InstancedMesh(cyl(0.05, 0.07, 0.32, 5), lam('#8a6248'), spots.length);
  const pines = spots.filter((s) => s[4] === 1), rounds = spots.filter((s) => s[4] === 0);
  const pineMesh = new T.InstancedMesh(cone(0.3, 0.72, 6), lam('#ffffff'), pines.length);
  const roundMesh = new T.InstancedMesh(new T.IcosahedronGeometry(0.32, 0), lam('#ffffff'), rounds.length);
  const m4 = new T.Matrix4(), q = new T.Quaternion(), e = new T.Euler(), v = new T.Vector3(), sc = new T.Vector3(), col = new T.Color();
  spots.forEach(([x, z, , s, , k], i) => {
    m4.compose(v.set(x, 0.16 * s, z), q.identity(), sc.set(s, s, s)); trunks.setMatrixAt(i, m4);
  });
  pines.forEach(([x, z, , s, , k], i) => {
    m4.compose(v.set(x, (0.32 + 0.36) * s, z), q.setFromEuler(e.set(0, k * 6, 0)), sc.set(s, s, s)); pineMesh.setMatrixAt(i, m4);
    pineMesh.setColorAt(i, col.set(['#3f9a6e', '#4aa577', '#368a62'][Math.floor(k * 3)]));
  });
  rounds.forEach(([x, z, , s, , k], i) => {
    m4.compose(v.set(x, (0.32 + 0.24) * s, z), q.setFromEuler(e.set(k * 3, k * 5, k * 2)), sc.set(s, s * 0.95, s)); roundMesh.setMatrixAt(i, m4);
    roundMesh.setColorAt(i, col.set(['#5fbf7b', '#6cc98a', '#82cf6e', '#f2a65a'][Math.floor(k * 3.3)]));
  });
  for (const im of [trunks, pineMesh, roundMesh]) { if (!im.count) continue; im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false; group.add(im); }
}

// Liaisons PC → bâtiments (arcs) et paquets lumineux qui circulent
function arcPoint(b, t, out) {
  const sx = 0, sy = 2.3, sz = 0, ex = b.x, ey = b.h + 0.15, ez = b.z;
  const d = Math.hypot(ex, ez);
  const cx = ex * 0.5, cy = Math.max(sy, ey) + d * 0.34, cz = ez * 0.5;
  const u = 1 - t;
  return out.set(u * u * sx + 2 * u * t * cx + t * t * ex, u * u * sy + 2 * u * t * cy + t * t * ey, u * u * sz + 2 * u * t * cz + t * t * ez);
}
function buildArcs(group) {
  const bs = W.city.buildings, N = 22;
  const pos = new Float32Array(bs.length * N * 6), col = new Float32Array(bs.length * N * 6);
  const p = new T.Vector3(), q = new T.Vector3();
  bs.forEach((b, i) => {
    for (let k = 0; k < N; k++) {
      arcPoint(b, k / N, p); arcPoint(b, (k + 1) / N, q);
      pos.set([p.x, p.y, p.z, q.x, q.y, q.z], (i * N + k) * 6);
    }
  });
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.BufferAttribute(pos, 3));
  g.setAttribute('color', new T.BufferAttribute(col, 3));
  W.arcs = new T.LineSegments(g, new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.3, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false, fog: false }));
  W.arcs.frustumCulled = false;
  group.add(W.arcs);
  // 2 paquets par liaison
  const n = bs.length * 2;
  const pg = new T.BufferGeometry();
  pg.setAttribute('position', new T.BufferAttribute(new Float32Array(n * 3), 3));
  pg.setAttribute('color', new T.BufferAttribute(new Float32Array(n * 3), 3));
  W.packets = new T.Points(pg, new T.PointsMaterial({ size: 0.34, map: glowTexture(), vertexColors: true, transparent: true, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false, fog: false }));
  W.packets.frustumCulled = false;
  W.packetData = bs.flatMap((b, i) => [0, 1].map((k) => ({ b, t: (i * 0.137 + k * 0.5) % 1, sp: 0.16 + ((b.app.id * 31) % 10) / 70 })));
  group.add(W.packets);
  recolorArcs();
}
function recolorArcs() {
  if (!W.arcs) return;
  const col = W.arcs.geometry.attributes.color, N = 22;
  const a1 = rgb(accentHex()), a2 = rgb('#a78bfa');
  const pc = W.packets.geometry.attributes.color;
  W.city.buildings.forEach((b, i) => {
    const st = b.st || statusOf(b.app);
    for (let k = 0; k < N; k++) {
      for (const [j, t] of [[0, k / N], [1, (k + 1) / N]]) {
        let c;
        if (st === 'down') c = mixc([0.35, 0.05, 0.08], rgb(ST_COLOR.down), t);
        else if (st === 'up') c = mixc(a1, a2, t).map((v) => v * (0.35 + 0.65 * Math.sin(t * Math.PI)));
        else c = [0.16, 0.18, 0.24].map((v) => v * Math.sin(t * Math.PI));
        if (W.query && b.dim < 1) c = c.map((v) => v * 0.2);
        col.setXYZ((i * N + k) * 2 + j, c[0], c[1], c[2]);
      }
    }
    for (let k = 0; k < 2; k++) { const c = st === 'up' ? (k ? a2 : a1) : [0, 0, 0]; pc.setXYZ(i * 2 + k, c[0], c[1], c[2]); }
  });
  col.needsUpdate = true; pc.needsUpdate = true;
}

// Étiquettes des quartiers (HTML), autour de l'île
function buildLabels() {
  labelsEl.innerHTML = W.city.cats.map((c, i) => `<button type="button" class="isl-label" data-i="${i}" style="--c:${c.color}"><i></i>${HL.esc(c.cat.name)}</button>`).join('');
  W.labelEls = [...labelsEl.children];
  W.labelW = W.labelEls.map((el) => el.offsetWidth);
  W.labelEls.forEach((el) => {
    el.onclick = () => {
      const c = W.city.cats[Number(el.dataset.i)];
      document.querySelector(`.category[data-cat="${c.cat.id}"]`)?.scrollIntoView({ behavior: REDUCE.matches ? 'auto' : 'smooth', block: 'start' });
    };
  });
}

// ---------- Nuages, pluie, neige ----------
function makeClouds() {
  const rnd = rng(99);
  W.cloudMat = lam('#ffffff', { emissive: '#ffffff', emissiveIntensity: 0.6, flatShading: false });
  for (let i = 0; i < 10; i++) {
    const tmp = new T.Group();
    const n = 3 + Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) {
      const s = 0.55 + rnd() * 0.55;
      const m = new T.Mesh(new T.IcosahedronGeometry(s, 1), W.cloudMat);
      m.position.set((k - n / 2) * 0.75 + rnd() * 0.35, rnd() * 0.25 * s, (rnd() - 0.5) * 0.6);
      m.scale.set(1.35, 0.72, 1);
      m.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
      tmp.add(m);
    }
    tmp.updateMatrixWorld(true);
    const parts = []; tmp.traverse((o) => o.isMesh && parts.push(o));
    const mesh = mergeByMaterial(parts)[0];
    mesh.castShadow = false; mesh.receiveShadow = false;
    const s = 0.7 + rnd() * 0.6;
    mesh.scale.setScalar(s);
    // Les nuages proches restent sous le niveau des bâtiments pour ne pas les cacher
    const high = rnd() < 0.45;
    mesh.userData = { r: high ? 17 + rnd() * 6 : 12.5 + rnd() * 7, a: rnd() * Math.PI * 2, y: high ? 1 + rnd() * 5 : -6.5 + rnd() * 5.5, sp: (0.01 + rnd() * 0.02) * (rnd() < 0.5 ? 1 : -1) };
    W.clouds.push(mesh);
    W.scene.add(mesh);
  }
}
function makeWeatherFx() {
  const n = 900, pos = new Float32Array(n * 6);
  const rnd = rng(5);
  W.rainData = Array.from({ length: n }, () => ({ x: (rnd() - 0.5) * 32, y: -8 + rnd() * 22, z: (rnd() - 0.5) * 32, v: 13 + rnd() * 5 }));
  const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(pos, 3));
  W.rain = new T.LineSegments(g, new T.LineBasicMaterial({ color: '#b9cbff', transparent: true, opacity: 0.5, depthWrite: false, fog: false }));
  W.rain.frustumCulled = false; W.rain.visible = false;
  W.scene.add(W.rain);
  const m = 700, sp = new Float32Array(m * 3);
  W.snowData = Array.from({ length: m }, () => ({ x: (rnd() - 0.5) * 30, y: -8 + rnd() * 22, z: (rnd() - 0.5) * 30, v: 0.8 + rnd() * 0.8, ph: rnd() * 6 }));
  const sg = new T.BufferGeometry(); sg.setAttribute('position', new T.BufferAttribute(sp, 3));
  W.snow = new T.Points(sg, new T.PointsMaterial({ size: 0.2, map: glowTexture(), color: '#ffffff', transparent: true, depthWrite: false, fog: false }));
  W.snow.frustumCulled = false; W.snow.visible = false;
  W.scene.add(W.snow);
  // Tapis de neige posé sur l'herbe quand il neige
  const cover = new T.CircleGeometry(R, 80);
  const cp = cover.attributes.position;
  for (let i = 0; i < cp.count; i++) { const x = cp.getX(i), y = cp.getY(i); const k = Math.hypot(x, y) > 0.01 ? rimK(Math.atan2(-y, x)) * 0.995 : 1; cp.setXY(i, x * k, y * k); }
  W.snowCover = new T.Mesh(cover, lam('#f4f7ff', { transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  W.snowCover.rotation.x = -Math.PI / 2; W.snowCover.position.y = 0.004; W.snowCover.receiveShadow = true; W.snowCover.visible = false;
  W.island.add(W.snowCover);
}

// ---------- Drones (appareils Tailscale) ----------
function updateDrones() {
  const r = HL.state.remote;
  const peers = (r?.available ? r.peers : []) || [];
  const sig = JSON.stringify(peers.map((p) => [p.name, p.online]));
  if (sig === W.devSig) return;
  W.devSig = sig;
  for (const d of W.drones) { W.world.remove(d.g); W.pickables = W.pickables.filter((p) => p !== d.hit); }
  for (const p of W.pads) W.world.remove(p);
  W.drones = []; W.pads = [];
  W.padAngle = W.padAngle ?? W.pondAngle + Math.PI;
  peers.forEach((p, i) => {
    const pa = W.padAngle + (i - (peers.length - 1) / 2) * 0.17;
    const pr = Math.min(8.85, R * rimK(pa) - 0.62);
    const pad = new T.Group();
    pad.position.set(Math.cos(pa) * pr, 0.04, Math.sin(pa) * pr);
    const base = new T.Mesh(cyl(0.42, 0.46, 0.08, 6), lam('#353c55')); base.receiveShadow = true; pad.add(base);
    const pr2 = new T.Mesh(torus(0.3, 0.02, 24), glow(p.online ? ST_COLOR.up : '#64748b', 1.2)); pr2.rotation.x = Math.PI / 2; pr2.position.y = 0.045; pad.add(pr2);
    W.world.add(pad); W.pads.push(pad);
    const g = new T.Group();
    const body = new T.Mesh(ball(0.2, 10), std('#e8ecf5', 0.1, 0.45)); body.scale.set(1, 0.45, 1.25); g.add(body);
    const rotors = [];
    for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const arm = new T.Mesh(box(0.34, 0.025, 0.04), std('#3b4256', 0.4, 0.5));
      arm.position.set(x * 0.15, 0.02, z * 0.15); arm.rotation.y = Math.atan2(z, x) * -1; g.add(arm);
      const rot = new T.Group(); rot.position.set(x * 0.28, 0.06, z * 0.28);
      const blade = new T.Mesh(box(0.26, 0.008, 0.035), std('#1f2433', 0.3, 0.6)); rot.add(blade);
      const disc = new T.Mesh(new T.CircleGeometry(0.14, 16), new T.MeshBasicMaterial({ color: '#cbd5e1', transparent: true, opacity: 0.12, depthWrite: false, side: T.DoubleSide }));
      disc.rotation.x = -Math.PI / 2; rot.add(disc);
      g.add(rot); rotors.push(rot);
    }
    const ledC = p.online ? ST_COLOR.up : '#64748b';
    const led = new T.Mesh(ball(0.045, 6), glow(ledC, 2.4)); led.position.set(0, -0.04, 0.24); g.add(led);
    const halo = new T.Sprite(additive(ledC, p.online ? 0.7 : 0.15)); halo.scale.set(0.6, 0.6, 1); halo.position.copy(led.position); g.add(halo);
    g.traverse((o) => { if (o.isMesh) o.castShadow = false; });
    const hit = new T.Mesh(new T.BoxGeometry(0.9, 0.5, 0.9), new T.MeshBasicMaterial({ visible: false }));
    g.add(hit);
    const d = { p, g, rotors, hit, pad, orbit: 11.2 + i * 1.1, h: 3.6 + (i % 3) * 0.9, sp: 0.16 + i * 0.03, a: i * 2.1, ph: i * 1.3 };
    hit.userData.ref = { type: 'drone', d };
    if (!p.online) g.position.set(pad.position.x, 0.2, pad.position.z);
    W.world.add(g); W.drones.push(d); W.pickables.push(hit);
  });
  W.dirtyShadow = true;
}

// ---------- Mises à jour depuis les données ----------
function updateSky() {
  const k = paintCssSky();
  W.sky = k;
  const u = W.backdrop.material.uniforms;
  u.top.value.setRGB(...k.top, T.SRGBColorSpace);
  u.mid.value.setRGB(...k.mid, T.SRGBColorSpace);
  u.bot.value.setRGB(...k.bot, T.SRGBColorSpace);
  u.sunCol.value.setRGB(...k.sunCol, T.SRGBColorSpace);
  W.scene.fog.color.setRGB(...mixc(k.bot, k.mid, 0.55), T.SRGBColorSpace);
  W.scene.fog.near = k.w.fog ? 30 : 46; W.scene.fog.far = k.w.fog ? 60 : 92;
  const useSun = k.sunI >= k.moonI;
  const dir = useSun ? k.sunDir : k.moonDir;
  W.sun.position.set(dir[0] * 45, dir[1] * 45, dir[2] * 45);
  W.sun.color.setRGB(...(useSun ? k.sunCol : rgb('#a9bcff')), T.SRGBColorSpace);
  W.sun.intensity = Math.max(k.sunI, k.moonI);
  W.hemi.color.setRGB(...mixc(mixc(k.mid, k.top, 0.5), [0.92, 0.94, 1], k.gray * 0.6 * (1 - k.night)), T.SRGBColorSpace);
  W.hemi.groundColor.set(k.night > 0.5 ? '#2a2347' : '#7d6d60');
  W.hemi.intensity = k.hemiI;
  W.renderer.toneMappingExposure = lerp(1.0, 1.2, k.night);
  W.stars.material.opacity = smooth(-2, -12, k.alt) * (1 - k.w.cover * 0.85);
  const nf = smooth(4, -5, k.alt) + k.gray * 0.2;
  if (W.winMat) W.winMat.emissiveIntensity = nf * 2.2;
  if (W.lampMat) W.lampMat.emissiveIntensity = nf * 3;
  if (W.lampGlow) W.lampGlow.material.opacity = Math.min(1, nf);
  W.cloudMat.color.set(k.w.rain || k.w.storm ? '#c3cad8' : '#ffffff');
  W.cloudMat.emissive.set(k.w.rain || k.w.storm ? '#aab3c5' : '#ffffff');
  W.cloudMat.emissiveIntensity = lerp(0.6, 0.06, k.night);
  const nClouds = Math.round(3 + k.w.cover * 5 + (k.w.rain ? 2 : 0));
  W.clouds.forEach((c, i) => (c.visible = i < nClouds));
  W.rain.visible = k.w.rain; W.snow.visible = k.w.snow;
  W.snowCover.visible = k.w.snow; W.snowCover.material.opacity = k.w.snow ? 0.62 : 0;
  W.dirtyShadow = true;
}
function updateSystem() {
  const s = HL.state.system;
  if (!s) return;
  W.sys.cpu = clamp(s.cpu?.usage ?? 0, 0, 100) / 100;
  W.sys.mem = clamp((s.memory.total - s.memory.free) / s.memory.total, 0, 1);
}
function updateStatus() {
  if (!W.city) return;
  for (const b of W.city.buildings) if (statusOf(b.app) !== b.st) drawPin(b);
  recolorArcs();
}

// ---------- Recherche et survol des tuiles : on met en valeur les bâtiments ----------
function applyHighlight() {
  if (!W.city) return;
  const q = W.query;
  for (const b of W.city.buildings) {
    const a = b.app;
    const match = !q || `${a.name} ${a.description || ''} ${a.url}`.toLowerCase().includes(q);
    b.dim = match ? 1 : 0.18;
    b.target = (q && match) || W.hover?.b === b || W.selected?.b === b || W.tileHover === b ? 1.3 : 1;
  }
  recolorArcs();
}

// ---------- Interaction ----------
function setupInput() {
  const c = W.ctl;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    c.drag = { x: e.clientX, y: e.clientY, t: performance.now(), lt: performance.now(), id: e.pointerId, type: e.pointerType };
    c.moved = 0; c.vel = 0; c.idle = 0;
  });
  canvas.addEventListener('pointermove', (e) => {
    const d = c.drag;
    if (d && e.pointerId === d.id) {
      const dx = e.clientX - d.x, dy = e.clientY - d.y, now = performance.now();
      d.x = e.clientX; d.y = e.clientY;
      c.moved += Math.abs(dx) + Math.abs(dy);
      if (c.moved < 4) return;
      if (!d.captured) { try { canvas.setPointerCapture(e.pointerId); } catch {} d.captured = true; canvas.classList.add('dragging'); hideTip(); doneHint(); }
      const k = 5.4 / Math.max(320, hero.clientWidth);
      c.theta -= dx * k;
      const dts = Math.max(0.008, (now - d.lt) / 1000);
      c.vel = lerp(c.vel, (-dx * k) / dts, 0.45);
      d.lt = now;
      if (d.type === 'mouse') c.phi = clamp(c.phi + dy * 0.004, 0.3, 0.95);
      c.idle = 0;
      requestRender();
      return;
    }
    if (e.pointerType === 'mouse') hoverAt(e);
  });
  const end = (e) => {
    const d = c.drag;
    if (!d || e.pointerId !== d.id) return;
    if (performance.now() - d.lt > 90) c.vel = 0;
    c.lastMoved = c.moved;
    c.drag = null;
    canvas.classList.remove('dragging');
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !c.drag) setHover(null); });
  canvas.addEventListener('click', (e) => {
    if (c.lastMoved > 8) return;
    const ref = pickAt(e);
    if (COARSE.matches || e.pointerType === 'touch') {
      if (!ref) { select(null); return; }
      if (ref.type === 'app' && W.selected?.b === ref.b) return openApp(ref.b.app);
      select(ref);
      return;
    }
    if (!ref) return;
    if (ref.type === 'app') openApp(ref.b.app);
    else if (ref.type === 'pc') location.hash = '#/monitor';
    else if (ref.type === 'drone' && HL.state.user?.role === 'admin') location.hash = '#/remote';
  });
  tipEl.addEventListener('click', (e) => {
    const a = e.target.closest('[data-open]');
    if (!a || !W.selected || W.selected.type !== 'app') return;
    e.preventDefault();
    openApp(W.selected.b.app);
  });
  document.getElementById('search')?.addEventListener('input', (e) => { W.query = e.target.value.trim().toLowerCase(); applyHighlight(); requestRender(); });
  document.getElementById('search')?.addEventListener('keydown', (e) => { if (e.key === 'Escape') { W.query = ''; applyHighlight(); requestRender(); } });
  const board = document.getElementById('board');
  board?.addEventListener('pointerover', (e) => {
    const t = e.target.closest('.tile[data-app]');
    const b = t ? W.city?.byId.get(Number(t.dataset.app)) : null;
    if (b !== W.tileHover) { W.tileHover = b || null; applyHighlight(); requestRender(); }
  });
  board?.addEventListener('pointerleave', () => { if (W.tileHover) { W.tileHover = null; applyHighlight(); requestRender(); } });
}
function pickAt(e) {
  const r = canvas.getBoundingClientRect();
  W.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  W.ray.setFromCamera(W.ndc, W.camera);
  const hits = W.ray.intersectObjects(W.pickables, false);
  return hits[0]?.object.userData.ref || null;
}
function hoverAt(e) {
  const ref = pickAt(e);
  setHover(ref, e);
}
function setHover(ref, e) {
  const same = ref && W.hover && ref.type === W.hover.type && (ref.b || ref.d) === (W.hover.b || W.hover.d);
  if (!same) { W.hover = ref; applyHighlight(); requestRender(); }
  canvas.classList.toggle('pointing', !!ref);
  if (ref && e) showTip(ref, e.clientX, e.clientY, false); else if (!W.selected) hideTip();
}
function select(ref) {
  W.selected = ref;
  applyHighlight(); requestRender();
  if (!ref) return hideTip();
  const p = refScreen(ref);
  showTip(ref, p.x, p.y, true);
}
function refScreen(ref) {
  const v = W.v;
  if (ref.type === 'app') v.set(ref.b.x, ref.b.h + 1.1, ref.b.z);
  else if (ref.type === 'pc') v.set(0, 3.4, 0);
  else v.copy(ref.d.g.position).add(W.v2.set(0, 0.4, 0));
  v.project(W.camera);
  const r = canvas.getBoundingClientRect();
  return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
}
function tipHtml(ref, touch) {
  const esc = HL.esc;
  if (ref.type === 'app') {
    const { app, cat } = ref.b;
    const st = statusOf(app), s = HL.state.status?.[app.id];
    const detail = st === 'up' && s?.ms != null ? ` · ${s.ms} ms` : st === 'down' && s ? ` · ${esc(s.error || s.code || '')}` : '';
    return `<div class="tip-ico">${HL.iconHtml(app.icon, app.name)}</div><div class="tip-body">
      <b>${esc(app.name)}</b><span class="tip-cat">${esc(cat.name)}</span>
      <span class="tip-st ${st}"><i></i>${ST_TEXT[st]}${detail}</span>
      ${app.description ? `<span class="tip-desc">${esc(app.description)}</span>` : ''}
      ${touch ? `<a class="btn small primary" data-open href="#">Ouvrir ↗</a>` : ''}</div>`;
  }
  if (ref.type === 'pc') {
    const s = HL.state.system;
    const mem = s ? Math.round((100 * (s.memory.total - s.memory.free)) / s.memory.total) : 0;
    return `<div class="tip-ico"><span>🖥️</span></div><div class="tip-body"><b>${esc(s?.hostname || 'Mon PC')}</b><span class="tip-cat">Beelink GTi14 · dock EX</span>
      ${s ? `<span class="tip-st up"><i></i>Processeur ${s.cpu.usage} % · mémoire ${mem} %</span>` : ''}
      <span class="tip-desc">Anneau cyan : processeur · anneau violet : mémoire.${touch ? '' : ' Clic : le Moniteur.'}</span></div>`;
  }
  const p = ref.d.p;
  const when = p.online ? 'En ligne' : p.lastSeen && !p.lastSeen.startsWith('0001') ? `Vu ${HL.timeAgo(Date.parse(p.lastSeen))}` : 'Hors ligne';
  return `<div class="tip-ico"><span>${/ios|android/i.test(p.os || '') ? '📱' : '💻'}</span></div><div class="tip-body"><b>${esc(p.name)}</b><span class="tip-cat">Appareil Tailscale</span>
    <span class="tip-st ${p.online ? 'up' : 'idle'}"><i></i>${when}</span>${p.online ? '' : '<span class="tip-desc">Posé sur sa piste en attendant de revenir.</span>'}</div>`;
}
function showTip(ref, cx, cy, touch) {
  tipEl.innerHTML = tipHtml(ref, touch);
  tipEl.hidden = false;
  const hr = hero.getBoundingClientRect();
  const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  let x = cx - hr.left + 16, y = cy - hr.top + 16;
  if (touch) { x = cx - hr.left - w / 2; y = cy - hr.top - h - 10; }
  if (x + w > hr.width - 8) x = cx - hr.left - w - 16;
  x = clamp(x, 8, Math.max(8, hr.width - w - 8));
  if (y + h > hr.height - 8) y = cy - hr.top - h - 12;
  y = clamp(y, 8, Math.max(8, hr.height - h - 8));
  tipEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}
function hideTip() { tipEl.hidden = true; }
function openApp(app) {
  const href = HL.appHref(app);
  if (app.new_tab) window.open(href, '_blank', 'noopener,noreferrer'); else location.href = href;
}
function doneHint() {
  if (!hintEl || hintEl.hidden) return;
  hintEl.classList.add('gone');
  try { localStorage.setItem('hl_island_hint', '1'); } catch {}
}

// ---------- Boucle d'animation ----------
function resize() {
  const w = hero.clientWidth, h = hero.clientHeight;
  if (!w || !h) return;
  W.cw = w; W.ch = h;
  W.renderer.setSize(w, h, false);
  const cam = W.camera, aspect = w / h, wide = aspect > 1.45;
  cam.aspect = aspect;
  cam.fov = wide ? 30 : 33;
  const half = Math.tan((cam.fov * Math.PI) / 360);
  const useW = wide ? 0.6 : 0.96;
  W.ctl.dist = Math.max((wide ? 12.2 : 10.8) / (half * aspect * useW), (wide ? 8.9 : 8.1) / half);
  cam.clearViewOffset();
  if (wide) cam.setViewOffset(w, h, -w * 0.14, h * 0.035, w, h);
  else cam.setViewOffset(w, h, 0, -h * 0.035, w, h);
  cam.updateProjectionMatrix();
  W.backdrop.material.uniforms.aspect.value = aspect;
  requestRender();
}
function shouldRun() { return W && W.visible && !document.hidden && !REDUCE.matches; }
function schedule() {
  if (!W) return;
  if (shouldRun()) { if (!W.running) { W.running = true; W.last = performance.now(); W.raf = requestAnimationFrame(loop); } }
  else { stop(); requestRender(); }
}
function stop() { if (W) { W.running = false; cancelAnimationFrame(W.raf); } }
let pending = 0;
function requestRender() {
  if (!W || W.running || pending || document.hidden) return;
  pending = requestAnimationFrame(() => { pending = 0; step(0); W.renderer.render(W.scene, W.camera); });
}
function loop(now) {
  if (!W.running) return;
  W.raf = requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - W.last) / 1000);
  // 30 images/s sur téléphone et quand on ne touche à rien, 60 pendant qu'on manipule l'île
  const busy = W.ctl.drag || Math.abs(W.ctl.vel) > 0.02 || W.hover || W.ctl.idle < 1.5;
  if ((W.small || !busy) && dt < 1 / 34) return;
  W.last = now;
  step(dt);
  W.renderer.render(W.scene, W.camera);
}
function step(dt) {
  const c = W.ctl, t = (W.clock += dt);
  // Caméra : inertie puis rotation lente quand on ne touche à rien
  if (!c.drag) {
    c.theta += c.vel * dt;
    c.vel *= Math.exp(-dt * 2.6);
    c.idle += dt;
    if (c.idle > 3 && !REDUCE.matches && !W.hover && !W.selected) c.theta += dt * 0.05 * smooth(3, 6, c.idle);
  }
  const cam = W.camera, tgt = W.v2.set(0, -0.35, 0);
  cam.position.set(tgt.x + c.dist * Math.cos(c.phi) * Math.sin(c.theta), tgt.y + c.dist * Math.sin(c.phi), tgt.z + c.dist * Math.cos(c.phi) * Math.cos(c.theta));
  cam.lookAt(tgt);
  cam.updateMatrixWorld();

  // Soleil et lune dessinés sur le fond, selon leur direction par rapport à la caméra
  const k = W.sky, u = W.backdrop.material.uniforms;
  if (k) {
    const camAz = Math.atan2(cam.position.x, cam.position.z); // direction de la caméra vue du centre
    const place = (dir, amt, pos) => {
      const az = Math.atan2(dir[0], dir[2]);
      const rel = angDiff(az, camAz + Math.PI); // 0 = droit devant
      const front = Math.cos(rel);
      pos.set(0.5 - Math.sin(rel) * 0.55 * (W.camera.aspect > 1.45 ? 0.8 : 1), 0.42 + clamp(Math.asin(dir[1]) / 0.9, -0.2, 0.55));
      return amt * smooth(0.05, 0.45, front);
    };
    u.sunAmt.value = place(dirFrom(Math.max(k.alt * Math.PI / 180, -0.2), k.az), smooth(-5, 2, k.alt) * (1 - k.gray * 0.7), u.sunPos.value);
    u.moonAmt.value = place(k.moonDir, k.night * (1 - k.w.cover * 0.6), u.moonPos.value);
  }

  // Ombres : recalculées seulement si quelque chose de fixe a changé
  if (W.dirtyShadow) { W.renderer.shadowMap.needsUpdate = true; W.dirtyShadow = false; }

  // Épingles : flottent, grossissent au survol, s'effacent hors recherche
  if (W.city) {
    for (const b of W.city.buildings) {
      b.scale = dt ? lerp(b.scale, b.target, 1 - Math.exp(-dt * 10)) : b.target;
      const ps = (W.small ? 1.1 : 1.12) * b.scale;
      b.pin.scale.set(ps, ps, 1);
      const bob = REDUCE.matches ? 0 : Math.sin(t * 1.6 + b.phase) * 0.06;
      b.pin.position.y = b.h + 0.1 + bob;
      b.pin.material.opacity = dt ? lerp(b.pin.material.opacity, b.dim, 1 - Math.exp(-dt * 8)) : b.dim;
      b.halo.position.y = b.h + 0.1 + bob + ps * 0.42;
      if (b.st === 'down') { const p = 0.5 + 0.5 * Math.sin(t * 4 + b.phase); b.halo.material.opacity = (0.45 + 0.55 * p) * b.dim; b.halo.scale.setScalar(1.4 + p * 0.7); }
      else b.halo.material.opacity = (b.st === 'up' ? 0.3 : 0) * b.dim;
      const on = b.target > 1.05;
      b.ring.material.opacity = dt ? lerp(b.ring.material.opacity, on ? 0.75 + 0.25 * Math.sin(t * 5) : 0, 1 - Math.exp(-dt * 10)) : on ? 0.85 : 0;
    }
    // Paquets lumineux sur les liaisons des services en ligne
    const pa = W.packets.geometry.attributes.position;
    W.packetData.forEach((p, i) => {
      if (p.b.st !== 'up' || p.b.dim < 1) { pa.setXYZ(i, 0, -50, 0); return; }
      p.t = (p.t + dt * p.sp) % 1;
      arcPoint(p.b, p.t, W.v);
      pa.setXYZ(i, W.v.x, W.v.y, W.v.z);
    });
    pa.needsUpdate = true;
    // Étiquettes des quartiers
    const r = { width: W.cw || 1, height: W.ch || 1 }, dc = cam.position.length();
    W.city.cats.forEach((cc, i) => {
      const el = W.labelEls[i];
      if (!el) return;
      const rr = R * rimK(cc.mid) + 0.9;
      W.v.set(Math.cos(cc.mid) * rr, -0.15, Math.sin(cc.mid) * rr);
      const d = W.v.distanceTo(cam.position);
      W.v.project(cam);
      const op = clamp((dc - d + 3) / 6, 0, 1);
      if (!W.labelW[i]) W.labelW[i] = el.offsetWidth;
      const lw = (W.labelW[i] || 90) / 2 + 8;
      const lx = clamp(((W.v.x + 1) / 2) * r.width, lw, r.width - lw), ly = clamp(((1 - W.v.y) / 2) * r.height, 18, r.height - (W.small ? 64 : 58));
      el.style.transform = `translate(${lx.toFixed(1)}px, ${ly.toFixed(1)}px) translate(-50%, -50%)`;
      el.style.opacity = op.toFixed(2);
      el.style.pointerEvents = op > 0.5 ? 'auto' : 'none';
    });
  }

  // PC : ventilateurs, voyant qui bat au rythme du processeur, anneaux CPU/RAM
  const s = W.sys;
  s.cpuShown = lerp(s.cpuShown, s.cpu, 1 - Math.exp(-dt * 3));
  s.memShown = lerp(s.memShown, s.mem, 1 - Math.exp(-dt * 3));
  for (const f of W.fans) f.rotation.y -= dt * (2 + s.cpuShown * 14);
  W.cpuRing.material.uniforms.fill.value = Math.max(0.02, s.cpuShown);
  W.memRing.material.uniforms.fill.value = Math.max(0.02, s.memShown);
  W.cpuRing.material.uniforms.time.value = t; W.memRing.material.uniforms.time.value = t;
  W.cpuRing.rotation.z = t * 0.25; W.memRing.rotation.z = -t * 0.18;
  W.pcLed.emissiveIntensity = 1.6 + Math.sin(t * (2 + s.cpuShown * 8)) * (0.5 + s.cpuShown);
  W.pcHalo.material.opacity = 0.35 + 0.15 * Math.sin(t * 2);

  // Drones
  for (const d of W.drones) {
    if (d.p.online) {
      d.a += dt * d.sp;
      d.g.position.set(Math.cos(d.a) * d.orbit, d.h + Math.sin(t * 1.3 + d.ph) * 0.25, Math.sin(d.a) * d.orbit);
      d.g.rotation.y = -d.a;
      d.g.rotation.z = Math.sin(t * 1.1 + d.ph) * 0.08;
      for (const r of d.rotors) r.rotation.y += dt * 40;
    }
  }
  // Rochers flottants, nuages, cascade
  if (!REDUCE.matches) {
    for (const m of W.rocks) { m.position.y = m.userData.y + Math.sin(t * m.userData.sp + m.userData.ph) * 0.25; m.rotation.y += dt * 0.1; }
    W.fall.userData.tex.offset.y += dt * 0.9;
  }
  for (const cl of W.clouds) {
    if (!cl.visible) continue;
    const d = cl.userData;
    d.a += dt * d.sp;
    cl.position.set(Math.cos(d.a) * d.r, d.y, Math.sin(d.a) * d.r);
    cl.rotation.y = -d.a;
  }
  // Pluie, neige, orage
  if (W.rain.visible) {
    const p = W.rain.geometry.attributes.position, wind = (W.sky?.w.wind || 8) * 0.01;
    W.rainData.forEach((r, i) => {
      r.y -= r.v * dt;
      if (r.y < -9) { r.y = 13 + Math.random() * 3; }
      p.setXYZ(i * 2, r.x, r.y, r.z);
      p.setXYZ(i * 2 + 1, r.x + wind * 4, r.y - 0.42, r.z);
    });
    p.needsUpdate = true;
  }
  if (W.snow.visible) {
    const p = W.snow.geometry.attributes.position;
    W.snowData.forEach((f, i) => {
      f.y -= f.v * dt;
      if (f.y < -9) f.y = 13;
      p.setXYZ(i, f.x + Math.sin(t * 0.8 + f.ph) * 0.4, f.y, f.z + Math.cos(t * 0.6 + f.ph) * 0.4);
    });
    p.needsUpdate = true;
  }
  if (W.sky?.w.storm) {
    W.nextFlash -= dt;
    if (W.nextFlash < 0) { W.flash = 1; W.nextFlash = 4 + Math.random() * 8; }
  }
  W.flash = Math.max(0, W.flash - dt * 4);
  u.flash.value = W.flash * 0.6;
  W.hemi.intensity = (W.sky?.hemiI ?? 1.2) + W.flash * 1.5;
}

// ---------- Branchements ----------
document.addEventListener('hl:board', () => {
  if (!W) return start();
  W.sky && updateSky();
  if (signature() !== W.boardSig) rebuildCity(); else updateStatus();
  requestRender();
});
document.addEventListener('hl:status', () => { if (W) { updateStatus(); requestRender(); } });
document.addEventListener('hl:system', () => { if (W) { updateSystem(); requestRender(); } });
document.addEventListener('hl:devices', () => { if (W) { updateDrones(); requestRender(); } });
document.addEventListener('hl:weather', () => { if (W) { updateSky(); requestRender(); } else if (HL.state.board) paintCssSky(); });
document.addEventListener('hl:accent', () => { if (W) { W.pcLed.emissive.set(accentHex()); W.beam.material.color.set(accentHex()); W.plazaRing.material.color.set(accentHex()); W.city?.buildings.forEach((b) => b.ring.material.color.set(accentHex())); W.cpuRing.material.uniforms.color.value.set(...rgb(accentHex())); recolorArcs(); requestRender(); } });

if (hero && canvas && HL) {
  try { if (localStorage.getItem('hl_island_hint')) hintEl?.classList.add('gone'); } catch {}
  if (HL.state.board) start();
}
