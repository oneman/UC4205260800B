// cart-runtime.js - runs inside the sandboxed cart iframe (SPEC.md section 5).
// The host turns cartRuntime into source text with toString(), so it must not
// refer to anything outside its own body.

export function cartRuntime() {
  const W = 1920, H = 1080, TILE = 64, TW = Math.ceil(W / TILE), TH = Math.ceil(H / TILE);

  // 5x7 font, ASCII 32..90, five column bytes per glyph, bit 0 is the top row.
  const FONT = (
    '0000000000' + '00005f0000' + '0007000700' + '147f147f14' + '242a7f2a12' + '2313086462' + '3649552250' +
    '0005030000' + '001c224100' + '0041221c00' + '082a1c2a08' + '08083e0808' + '0050300000' + '0808080808' +
    '0060600000' + '2010080402' + '3e5149453e' + '00427f4000' + '4261514946' + '2141454b31' + '1814127f10' +
    '2745454539' + '3c4a494930' + '0171090503' + '3649494936' + '064949291e' + '0036360000' + '0056360000' +
    '0008142241' + '1414141414' + '4122140800' + '0201510906' + '324979413e' + '7e1111117e' + '7f49494936' +
    '3e41414122' + '7f4141221c' + '7f49494941' + '7f09090101' + '3e41415132' + '7f0808087f' + '00417f4100' +
    '2040413f01' + '7f08142241' + '7f40404040' + '7f0204027f' + '7f0408107f' + '3e4141413e' + '7f09090906' +
    '3e4151215e' + '7f09192946' + '4649494931' + '01017f0101' + '3f4040403f' + '1f2040201f' + '7f2018207f' +
    '6314081463' + '0304780403' + '6151494543');

  function glyph(ch) {
    let c = ch.toUpperCase().charCodeAt(0);
    if (c < 32 || c > 90) c = 63;
    const o = (c - 32) * 10, cols = [];
    for (let i = 0; i < 5; i++) cols.push(parseInt(FONT.substr(o + i * 2, 2), 16));
    return cols;
  }

  class Surface {
    constructor(name, index, data) {
      this.name = name; this.index = index; this.data = data; this.w = W; this.h = H;
      this.dirty = new Uint8Array(TW * TH);
    }
    touch(x, y, w, h) {
      const x0 = Math.max(0, Math.floor(x / TILE)), y0 = Math.max(0, Math.floor(y / TILE));
      const x1 = Math.min(TW - 1, Math.floor((x + w - 1) / TILE)), y1 = Math.min(TH - 1, Math.floor((y + h - 1) / TILE));
      for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) this.dirty[ty * TW + tx] = 1;
    }
    get(x, y) {
      if (x < 0 || y < 0 || x >= W || y >= H) return [0, 0, 0];
      const o = (y * W + x) * 3, d = this.data;
      return [d[o], d[o + 1], d[o + 2]];
    }
    set(x, y, r, g, b) {
      x |= 0; y |= 0;
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const o = (y * W + x) * 3, d = this.data;
      d[o] = r; d[o + 1] = g; d[o + 2] = b;
      this.dirty[((y / TILE) | 0) * TW + ((x / TILE) | 0)] = 1;
    }
    fill(x, y, w, h, r, g, b) {
      x |= 0; y |= 0; w |= 0; h |= 0;
      const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(W, x + w), y1 = Math.min(H, y + h);
      if (x1 <= x0 || y1 <= y0) return;
      const d = this.data;
      for (let yy = y0; yy < y1; yy++) {
        for (let o = (yy * W + x0) * 3, e = (yy * W + x1) * 3; o < e; o += 3) { d[o] = r; d[o + 1] = g; d[o + 2] = b; }
      }
      this.touch(x0, y0, x1 - x0, y1 - y0);
    }
    clear(r = 0, g = 0, b = 0) { this.fill(0, 0, W, H, r, g, b); }
    text(x, y, str, scale = 1, r = 255, g = 255, b = 255) {
      for (const ch of String(str)) {
        const cols = glyph(ch);
        for (let cx = 0; cx < 5; cx++) {
          for (let cy = 0; cy < 7; cy++) if (cols[cx] >> cy & 1) this.fill(x + cx * scale, y + cy * scale, scale, scale, r, g, b);
        }
        x += 6 * scale;
      }
      return x;
    }
  }

  let cart = null, surfaces = [], byName = {};
  const uc = {
    W, H,
    frame: (name) => byName[name] || surfaces[0],
    get frames() { return surfaces; },
    log: (...a) => parent.postMessage({ type: 'log', text: a.join(' ') }, '*'),
  };

  // Collect dirty tiles, merging horizontal runs into one rectangle each.
  function collect() {
    const rects = [], chunks = [];
    let size = 0;
    for (const s of surfaces) {
      for (let ty = 0; ty < TH; ty++) {
        for (let tx = 0; tx < TW; tx++) {
          if (!s.dirty[ty * TW + tx]) continue;
          let end = tx;
          while (end + 1 < TW && s.dirty[ty * TW + end + 1]) end++;
          const x = tx * TILE, y = ty * TILE, w = Math.min(W, (end + 1) * TILE) - x, h = Math.min(H, y + TILE) - y;
          const buf = new Uint8Array(w * h * 3);
          for (let r = 0; r < h; r++) buf.set(s.data.subarray(((y + r) * W + x) * 3, ((y + r) * W + x + w) * 3), r * w * 3);
          rects.push({ frame: s.index, x, y, w, h });
          chunks.push(buf);
          size += buf.length;
          tx = end;
        }
      }
      s.dirty.fill(0);
    }
    const data = new Uint8Array(size);
    let o = 0;
    for (const c of chunks) { data.set(c, o); o += c.length; }
    return { rects, data };
  }

  function fail(e) { parent.postMessage({ type: 'error', message: String(e && e.stack || e) }, '*'); }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    try {
      if (m.type === 'init') {
        surfaces = m.frames.map((f) => new Surface(f.name, f.index, new Uint8Array(f.data)));
        byName = Object.fromEntries(surfaces.map((s) => [s.name, s]));
        cart = new Function('uc', m.source +
          '\n;return { init: typeof init === "function" ? init : null, tick: typeof tick === "function" ? tick : null };')(uc);
        if (cart.init) cart.init(uc);
        const out = collect();
        parent.postMessage({ type: 'ready', ...out }, '*', [out.data.buffer]);
      } else if (m.type === 'tick') {
        const input = { keys: new Set(m.input.keys), pressed: new Set(m.input.pressed), clicks: m.input.clicks };
        if (cart.tick) cart.tick(uc, m.t, input);
        const out = collect();
        parent.postMessage({ type: 'damage', t: m.t, ...out }, '*', [out.data.buffer]);
      }
    } catch (e) { fail(e); }
  });
}
