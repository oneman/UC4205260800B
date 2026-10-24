// Run with: node --test htdocs/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as uc from '../uc.js';
import { cartRuntime } from '../cart-runtime.js';

const here = new URL('.', import.meta.url);

test('geometry matches the README', () => {
  assert.equal(uc.W * uc.H * 3 * uc.FRAMES, uc.BYTES);
  assert.equal(uc.W4K * uc.H4K * 3 * uc.FRAMES4K, uc.BYTES);
  assert.equal(uc.MOSAIC_W * uc.MOSAIC_H * 3, uc.BYTES);
  assert.equal(uc.PAGE * uc.PAGES, uc.BYTES);
  assert.equal(2 ** 32 - uc.BYTES, 89706496);
  assert.equal(uc.frameName(0), 'aa');
  assert.equal(uc.frameName(675), 'zz');
  assert.equal(uc.frameIndex('bb'), 27);
  assert.equal(uc.parseAddr('ab:10,20'), 6336030);
  assert.equal(uc.parseAddr('p2'), 8192);
  assert.equal(uc.where(4201066496).frameName, 'zz');
});

test('memory reads back and zero writes allocate nothing', () => {
  const inst = new uc.Instance();
  inst.write(100, new Uint8Array(5000));
  assert.equal(inst.frames.filter(Boolean).length, 0);
  const data = Uint8Array.from({ length: 9000 }, (_, i) => (i * 7 + 1) & 255);
  inst.write(uc.FRAME_BYTES - 4000, data);           // straddles frames aa and ab
  assert.deepEqual(inst.read(uc.FRAME_BYTES - 4000, 9000), data);
  assert.equal(inst.pagesInUse(), 3);
  assert.throws(() => inst.write(uc.BYTES - 1, new Uint8Array(2)));
});

async function roundTrip(fmt) {
  const inst = new uc.Instance();
  const msg = new TextEncoder().encode('Hello Super Intelligence World!');
  inst.write(0, msg);
  inst.write(uc.BYTES - msg.length, msg);
  inst.write(7 * uc.FRAME_BYTES - 2, msg);
  const zip = await inst.save(fmt);
  const back = await uc.Instance.load(zip);
  assert.equal(back.format, fmt);
  for (const a of [0, uc.BYTES - msg.length, 7 * uc.FRAME_BYTES - 2]) assert.deepEqual(back.read(a, msg.length), msg);
}
test('HD zip round trip', () => roundTrip('hd'));
test('4K zip round trip', () => roundTrip('4k'));

// Encode with every PNG filter type to exercise the decoder.
function filteredPng(rgb, w, h) {
  const stride = w * 3, raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const f = y % 5, cur = rgb.subarray(y * stride, (y + 1) * stride);
    const prev = y ? rgb.subarray((y - 1) * stride, y * stride) : new Uint8Array(stride);
    raw[y * (stride + 1)] = f;
    for (let i = 0; i < stride; i++) {
      const a = i >= 3 ? cur[i - 3] : 0, b = prev[i], c = i >= 3 ? prev[i - 3] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      raw[y * (stride + 1) + 1 + i] = (cur[i] - pred) & 255;
    }
  }
  return raw;
}

