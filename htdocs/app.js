// app.js - the UC4205260800B workbench: view, navigate, compare, draw on and
// drive an instance. The page is the outer system; it ticks the carts along.
import * as uc from './uc.js';
import { cartRuntime } from './cart-runtime.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view'), ctx = canvas.getContext('2d');

let inst = new uc.Instance();
let other = null;                       // second instance for Compare
let fileName = 'instance';
let mode = 'view';
let view = { x: 0, y: 0, scale: 1 };    // mosaic pixel at the canvas top-left, mosaic px per screen px
let hover = null, inspect = 0;
let drawn = -1, dirty = true;
let cart = null;

// ---- view ----------------------------------------------------------------------

function resize() {
  const r = canvas.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  dirty = true;
}

function fitRect(x, y, w, h) {
  view.scale = Math.max(w / canvas.width, h / canvas.height) * 1.04;
  view.x = x + w / 2 - (canvas.width * view.scale) / 2;
  view.y = y + h / 2 - (canvas.height * view.scale) / 2;
  dirty = true;
}
const fitAll = () => fitRect(0, 0, uc.MOSAIC_W, uc.MOSAIC_H);
const fitFrame = (f) => fitRect((f % uc.GRID) * uc.W, Math.floor(f / uc.GRID) * uc.H, uc.W, uc.H);

