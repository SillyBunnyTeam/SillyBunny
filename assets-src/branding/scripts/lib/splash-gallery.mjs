const PREVIEW_URL = '../splash/scene/';
const MASTER_URL = '../splash/masters/';

const CSS = `
body{margin:0;font:15px/1.45 system-ui,sans-serif;background:#222226;color:#eee} body.light{background:#ebebed;color:#222} main{padding:16px 20px 60px}
header{position:sticky;top:0;z-index:2;background:inherit;padding:10px 20px;border-bottom:1px solid #8884;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
h2{margin:26px 0 4px;font-size:16px} h3{margin:0 0 6px;font-size:13px;font-weight:600;opacity:.8} p.note{margin:0 0 8px;font-size:13px;opacity:.75}
.row{display:flex;gap:28px;flex-wrap:wrap;align-items:flex-start} .card{display:inline-block;padding:12px;border-radius:12px;background:linear-gradient(#b99bf233,#b99bf20d)} canvas{display:block;image-rendering:pixelated}
.strip{display:flex;gap:14px;flex-wrap:wrap;margin:10px 0 0} .strip figure{margin:0;font-size:12px;max-width:520px} .strip canvas{background:#8a8a99;margin-top:2px}
.timeline{font:12px/1.4 ui-monospace,monospace;opacity:.8;margin:6px 0 0}
label{font-size:13px} input[type=range]{vertical-align:middle;width:110px} select,button{font:inherit;padding:3px 10px;border-radius:8px;border:1px solid #8886;background:transparent;color:inherit;cursor:pointer}
`;