test('PNG decoder handles all filter types', async () => {
  const w = 33, h = 17, rgb = Uint8Array.from({ length: w * h * 3 }, (_, i) => (i * i * 31 + i) & 255);
  const png = await uc.pngEncode(rgb, w, h);
  assert.deepEqual(await uc.pngDecode(png, w, h), rgb);
  // swap in a filtered IDAT
  const idat = await uc.deflate(filteredPng(rgb, w, h));
  const sig = png.subarray(0, 8 + 25);
  const chunk = (type, data) => {
    const c = new Uint8Array(12 + data.length), v = new DataView(c.buffer);
    v.setUint32(0, data.length);
    c.set(new TextEncoder().encode(type), 4);
    c.set(data, 8);
    v.setUint32(8 + data.length, uc.crc32(c.subarray(4, 8 + data.length)));
    return c;
  };
  const parts = [sig, chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const filtered = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { filtered.set(p, o); o += p.length; }
  assert.deepEqual(await uc.pngDecode(filtered, w, h), rgb);
});

test('objects embed, scan and verify', () => {
  const inst = new uc.Instance();
  const p = inst.embed('note', 'text/plain', 'plain text payload\n');
  assert.equal(p, uc.OBJ_AREA_PAGE);
  const q = inst.embed('cart', uc.CART_TYPE, 'function tick() {}', { frames: 'ab' });
  assert.equal(q, uc.OBJ_AREA_PAGE + 1);
  assert.throws(() => inst.embed('x', 'text/plain', 'x', { page: p }));
  const objs = inst.objects();
  assert.deepEqual(objs.map((o) => [o.name, o.crcOk, o.frames]), [['note', true, ''], ['cart', true, 'ab']]);
  assert.equal(new TextDecoder().decode(inst.payload(objs[0])), 'plain text payload\n');
  inst.write(objs[0].payloadAddr, new Uint8Array([80]));
  assert.equal(inst.objects()[0].crcOk, false);
});

test('tick log is a ring of damage records', () => {
  const inst = new uc.Instance();
  assert.equal(inst.tickHeader(), null);
  inst.logTick(1, [{ frame: 2, x: 0, y: 64, w: 128, h: 64 }]);
  inst.logTick(2, [{ frame: 3, x: 1, y: 2, w: 3, h: 4 }, { frame: 4, x: 5, y: 6, w: 7, h: 8 }]);
  assert.deepEqual(inst.tickHeader(), { tick: 2, total: 3, capacity: uc.TICK_CAP });
  assert.deepEqual(inst.tickRecords(2), [{ tick: 2, frame: 3, x: 1, y: 2, w: 3, h: 4 }, { tick: 2, frame: 4, x: 5, y: 6, w: 7, h: 8 }]);
});

test('demo instance loads with its carts', async () => {
  const inst = await uc.Instance.load(readFileSync(new URL('../demo.zip', here)));
  const names = inst.objects().map((o) => o.name);
  assert.deepEqual(names, ['README.md', 'SPEC.md', 'life', 'skirmish']);
  assert.ok(inst.objects().every((o) => o.crcOk));
});

// Run a cart through the real runtime with stand-ins for the iframe globals.
function runCart(file, ticks, input = () => ({})) {
  let handler = null;
  const out = [];
  globalThis.window = { addEventListener: (_t, fn) => { handler = fn; } };
  globalThis.parent = { postMessage: (m) => out.push(m) };
  cartRuntime();
  const frame = new Uint8Array(uc.FRAME_BYTES);
  handler({ data: { type: 'init', source: readFileSync(new URL(`../carts/${file}`, here), 'utf8'),
    frames: [{ name: 'ad', index: 3, data: frame.buffer }] } });
  for (let t = 1; t <= ticks; t++) {
    const i = input(t);
    handler({ data: { type: 'tick', t, input: { keys: [], pressed: i.pressed || [], clicks: i.clicks || [] } } });
  }
  delete globalThis.window;
  delete globalThis.parent;
  return out;
}

for (const cart of ['life.js', 'skirmish.js']) {
  test(`${cart} runs and reports damage`, () => {
    const out = runCart(cart, 120, (t) => (t === 5 ? { pressed: ['a'] } : t === 6 ? { clicks: [{ x: 1700, y: 540, button: 2 }] } : {}));
    assert.deepEqual(out.filter((m) => m.type === 'error'), []);
    assert.equal(out[0].type, 'ready');
    assert.ok(out[0].rects.length > 0, 'init draws something');
    assert.equal(out.filter((m) => m.type === 'damage').length, 120);
    for (const m of out) {
      const bytes = m.rects.reduce((n, r) => n + r.w * r.h * 3, 0);
      assert.equal(new Uint8Array(m.data).length, bytes);
      for (const r of m.rects) assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= uc.W && r.y + r.h <= uc.H);
    }
  });
}