function render() {
  const cw = canvas.width, ch = canvas.height;
  const img = ctx.createImageData(cw, ch), px = new Uint32Array(img.data.buffer);
  const colF = new Int32Array(cw), colX = new Int32Array(cw);
  for (let sx = 0; sx < cw; sx++) {
    const X = Math.floor(view.x + sx * view.scale);
    colF[sx] = X >= 0 && X < uc.MOSAIC_W ? Math.floor(X / uc.W) : -1;
    colX[sx] = (X - colF[sx] * uc.W) * 3;
  }
  const outside = 0xff1a1410, empty = 0xff000000;
  const frames = inst.frames, others = other && other.frames;
  for (let sy = 0; sy < ch; sy++) {
    const Y = Math.floor(view.y + sy * view.scale), row = sy * cw;
    if (Y < 0 || Y >= uc.MOSAIC_H) { px.fill(outside, row, row + cw); continue; }
    const fy = Math.floor(Y / uc.H), base = (Y - fy * uc.H) * uc.W * 3;
    for (let sx = 0; sx < cw; sx++) {
      const fx = colF[sx];
      if (fx < 0) { px[row + sx] = outside; continue; }
      const f = fy * uc.GRID + fx, d = frames[f], o = base + colX[sx];
      let r = 0, g = 0, b = 0;
      if (d) { r = d[o]; g = d[o + 1]; b = d[o + 2]; }
      if (others) {
        const e = others[f];
        const r2 = e ? e[o] : 0, g2 = e ? e[o + 1] : 0, b2 = e ? e[o + 2] : 0;
        if (r !== r2 || g !== g2 || b !== b2) { r = 255; g = 0; b = 255; } else { r >>= 2; g >>= 2; b >>= 2; }
      }
      px[row + sx] = d || others ? 0xff000000 | (b << 16) | (g << 8) | r : empty;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Frame grid and names, once frames are big enough on screen to read.
  const tile = uc.W / view.scale;
  if (tile > 24) {
    ctx.strokeStyle = 'rgba(108,182,255,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const left = -view.x / view.scale, top = -view.y / view.scale;
    const right = left + uc.MOSAIC_W / view.scale, bottom = top + uc.MOSAIC_H / view.scale;
    for (let c = 0; c <= uc.GRID; c++) {
      const sx = Math.round(left + (c * uc.W) / view.scale) + 0.5;
      if (sx >= 0 && sx <= cw) { ctx.moveTo(sx, top); ctx.lineTo(sx, bottom); }
      const sy = Math.round(top + (c * uc.H) / view.scale) + 0.5;
      if (sy >= 0 && sy <= ch) { ctx.moveTo(left, sy); ctx.lineTo(right, sy); }
    }
    ctx.stroke();
    if (tile > 60) {
      ctx.font = `${Math.min(16, Math.max(9, tile / 10)) * (canvas.width / canvas.clientWidth)}px ui-monospace, monospace`;
      ctx.fillStyle = 'rgba(108,182,255,0.8)';
      for (let f = 0; f < uc.FRAMES; f++) {
        const sx = ((f % uc.GRID) * uc.W - view.x) / view.scale, sy = (Math.floor(f / uc.GRID) * uc.H - view.y) / view.scale;
        if (sx > -tile && sx < cw && sy > -tile && sy < ch) ctx.fillText(uc.frameName(f), sx + 4, sy + 14);
      }
    }
  }
}

function loop() {
  if (dirty || drawn !== inst.version) {
    render();
    drawn = inst.version;
    dirty = false;
  }
  requestAnimationFrame(loop);
}

// ---- panels ----------------------------------------------------------------------

const kv = (el, pairs) => { el.innerHTML = pairs.map(([k, v]) => `<span>${k}</span><span>${v}</span>`).join(''); };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

function hexdump(addr) {
  const a = Math.max(0, Math.min(uc.BYTES - 256, addr - (addr % 16))), d = inst.read(a, 256), lines = [];
  for (let i = 0; i < 256; i += 16) {
    const row = d.subarray(i, i + 16);
    lines.push(`${(a + i).toString(16).padStart(9, '0')} ${[...row].map((b) => b.toString(16).padStart(2, '0')).join(' ')} ` +
      [...row].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join(''));
  }
  return lines.join('\n');
}

function showInspector() {
  const w = uc.where(inspect), [r, g, b] = inst.getPixel(w.frame, w.x, w.y);
  kv($('where'), [
    ['address', `${w.addr} (0x${w.addr.toString(16)})`], ['page', `${w.page} + ${w.pageOffset}`],
    ['frame', `${w.frameName} (#${w.frame}) ${w.x},${w.y}`], ['mosaic', `${w.mosaicX},${w.mosaicY}`],
    ['pixel', `<span style="display:inline-block;width:10px;height:10px;background:rgb(${r},${g},${b});vertical-align:middle"></span> ${r},${g},${b}`],
  ]);
  $('hex').textContent = hexdump(inspect);
}

function showStats() {
  let frames = 0;
  for (let f = 0; f < uc.FRAMES; f++) frames += inst.frames[f] ? 1 : 0;
  const pairs = [['file', esc(fileName)], ['saved as', inst.format === 'hd' ? 'HD (aa..zz.png)' : '4K (1..169.png)'],
    ['frames', `${frames} of ${uc.FRAMES} in use`], ['pages', `${inst.pagesInUse()} of ${uc.PAGES}`]];
  if (other) {
    let diff = 0, fd = 0;
    for (let f = 0; f < uc.FRAMES; f++) {
      const a = inst.frames[f], b = other.frames[f];
      if (!a && !b) continue;
      let n = 0;
      for (let i = 0; i < uc.FRAME_BYTES; i++) if ((a ? a[i] : 0) !== (b ? b[i] : 0)) n++;
      diff += n; fd += n ? 1 : 0;
    }
    pairs.push(['compare', `${diff} bytes differ in ${fd} frames <button id="uncompare">done</button>`]);
  }
  kv($('stats'), pairs);
  if (other) $('uncompare').onclick = () => { other = null; $('compare').classList.remove('on'); dirty = true; showStats(); };
}

function showObjects() {
  const objs = inst.objects();
  $('objects').innerHTML = objs.length ? '' : '<div class="t">No embedded objects.</div>';
  for (const o of objs) {
    const div = document.createElement('div');
    div.className = 'obj';
    div.innerHTML = `<b>${esc(o.name)}</b> <span class="t">p${o.page} · ${o.length} bytes${o.crcOk ? '' : ' · <span class="bad">CRC mismatch</span>'}</span>
      <div class="t">${esc(o.type)}${o.frames ? ` · frames ${esc(o.frames)}` : ''}</div>
      <div class="row"></div>`;
    const row = div.querySelector('.row');
    const btn = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; row.append(b); };
    if (o.type === uc.CART_TYPE) btn('Run', () => runCart(o));
    btn('Read', () => openModal(o.name, new TextDecoder().decode(inst.payload(o))));
    btn('Go to', () => { inspect = o.page * uc.PAGE; fitFrame(uc.where(inspect).frame); showInspector(); });
    btn('Download', () => download(inst.payload(o), o.name));
    $('objects').append(div);
  }
}

function showTicks() {
  const h = inst.tickHeader();
  $('ticks').textContent = !h ? 'No tick log yet. Run a cart.' :
    `tick ${h.tick}, ${h.total} damage records\n` + inst.tickRecords(12).reverse()
      .map((r) => `t${String(r.tick).padEnd(7)} ${uc.frameName(r.frame)} ${r.x},${r.y} ${r.w}x${r.h}`).join('\n');
}

function refreshAll() { showStats(); showObjects(); showTicks(); showInspector(); dirty = true; }

function openModal(title, text) {
  $('modalTitle').textContent = title;
  $('modalBody').textContent = text;
  $('modal').classList.add('open');
}
$('modalClose').onclick = () => $('modal').classList.remove('open');

function download(data, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data]));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function status(text) { $('status').textContent = text; }