// The script is a plain string; the only data it is given are the lines that set MODEL and VERSION.
const SCRIPT = String.raw`
const D = devicePixelRatio, PAD = 26;
document.getElementById('dpr').textContent = D;
const $ = (id) => document.getElementById(id), zoom = $('zoom'), effectsOn = $('effects'), speed = $('speed');
speed.oninput = () => { $('speedv').textContent = speed.value; };
const load = (src) => new Promise((resolve) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => resolve(null); image.src = src + '?v=' + VERSION; });
const sizers = [];
zoom.onchange = () => { for (const resize of sizers) resize(); };
const scaleFor = (width, wanted) => (zoom.value === 'auto' ? Math.max(1, Math.floor(wanted * D / width)) : +zoom.value);

const frameAt = (keys, seconds, time) => { const t = ((time % seconds) + seconds) % seconds; let shown = keys[0]; for (const key of keys) if (key.at <= t) shown = key; return shown.frame; };
const startOf = (keys, frame) => keys.find((key) => key.frame === frame).at;

// Pixel effects, drawn on the art pixel grid so they are as coarse as the characters.
const CLOVER = ['.G.G.', 'GGGGG', '.GGG.', 'GGGGG', '.G.G.', '..S..', '..S..'];
const colourOf = { G: '#5fcf6a', S: '#2c9a4a' };
function sprite(ctx, rows, x, y) { rows.forEach((row, dy) => [...row].forEach((c, dx) => { if (colourOf[c]) { ctx.fillStyle = colourOf[c]; ctx.fillRect(x + dx, y + dy, 1, 1); } })); }
function ringArc(ctx, cx, cy, radius, alpha) {
  ctx.fillStyle = 'rgba(255,255,255,' + alpha + ')';
  const steps = Math.max(12, Math.round(radius * 3));
  for (let i = 0; i <= steps; i++) { const a = -0.95 + (1.9 * i) / steps; const x = Math.round(cx + radius * Math.cos(a)), y = Math.round(cy + radius * Math.sin(a)); ctx.fillRect(x, y, 1, 1); ctx.fillRect(x + 1, y, 1, 1); }
  ctx.fillStyle = 'rgba(185,155,242,' + alpha + ')';
  for (let i = 0; i <= steps; i++) { const a = -0.95 + (1.9 * i) / steps; const x = Math.round(cx + (radius + 2) * Math.cos(a)), y = Math.round(cy + (radius + 2) * Math.sin(a)); ctx.fillRect(x, y, 1, 1); }
}
function drawRings(ctx, cx, cy, since) {
  for (let i = 0; i < 3; i++) { const age = since - i * 0.22; if (age < 0 || age > 0.8) continue; const p = age / 0.8; ringArc(ctx, cx, cy, 5 + 30 * p, p < 0.5 ? 1 : p < 0.8 ? 0.6 : 0.3); }
}
const BURST = [[-22, -34, 0], [-9, -46, 1], [6, -40, 0], [20, -30, 1], [28, -16, 0]];
function drawBurst(ctx, cx, cy, since) {
  if (since < 0 || since > 0.9) return;
  BURST.forEach(([vx, vy]) => { const t = since; const x = cx + vx * t, y = cy + vy * t + 55 * t * t; if (t < 0.75) sprite(ctx, CLOVER, Math.round(x) - 2, Math.round(y) - 3); });
  const twinkle = Math.floor(since * 14) % 2;
  [[-14, -18], [12, -22], [24, -8], [-26, -4], [2, -30], [16, 4]].forEach(([dx, dy], i) => {
    const age = since - i * 0.04; if (age < 0 || age > 0.5) return; const big = (Math.floor(age * 14) + i) % 2 === twinkle;
    ctx.fillStyle = '#fff6b0'; ctx.fillRect(cx + dx, cy + dy, 1, 1); ctx.fillRect(cx + dx - 1, cy + dy, 3, 1); ctx.fillRect(cx + dx, cy + dy - 1, 1, 3);
    if (big) { ctx.fillStyle = '#ffffff'; ctx.fillRect(cx + dx - 2, cy + dy, 5, 1); ctx.fillRect(cx + dx, cy + dy - 2, 1, 5); }
  });
}
const SQUASH_SECONDS = 0.14;
function drawLayer(ctx, layer, images, pose, x, y, squash) {
  const image = images[pose]; if (!image) return;
  if (!squash) { ctx.drawImage(image, x, y); return; }
  const waist = Math.round(layer.height * 0.55);
  ctx.drawImage(image, 0, 0, layer.width, waist, x, y + 1, layer.width, waist);
  ctx.drawImage(image, 0, waist, layer.width, layer.height - waist, x, y + waist, layer.width, layer.height - waist);
}

async function loadLayer(layer) {
  const images = {};
  for (const [pose, file] of Object.entries(layer.frames)) images[pose] = await load(SCENE_URL + file);
  return { layer, images };
}

// A view is a canvas that plays one timeline: for each character a pose list, and where its effect starts in the loop.
function makeView({ title, note, width, height, offsets, seconds, plays, wanted }) {
  const main = $('m'), heading = document.createElement('h2'), explain = document.createElement('p'), card = document.createElement('div'), canvas = document.createElement('canvas'), line = document.createElement('div');
  heading.textContent = title; explain.className = 'note'; explain.textContent = note; card.className = 'card'; line.className = 'timeline';
  canvas.width = width + 2 * PAD; canvas.height = height + 2 * PAD; card.append(canvas); main.append(heading, explain, card, line);
  const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false;
  const resize = () => { const k = scaleFor(canvas.width, wanted); canvas.style.width = (canvas.width * k / D) + 'px'; canvas.style.height = (canvas.height * k / D) + 'px'; };
  sizers.push(resize);
  line.textContent = plays.map((play) => play.id + ': ' + play.keys.map((key) => key.at.toFixed(2) + ' ' + key.frame).join(', ')).join('   |   ') + '   |   loop ' + seconds + ' s';
  const onScreen = { value: false }; new IntersectionObserver(([entry]) => { onScreen.value = entry.isIntersecting; }).observe(card);
  return (time) => {
    if (!onScreen.value) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const drawn = [];
    for (const play of plays) {
      const pose = frameAt(play.keys, seconds, time), t = ((time % seconds) + seconds) % seconds;
      const start = startOf(play.keys, play.effectFrame), since = t - start;
      const squash = play.squash && pose === play.effectFrame && since >= 0 && since < SQUASH_SECONDS;
      drawLayer(ctx, play.layer, play.images, pose, PAD + play.layer.left - offsets.x, PAD + play.layer.top - offsets.y, squash);
      drawn.push({ play, since: since < 0 ? since + seconds : since, t });
    }
    if (effectsOn.checked) for (const { play, since } of drawn) {
      const cx = PAD + play.layer.left - offsets.x + Math.round(play.layer.width * play.at.x), cy = PAD + play.layer.top - offsets.y + Math.round(play.layer.height * play.at.y);
      if (play.effect === 'rings') drawRings(ctx, cx, cy, since); else drawBurst(ctx, cx, cy, since);
    }
  };
}

function strip(title, loaded) {
  const main = $('m'), heading = document.createElement('h2'), row = document.createElement('div'); heading.textContent = title; row.className = 'strip'; main.append(heading, row);
  for (const { layer, images } of loaded) for (const [pose, image] of Object.entries(images)) {
    const figure = document.createElement('figure'), canvas = document.createElement('canvas'), caption = document.createElement('figcaption'), note = INFO[layer.id + '/' + pose];
    canvas.width = layer.width; canvas.height = layer.height; canvas.getContext('2d').drawImage(image, 0, 0);
    caption.textContent = layer.id + ' ' + pose + (note ? ': ' + note : ' (the base snap)');
    figure.append(caption, canvas); row.append(figure);
    sizers.push(() => { const k = scaleFor(layer.width, 240); canvas.style.width = (layer.width * k / D) + 'px'; canvas.style.height = (layer.height * k / D) + 'px'; });
  }
}

(async () => {
  const loaded = {}; for (const layer of MODEL.layers) loaded[layer.id] = await loadLayer(layer);
  const T = MODEL.timelines, parts = (id, keys) => ({ id, keys, effectFrame: T[id].effect.frame, layer: loaded[id].layer, images: loaded[id].images, at: T[id].effect.at, effect: id === 'reisen' ? 'rings' : 'burst', squash: id === 'tewi' });
  const views = [];
  const solo = (id) => ({ x: loaded[id].layer.left, y: loaded[id].layer.top });
  for (const id of ['reisen', 'tewi']) {
    const l = loaded[id].layer;
    views.push(makeView({ title: id === 'reisen' ? 'Reisen alone' : 'Tewi alone', note: id === 'reisen' ? 'idle (the raised megaphone), the call with the mouth open and three rings, back.' : 'raised, mid-swing, strike (a 1 art pixel squash, clovers and sparkles), mid-swing, raised.', width: l.width, height: l.height, offsets: solo(id), seconds: T[id].seconds, wanted: 620, plays: [parts(id, T[id].keys)] }));
  }
  views.push(makeView({ title: 'Both', note: 'the call lands on the strike. The characters are laid out on the scene grid as the layer manifest has them.', width: MODEL.grid.width, height: MODEL.grid.height, offsets: { x: 0, y: 0 }, seconds: T.both.seconds, wanted: 1050, plays: ['reisen', 'tewi'].map((id) => parts(id, T.both[id])) }));
  strip('Every frame at its own size', Object.values(loaded));
  for (const resize of sizers) resize();
  const frame = (ms) => { const time = (ms / 1000) * +speed.value; for (const draw of views) draw(time); requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
})();
`;

