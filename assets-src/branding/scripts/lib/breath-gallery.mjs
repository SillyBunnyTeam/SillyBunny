const TITLES = {
    'hero-duo': 'Home banner, day',
    'hero-duo-night': 'Home banner, night',
    'welcome-both': 'Welcome picture',
};

const PREVIEW_URL = '../breath/';
const APPROVED_URL = '../../';

/**
 * What the page needs of one scene or still: its size, its backdrop, and for each layer its placement, waist row and the address of every pose
 * picture. The centre pose of a single still is the approved still itself, so it has no file of its own.
 */
function pageModel({ id, width, height, backdrop, layers }) {
    return {
        id,
        title: TITLES[id] ?? id,
        width,
        height,
        single: layers.length === 1 && layers[0].left === 0 && layers[0].top === 0 && layers[0].width === width,
        backdrop: backdrop ? `${PREVIEW_URL}${backdrop.file}` : null,
        layers: [...layers].sort((a, b) => a.z - b.z || a.order - b.order).map((layer) => {
            const images = Object.fromEntries([...layer.files].map(([pose, byVariant]) => [pose, Object.fromEntries(Object.entries(byVariant).map(([variant, file]) => [variant, `${PREVIEW_URL}${file}`]))]));
            images.c ??= Object.fromEntries(Object.entries(layer.stills).map(([variant, file]) => [variant, `${APPROVED_URL}${file}`]));
            return { id: layer.id, left: layer.left, top: layer.top, width: layer.width, height: layer.height, waist: layer.waist, images };
        }),
    };
}

const CSS = `
body{margin:0;font:15px/1.45 system-ui,sans-serif;background:#222226;color:#eee} body.light{background:#ebebed;color:#222} main{padding:16px 20px 60px}
header{position:sticky;top:0;z-index:2;background:inherit;padding:10px 20px;border-bottom:1px solid #8884;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
h2{margin:26px 0 6px;font-size:16px} h3{margin:0 0 6px;font-size:13px;font-weight:600;opacity:.8}
.pair{display:flex;gap:28px;flex-wrap:wrap;align-items:flex-start} .card{display:inline-block;padding:12px;border-radius:12px;background:linear-gradient(#b99bf233,#b99bf20d)} canvas{display:block;image-rendering:pixelated}
.seams{display:flex;gap:14px;flex-wrap:wrap;margin:12px 0 0} .seams figure{margin:0;font-size:12px} .seams canvas{background:#8a8a99;margin-top:2px}
label{font-size:13px} input[type=range]{vertical-align:middle;width:110px} select,button{font:inherit;padding:3px 10px;border-radius:8px;border:1px solid #8886;background:transparent;color:inherit;cursor:pointer}
`;