// ---- loading and saving -------------------------------------------------------------

async function openInstance(buf, name) {
  status(`Loading ${name}…`);
  try {
    stopCart();
    inst = await uc.Instance.load(buf);
    fileName = name;
    fitAll();
    refreshAll();
    status(`Loaded ${name}.`);
  } catch (e) {
    status(`Could not load ${name}: ${e.message}`);
  }
}

$('open').onclick = () => $('file').click();
$('file').onchange = async (e) => {
  const f = e.target.files[0];
  if (f) await openInstance(await f.arrayBuffer(), f.name);
  e.target.value = '';
};
$('demo').onclick = async () => {
  try {
    const r = await fetch('demo.zip');
    if (!r.ok) throw new Error(r.statusText);
    await openInstance(await r.arrayBuffer(), 'demo.zip');
  } catch (e) {
    status(`Could not fetch demo.zip (${e.message}). Serve htdocs/ over http, e.g. python3 -m http.server -d htdocs`);
  }
};
$('new').onclick = () => { stopCart(); inst = new uc.Instance(); fileName = 'instance'; fitAll(); refreshAll(); };
async function save(fmt) {
  status('Encoding PNGs…');
  // Hold the cart still so the saved frames and tick log are one consistent snapshot.
  const wasPaused = cart ? cart.paused : true;
  if (cart) cart.paused = true;
  while (cart && cart.busy) await new Promise((r) => setTimeout(r, 5));
  let data;
  try { data = await inst.save(fmt); } finally { if (cart) cart.paused = wasPaused; }
  download(data, `${fileName.replace(/\.zip$/, '')}-${fmt}.zip`);
  status(`Saved ${data.length} bytes as ${fmt.toUpperCase()} zip.`);
}
$('saveHd').onclick = () => save('hd');
$('save4k').onclick = () => save('4k');

$('compare').onclick = () => $('file2').click();
$('file2').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    other = await uc.Instance.load(await f.arrayBuffer());
    $('compare').classList.add('on');
    status(`Comparing with ${f.name}: magenta pixels differ.`);
    showStats();
    dirty = true;
  } catch (err) { status(`Could not load ${f.name}: ${err.message}`); }
};

window.addEventListener('dragover', (e) => { e.preventDefault(); $('drop').classList.add('on'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) $('drop').classList.remove('on'); });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  $('drop').classList.remove('on');
  const f = e.dataTransfer.files[0];
  if (f) await openInstance(await f.arrayBuffer(), f.name);
});

$('embedFile').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const asCart = $('asCart').checked;
    const type = asCart ? uc.CART_TYPE : f.type || 'application/octet-stream';
    const page = inst.embed(f.name, type, new Uint8Array(await f.arrayBuffer()),
      { frames: asCart ? $('cartFrames').value.trim() : '' });
    status(`Embedded ${f.name} at page ${page}.`);
    refreshAll();
  } catch (err) { status(`Embed failed: ${err.message}`); }
};
$('embed').onclick = () => $('embedFile').click();

$('pokeBtn').onclick = () => {
  const data = new TextEncoder().encode($('poke').value);
  try { inst.write(inspect, data); status(`Wrote ${data.length} bytes at ${inspect}.`); refreshAll(); } catch (e) { status(e.message); }
};

$('goto').onkeydown = (e) => {
  if (e.key !== 'Enter') return;
  const v = e.target.value.trim();
  try {
    if (/^[a-z]{2}$/.test(v)) { fitFrame(uc.frameIndex(v)); inspect = uc.addr(...uc.frameOrigin(uc.frameIndex(v))); }
    else {
      inspect = uc.parseAddr(v);
      const w = uc.where(inspect);
      fitRect(w.mosaicX - 48, w.mosaicY - 27, 96, 54);
    }
    showInspector();
  } catch (err) { status(err.message); }
};
$('fit').onclick = fitAll;

// ---- modes and mouse ----------------------------------------------------------------

function setMode(m) {
  mode = m;
  for (const [id, v] of [['modeView', 'view'], ['modeDraw', 'draw'], ['modePlay', 'play']]) $(id).classList.toggle('on', v === m);
  canvas.classList.toggle('pan', m === 'view');
}
$('modeView').onclick = () => setMode('view');
$('modeDraw').onclick = () => setMode('draw');
$('modePlay').onclick = () => setMode('play');