/**
 * The page that plays the splash loops: Reisen alone, Tewi alone and both on one clock (her call lands on her strike), at whole screen pixels, with
 * pixel effects (rings from the megaphone, clovers and sparkles from the strike) drawn by the page as placeholders, and every frame enlarged below with
 * what it changed from its base.
 * @param {{ manifest: object, frames: { id: string, name: string, base: string, changed: number, box: object, cut: number }[], version: number }} request
 * `manifest` is the layout file of the scene; `frames` say what each frame changed
 * @returns {string} the page
 */
export function renderSplashGallery({ manifest, frames, version }) {
    const info = Object.fromEntries(frames.map(({ name, base, changed, box }) => [`${base}/${name}`, `${changed} art px changed in ${box.width}x${box.height} at ${box.x},${box.y}`]));
    const model = { grid: manifest.grid, layers: manifest.layers, timelines: manifest.timelines };
    const json = (value) => JSON.stringify(value).replaceAll('<', '\\u003c');
    return `<!doctype html><html><head><meta charset="utf-8"><title>Splash animation frames</title><style>${CSS}</style></head><body>
<header><b>Splash animation</b><span style="opacity:.75">whole screen pixels, placeholder effects. DPR <b id="dpr"></b></span><span style="flex:1"></span>
<label>Speed <input id="speed" type="range" min="0.25" max="2" step="0.25" value="1"> <b id="speedv">1</b>x</label>
<label>Zoom <select id="zoom"><option value="auto">fit</option><option value="2">2x</option><option value="3">3x</option><option value="4">4x</option><option value="5">5x</option></select></label>
<label><input id="effects" type="checkbox" checked> effects</label>
<button onclick="document.body.classList.toggle('light')">Light/Dark</button></header><main id="m"></main>
<script>const MODEL = ${json(model)}, INFO = ${json(info)}, VERSION = ${json(version)}, SCENE_URL = ${json(PREVIEW_URL)}, MASTER_URL = ${json(MASTER_URL)};${SCRIPT}</script></body></html>
`;
}