// The page's script is a plain string, not a template of the data, so nothing in it is built from the data except the lines that set SCENES, RHYTHM and VERSION.
const SCRIPT = String.raw`
const D = devicePixelRatio, SEAM_ROWS = 24;
document.getElementById('dpr').textContent = D;
const $ = (id) => document.getElementById(id), per = $('per'), zoom = $('zoom'), blinkOn = $('blink');
per.value = RHYTHM.cycleSeconds; $('perv').textContent = per.value; per.oninput = () => $('perv').textContent = per.value;
const load = (src) => new Promise((resolve) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => resolve(null); image.src = src + '?v=' + VERSION; });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sizeOf = (scene) => (zoom.value === 'auto' ? Math.max(1, Math.floor((scene.single ? 380 : 520) * D / scene.width)) : +zoom.value);
const sizers = [];
zoom.onchange = () => { for (const resize of sizers) resize(); };

async function build(scene) {
  const main = $('m'), title = document.createElement('h2'); title.textContent = scene.title; main.append(title);
  const pair = document.createElement('div'); pair.className = 'pair'; main.append(pair);
  const loaded = [];
  for (const layer of scene.layers) {
    const images = {};
    for (const [pose, byVariant] of Object.entries(layer.images)) { images[pose] = {}; for (const [variant, url] of Object.entries(byVariant)) images[pose][variant] = await load(url); }
    loaded.push({ layer, images, cur: 'base', busy: false, phase: loaded.length * 1.7 });
  }
  const backdrop = scene.backdrop ? await load(scene.backdrop) : null;
  const contexts = [];
  for (const heading of ['Row slices', 'Pre-rendered frames']) {
    const card = document.createElement('div'), label = document.createElement('h3'), canvas = document.createElement('canvas');
    label.textContent = heading; card.className = 'card'; card.append(label, canvas); pair.append(card);
    canvas.width = scene.width + 8; canvas.height = scene.height + 2; const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false; contexts.push(ctx);
    sizers.push(() => { const k = sizeOf(scene); canvas.style.width = (canvas.width * k / D) + 'px'; canvas.style.height = (canvas.height * k / D) + 'px'; });
  }
  const seams = document.createElement('div'); seams.className = 'seams'; main.append(seams);
  for (const one of loaded) {
    const top = Math.max(0, one.layer.waist - SEAM_ROWS), rows = Math.min(one.layer.height, one.layer.waist + SEAM_ROWS) - top;
    for (const pose of ['c', 'b']) {
      const figure = document.createElement('figure'), canvas = document.createElement('canvas'), caption = document.createElement('figcaption');
      canvas.width = one.layer.width; canvas.height = rows; canvas.getContext('2d').drawImage(one.images[pose].base, 0, top, one.layer.width, rows, 0, 0, one.layer.width, rows);
      caption.textContent = one.layer.id + ', ' + (pose === 'c' ? 'neutral' : 'breath') + ', rows ' + top + ' to ' + (top + rows - 1) + ' (the waist is row ' + one.layer.waist + ')';
      figure.append(caption, canvas); seams.append(figure);
      sizers.push(() => { const k = zoom.value === 'auto' ? 2 : +zoom.value; canvas.style.width = (canvas.width * k / D) + 'px'; canvas.style.height = (canvas.height * k / D) + 'px'; });
    }
  }
  const blink = async (one) => {
    if (one.busy || !blinkOn.checked || !one.images.c.half) return;
    one.busy = true;
    for (const [variant, ms] of [['half', 70], ['closed', 110], ['half', 70], ['base', 0]]) { one.cur = one.images.c[variant] ? variant : 'half'; await sleep(ms); }
    one.busy = false;
  };
  for (const one of loaded) { const again = () => { blink(one); setTimeout(again, 3600 + Math.random() * 1800); }; setTimeout(again, 1000 + one.phase * 1000); }
  const [slices, frames] = contexts;
  const onScreen = { value: false };
  new IntersectionObserver(([entry]) => { onScreen.value = entry.isIntersecting; }).observe(pair);
  const clear = (ctx) => { ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height); if (backdrop) ctx.drawImage(backdrop, 4, 0); };
  function draw(t) {
    if (!onScreen.value) return;
    clear(slices); clear(frames);
    for (const one of loaded) {
      const { layer } = one, variant = one.images.c[one.cur] ? one.cur : 'base';
      const breaths = (t / (+per.value * 1000)) * RHYTHM.breathsPerCycle + one.phase / (2 * Math.PI);
      const down = (((breaths % 1) + 1) % 1) < 0.5 ? 1 : 0;
      const source = one.images.c[variant];
      for (let y = 0; y < layer.height; y++) slices.drawImage(source, 0, y, layer.width, 1, 4 + layer.left, layer.top + y + (y < layer.waist ? down : 0), layer.width, 1);
      const set = one.images[down ? 'b' : 'c'];
      frames.drawImage(set[variant] ?? set.base, 4 + layer.left, layer.top);
    }
  }
  return draw;
}

(async () => {
  const draws = [];
  for (const scene of SCENES) draws.push(await build(scene));
  for (const resize of sizers) resize();
  const frame = (t) => { for (const draw of draws) draw(t); requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
})();
`;

/**
 * The page that plays the breathing: for each scene or still, row slices (each row above the waist drawn one row lower)
 * beside the pre-rendered neutral and breath pictures, on one clock and one blink schedule, a breath being neutral for half of its time
 * and one row down for the other half. Under each scene, the rows around each figure's waist of both poses, enlarged, to judge the seam by.
 * @param {{ models: Parameters<typeof pageModel>[0][], rhythm: { cycleSeconds: number, breathsPerCycle: number }, version: number }} request `models` are the scenes and stills `runBreath` planned; `version` is added to every picture's address so a rerun is not served from the browser's cache
 * @returns {string} the page
 */
export function renderBreathGallery({ models, rhythm, version }) {
    const data = JSON.stringify(models.map(pageModel)).replaceAll('<', '\\u003c');
    return `<!doctype html><html><head><meta charset="utf-8"><title>Breathing: pre-rendered frames</title><style>${CSS}</style></head><body>
<header><b>Breathing</b><span style="opacity:.75">left: row slices, each row above the waist drawn one lower; right: the pre-rendered frames, with blinks. DPR <b id="dpr"></b></span><span style="flex:1"></span>
<label>Cycle <input id="per" type="range" min="1.5" max="6" step="0.5" value="3.5"> <b id="perv">3.5</b> s</label>
<label>Zoom <select id="zoom"><option value="auto">fit</option><option value="2">2x</option><option value="3">3x</option><option value="4">4x</option></select></label>
<label><input id="blink" type="checkbox" checked> blinks</label>
<button onclick="document.body.classList.toggle('light')">Light/Dark</button></header><main id="m"></main>
<script>const SCENES = ${data}, RHYTHM = ${JSON.stringify(rhythm)}, VERSION = ${JSON.stringify(version)};${SCRIPT}</script></body></html>
`;
}