function toMosaic(e) {
  const r = canvas.getBoundingClientRect(), k = canvas.width / r.width;
  return [Math.floor(view.x + (e.clientX - r.left) * k * view.scale), Math.floor(view.y + (e.clientY - r.top) * k * view.scale)];
}
const inMosaic = (X, Y) => X >= 0 && Y >= 0 && X < uc.MOSAIC_W && Y < uc.MOSAIC_H;

function paint(X, Y) {
  const size = Math.max(1, Number($('brush').value) || 1), c = $('color').value;
  const r = parseInt(c.slice(1, 3), 16), g = parseInt(c.slice(3, 5), 16), b = parseInt(c.slice(5, 7), 16);
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      const x = X + dx - (size >> 1), y = Y + dy - (size >> 1);
      if (!inMosaic(x, y)) continue;
      const [f, lx, ly] = uc.Instance.mosaic(x, y);
      inst.setPixel(f, lx, ly, r, g, b);
    }
  }
}

let drag = null;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mousedown', (e) => {
  const [X, Y] = toMosaic(e);
  const pan = e.button === 1 || e.shiftKey && mode !== 'play' || (mode === 'view' && e.button === 0);
  drag = { pan, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, X, Y, moved: false };
  if (!pan && mode === 'draw' && e.button === 0) paint(X, Y);
  if (!pan && mode === 'play' && cart && inMosaic(X, Y)) {
    const [f, x, y] = uc.Instance.mosaic(X, Y);
    if (cart.frames.includes(f)) cart.input.clicks.push({ frame: f, x, y, button: e.button, shift: e.shiftKey });
  }
});
window.addEventListener('mousemove', (e) => {
  if (e.target === canvas) {
    const [X, Y] = toMosaic(e);
    if (inMosaic(X, Y)) {
      const [f, x, y] = uc.Instance.mosaic(X, Y);
      hover = uc.addr(X, Y);
      const w = uc.where(hover), [r, g, b] = inst.getPixel(f, x, y);
      status(`${w.frameName} ${x},${y}  mosaic ${X},${Y}  addr ${hover} (0x${hover.toString(16)})  page ${w.page}+${w.pageOffset}  rgb ${r},${g},${b}`);
    }
  }
  if (!drag) return;
  const k = canvas.width / canvas.getBoundingClientRect().width;
  if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3) drag.moved = true;
  if (drag.pan) {
    view.x = drag.vx - (e.clientX - drag.sx) * k * view.scale;
    view.y = drag.vy - (e.clientY - drag.sy) * k * view.scale;
    dirty = true;
  } else if (mode === 'draw') {
    const [X, Y] = toMosaic(e), n = Math.max(Math.abs(X - drag.X), Math.abs(Y - drag.Y));
    for (let i = 1; i <= n; i++) paint(Math.round(drag.X + ((X - drag.X) * i) / n), Math.round(drag.Y + ((Y - drag.Y) * i) / n));
    drag.X = X; drag.Y = Y;
  }
});
window.addEventListener('mouseup', () => {
  if (drag && !drag.moved && mode === 'view' && inMosaic(drag.X, drag.Y)) {
    inspect = uc.addr(drag.X, drag.Y);
    showInspector();
  }
  if (drag && mode === 'draw' && !drag.pan) showStats();
  drag = null;
});
canvas.addEventListener('dblclick', (e) => {
  if (mode === 'play') return;
  const [X, Y] = toMosaic(e);
  if (inMosaic(X, Y)) fitFrame(uc.Instance.mosaic(X, Y)[0]);
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect(), k = canvas.width / r.width;
  const sx = (e.clientX - r.left) * k, sy = (e.clientY - r.top) * k;
  const mx = view.x + sx * view.scale, my = view.y + sy * view.scale;
  view.scale = Math.min(64, Math.max(1 / 32, view.scale * Math.exp(e.deltaY * 0.0015)));
  view.x = mx - sx * view.scale;
  view.y = my - sy * view.scale;
  dirty = true;
}, { passive: false });

// ---- carts --------------------------------------------------------------------------

// Each cart runs in a sandboxed iframe with no access to this page. The host
// hands it copies of its frames and copies back only the tiles it changed.
function runCart(obj) {
  stopCart();
  const names = obj.frames.split(',').map((s) => s.trim()).filter(Boolean);
  let frames;
  try { frames = names.map(uc.frameIndex); } catch (e) { status(`${obj.name}: ${e.message}`); return; }
  if (!frames.length) { status(`${obj.name} has no frames: header`); return; }
  const iframe = document.createElement('iframe');
  iframe.sandbox = 'allow-scripts';
  iframe.style.display = 'none';
  iframe.srcdoc = `<!doctype html><script>(${cartRuntime.toString()})()<\/script>`;
  document.body.append(iframe);
  const startTick = (inst.tickHeader() || { tick: 0 }).tick;
  cart = { obj, frames, iframe, t: startTick, busy: true, paused: false, timer: 0, ticks: 0,
    input: { keys: new Set(), pressed: new Set(), clicks: [] } };
  const c = cart;
  c.onmessage = (ev) => {
    if (ev.source !== iframe.contentWindow) return;
    const m = ev.data;
    if (m.type === 'log') console.log(`[${obj.name}]`, m.text);
    else if (m.type === 'error') { status(`${obj.name} crashed: ${m.message.split('\n')[0]}`); console.error(m.message); stopCart(); }
    else if (m.type === 'ready' || m.type === 'damage') {
      applyDamage(m.rects, new Uint8Array(m.data), m.type === 'ready' ? c.t : m.t);
      c.busy = false;
      if (m.type === 'ready') status(`${obj.name} running on ${names.join(', ')}. Press Play to send it mouse and keys.`);
    }
  };
  window.addEventListener('message', c.onmessage);
  iframe.onload = () => {
    iframe.contentWindow.postMessage({
      type: 'init', source: new TextDecoder().decode(inst.payload(obj)),
      frames: frames.map((f, i) => ({ name: names[i], index: f, data: (inst.frames[f] || new Uint8Array(uc.FRAME_BYTES)).slice().buffer })),
    }, '*');
  };
  fitFrame(frames[0]);
  setMode('play');
  scheduleTicks();
  showCart();
}

function applyDamage(rects, data, t) {
  let o = 0;
  for (const r of rects) {
    const fr = inst.frame(r.frame, true);
    for (let y = 0; y < r.h; y++) {
      fr.set(data.subarray(o, o + r.w * 3), ((r.y + y) * uc.W + r.x) * 3);
      o += r.w * 3;
    }
  }
  if (rects.length) inst.logTick(t, rects);
  inst.version++;
}

function sendTick() {
  const c = cart;
  if (!c || c.busy) return;
  c.busy = true;
  c.t++;
  c.ticks++;
  c.iframe.contentWindow.postMessage({ type: 'tick', t: c.t, input: { keys: [...c.input.keys], pressed: [...c.input.pressed], clicks: c.input.clicks } }, '*');
  c.input.pressed.clear();
  c.input.clicks = [];
}

function scheduleTicks() {
  if (!cart) return;
  clearInterval(cart.timer);
  cart.timer = setInterval(() => { if (!cart.paused) sendTick(); }, 1000 / Math.max(1, Number($('tps').value) || 30));
}

function stopCart() {
  if (!cart) return;
  clearInterval(cart.timer);
  window.removeEventListener('message', cart.onmessage);
  cart.iframe.remove();
  cart = null;
  showCart();
  showTicks();
  showObjects();
}

function showCart() {
  if (!cart) { kv($('cartInfo'), [['cart', 'none running']]); return; }
  kv($('cartInfo'), [['cart', esc(cart.obj.name)], ['frames', cart.frames.map(uc.frameName).join(', ')],
    ['tick', `${cart.t}${cart.paused ? ' (paused)' : ''}`], ['run', `${cart.ticks} ticks this run`]]);
}

$('cartPause').onclick = () => { if (cart) { cart.paused = !cart.paused; showCart(); } };
$('cartStep').onclick = () => { if (cart) { cart.paused = true; sendTick(); showCart(); } };
$('cartStop').onclick = stopCart;
$('tps').onchange = scheduleTicks;

window.addEventListener('keydown', (e) => {
  if (!cart || mode !== 'play' || e.target.matches('input, textarea')) return;
  cart.input.keys.add(e.key);
  if (!e.repeat) cart.input.pressed.add(e.key);
  if (e.key === ' ' || e.key.startsWith('Arrow')) e.preventDefault();
});
window.addEventListener('keyup', (e) => { if (cart) cart.input.keys.delete(e.key); });

setInterval(() => { if (cart) { showCart(); showTicks(); } }, 500);

// ---- start ---------------------------------------------------------------------------

new ResizeObserver(resize).observe(canvas);
resize();
fitAll();
refreshAll();
showCart();
requestAnimationFrame(loop);
if (location.protocol.startsWith('http')) $('demo').click();
