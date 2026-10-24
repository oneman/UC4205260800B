// uc.js - UC4205260800B instance library for browsers and Node (ES module).
// Memory, PNG and zip codecs, embedded objects and the tick log. See SPEC.md.

export const BYTES = 4205260800;
export const PAGE = 4096;
export const PAGES = 1026675;
export const W = 1920, H = 1080;
export const FRAME_BYTES = W * H * 3;
export const FRAMES = 676;
export const GRID = 26;
export const W4K = 3840, H4K = 2160;
export const FRAME4K_BYTES = W4K * H4K * 3;
export const FRAMES4K = 169;
export const MOSAIC_W = W * GRID, MOSAIC_H = H * GRID;
export const OBJ_AREA_PAGE = 987188;
export const TICK_PAGE = 1025651;
export const TICK_CAP = 261888;
export const CART_TYPE = 'application/x-uc-cart+javascript';

export const frameName = (i) => String.fromCharCode(97 + Math.floor(i / GRID), 97 + (i % GRID));

export function frameIndex(name) {
  if (!/^[a-z]{2}$/.test(name)) throw new Error(`bad frame name ${name} (aa..zz)`);
  return (name.charCodeAt(0) - 97) * GRID + name.charCodeAt(1) - 97;
}

// Decimal, 0x hex, pN (page N) or FRAME:X,Y.
export function parseAddr(s) {
  s = s.trim();
  let m;
  if ((m = /^p(\d+)$/.exec(s))) return Number(m[1]) * PAGE;
  if ((m = /^([a-z]{2}):(\d+),(\d+)$/.exec(s))) {
    return frameIndex(m[1]) * FRAME_BYTES + (Number(m[3]) * W + Number(m[2])) * 3;
  }
  const a = Number(s);
  if (!Number.isInteger(a) || a < 0 || a >= BYTES) throw new Error(`bad address ${s}`);
  return a;
}

// Describe an address the same way `uc where` does.
export function where(a) {
  const frame = Math.floor(a / FRAME_BYTES), off = a % FRAME_BYTES, px = Math.floor(off / 3);
  const x = px % W, y = Math.floor(px / W);
  return {
    addr: a, page: Math.floor(a / PAGE), pageOffset: a % PAGE, frame, frameName: frameName(frame),
    x, y, channel: 'RGB'[off % 3], mosaicX: (frame % GRID) * W + x, mosaicY: Math.floor(frame / GRID) * H + y,
  };
}

// ---- CRC-32 -----------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data, crc = 0) {
  crc = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 255] ^ (crc >>> 8);
  return ~crc >>> 0;
}

// ---- streams ------------------------------------------------------------------

async function pipe(data, stream) {
  const out = new Response(new Blob([data]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
export const inflate = (d) => pipe(d, new DecompressionStream('deflate'));
export const inflateRaw = (d) => pipe(d, new DecompressionStream('deflate-raw'));
export const deflate = (d) => pipe(d, new CompressionStream('deflate'));

// ---- PNG ----------------------------------------------------------------------

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const be32 = (d, p) => ((d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]) >>> 0;

function pngChunk(type, data) {
  const c = new Uint8Array(12 + data.length), v = new DataView(c.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) c[4 + i] = type.charCodeAt(i);
  c.set(data, 8);
  v.setUint32(8 + data.length, crc32(c.subarray(4, 8 + data.length)));
  return c;
}

export async function pngEncode(rgb, w, h) {
  const stride = w * 3, raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const ihdr = new Uint8Array(13), v = new DataView(ihdr.buffer);
  v.setUint32(0, w); v.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 2;
  return concat([new Uint8Array(PNG_SIG), pngChunk('IHDR', ihdr),
    pngChunk('IDAT', await deflate(raw)), pngChunk('IEND', new Uint8Array(0))]);
}

// Decode an 8-bit RGB or RGBA PNG into RGB bytes (alpha is dropped).
export async function pngDecode(png, wantW, wantH) {
  for (let i = 0; i < 8; i++) if (png[i] !== PNG_SIG[i]) throw new Error('not a PNG');
  let w = 0, h = 0, bpp = 0;
  const idat = [];
  for (let p = 8; p + 12 <= png.length;) {
    const len = be32(png, p), type = String.fromCharCode(...png.subarray(p + 4, p + 8));
    const data = png.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = be32(data, 0); h = be32(data, 4);
      if (data[8] !== 8 || (data[9] !== 2 && data[9] !== 6) || data[12]) {
        throw new Error('PNG must be 8-bit RGB or RGBA, non-interlaced');
      }
      if (wantW && (w !== wantW || h !== wantH)) throw new Error(`PNG is ${w}x${h}, expected ${wantW}x${wantH}`);
      bpp = data[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!bpp) throw new Error('PNG has no IHDR');
  const raw = await inflate(concat(idat)), stride = w * bpp;
  if (raw.length < (stride + 1) * h) throw new Error('PNG data is short');
  const out = new Uint8Array(w * h * 3);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    switch (f) {
      case 0: break;
      case 1: for (let i = bpp; i < stride; i++) row[i] += row[i - bpp]; break;
      case 2: for (let i = 0; i < stride; i++) row[i] += prev[i]; break;
      case 3: for (let i = 0; i < stride; i++) row[i] += ((i >= bpp ? row[i - bpp] : 0) + prev[i]) >> 1; break;
      case 4:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          row[i] += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        break;
      default: throw new Error(`bad PNG filter ${f}`);
    }
    if (bpp === 3) out.set(row, y * stride);
    else for (let x = 0; x < w; x++) out.set(row.subarray(x * 4, x * 4 + 3), (y * w + x) * 3);
    prev = row;
  }
  return out;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---- zip ----------------------------------------------------------------------

export async function zipRead(buf) {
  const d = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let eo = -1;
  for (let i = d.length - 22; i >= Math.max(0, d.length - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eo = i; break; }
  }
  if (eo < 0) throw new Error('not a zip file');
  let n = v.getUint16(eo + 10, true), cdOff = v.getUint32(eo + 16, true);
  if (eo >= 20 && v.getUint32(eo - 20, true) === 0x07064b50) {
    const z = Number(v.getBigUint64(eo - 12, true));
    n = Number(v.getBigUint64(z + 32, true));
    cdOff = Number(v.getBigUint64(z + 48, true));
  }
  const entries = [];
  for (let i = 0, p = cdOff; i < n; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('bad zip directory');
    const method = v.getUint16(p + 10, true);
    let csize = v.getUint32(p + 20, true), lho = v.getUint32(p + 42, true);
    const usize0 = v.getUint32(p + 24, true);
    const nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true);
    const name = new TextDecoder().decode(d.subarray(p + 46, p + 46 + nl));
    for (let x = p + 46 + nl; x + 4 <= p + 46 + nl + xl;) {
      const id = v.getUint16(x, true), sz = v.getUint16(x + 2, true);
      if (id === 1) {
        let q = x + 4;
        if (usize0 === 0xffffffff) q += 8;
        if (csize === 0xffffffff) { csize = Number(v.getBigUint64(q, true)); q += 8; }
        if (lho === 0xffffffff) lho = Number(v.getBigUint64(q, true));
      }
      x += 4 + sz;
    }
    p += 46 + nl + xl + cl;
    const data = lho + 30 + v.getUint16(lho + 26, true) + v.getUint16(lho + 28, true);
    entries.push({
      name,
      read: async () => {
        const c = d.subarray(data, data + csize);
        if (method === 0) return c;
        if (method === 8) return inflateRaw(c);
        throw new Error(`unsupported zip compression method ${method}`);
      },
    });
  }
  return entries;
}

// Build a zip of stored entries: [{name, data}].
export function zipWrite(files) {
  const parts = [], cd = [];
  let off = 0;
  for (const { name, data } of files) {
    const nm = new TextEncoder().encode(name), crc = crc32(data);
    const lh = new Uint8Array(30 + nm.length), lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(12, 0x21, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, nm.length, true); lh.set(nm, 30);
    const ch = new Uint8Array(46 + nm.length), cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(14, 0x21, true); cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true); cv.setUint16(28, nm.length, true); cv.setUint32(42, off, true);
    ch.set(nm, 46);
    parts.push(lh, data); cd.push(ch);
    off += lh.length + data.length;
    if (off > 0xfffffffe) throw new Error('instance too large to save from the browser; use the C or Python tools');
  }
  const cdSize = cd.reduce((s, c) => s + c.length, 0);
  const eo = new Uint8Array(22), ev = new DataView(eo.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, off, true);
  return concat([...parts, ...cd, eo]);
}

function parseFrameName(name) {
  let m;
  if ((m = /^([a-z]{2})\.png$/.exec(name))) return { fmt: 'hd', idx: frameIndex(m[1]) };
  if ((m = /^([1-9]\d{0,2})\.png$/.exec(name)) && Number(m[1]) <= FRAMES4K) return { fmt: '4k', idx: Number(m[1]) - 1 };
  return null;
}

// ---- instances ------------------------------------------------------------------

const ZERO = new Uint8Array(PAGE);
const isZero = (a) => { for (let i = 0; i < a.length; i++) if (a[i]) return false; return true; };

export class Instance {
  constructor() {
    this.frames = new Array(FRAMES).fill(null); // Uint8Array(FRAME_BYTES) or null for all zero
    this.format = 'hd';
    this.version = 0;                           // bumped on every write, for redraws
  }

  frame(i, create = false) {
    if (!this.frames[i] && create) this.frames[i] = new Uint8Array(FRAME_BYTES);
    return this.frames[i];
  }

  read(addr, n) {
    const out = new Uint8Array(n);
    for (let pos = 0; pos < n && addr + pos < BYTES;) {
      const a = addr + pos, f = Math.floor(a / FRAME_BYTES), off = a - f * FRAME_BYTES;
      const k = Math.min(FRAME_BYTES - off, n - pos);
      if (this.frames[f]) out.set(this.frames[f].subarray(off, off + k), pos);
      pos += k;
    }
    return out;
  }

  write(addr, data) {
    if (addr < 0 || addr + data.length > BYTES) throw new Error(`write of ${data.length} bytes at ${addr} is out of range`);
    for (let pos = 0; pos < data.length;) {
      const a = addr + pos, f = Math.floor(a / FRAME_BYTES), off = a - f * FRAME_BYTES;
      const k = Math.min(FRAME_BYTES - off, data.length - pos), piece = data.subarray(pos, pos + k);
      if (this.frames[f] || !isZero(piece)) this.frame(f, true).set(piece, off);
      pos += k;
    }
    this.version++;
  }

  getPixel(frame, x, y) {
    const f = this.frames[frame], o = (y * W + x) * 3;
    return f ? [f[o], f[o + 1], f[o + 2]] : [0, 0, 0];
  }

  setPixel(frame, x, y, r, g, b) {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const f = this.frame(frame, true), o = (y * W + x) * 3;
    f[o] = r; f[o + 1] = g; f[o + 2] = b;
    this.version++;
  }

  // Mosaic coordinates -> [frame, x, y].
  static mosaic(X, Y) {
    const fx = Math.floor(X / W), fy = Math.floor(Y / H);
    return [fy * GRID + fx, X - fx * W, Y - fy * H];
  }

  frameInUse(i) { return !!this.frames[i] && !isZero(this.frames[i]); }

  pageIsZero(p) {
    const a = p * PAGE, f = Math.floor(a / FRAME_BYTES), end = a + PAGE;
    if (!this.frames[f] && (Math.floor((end - 1) / FRAME_BYTES) === f || !this.frames[f + 1])) return true;
    return isZero(this.read(a, PAGE));
  }

  pagesInUse() {
    let n = 0, last = -1;
    for (let f = 0; f < FRAMES; f++) {
      if (!this.frames[f]) continue;
      const lastPage = Math.floor(((f + 1) * FRAME_BYTES - 1) / PAGE);
      for (let p = Math.max(last + 1, Math.floor((f * FRAME_BYTES) / PAGE)); p <= lastPage; p++) {
        if (!this.pageIsZero(p)) n++;
        last = p;
      }
    }
    return n;
  }

  // Free frames that went back to all zeros.
  compact() {
    for (let f = 0; f < FRAMES; f++) if (this.frames[f] && isZero(this.frames[f])) this.frames[f] = null;
  }

  static async load(buf) {
    const inst = new Instance();
    let seen = null;
    for (const e of await zipRead(buf)) {
      const parsed = parseFrameName(e.name);
      if (!parsed) continue;
      if (seen && seen !== parsed.fmt) throw new Error('zip mixes HD and 4K frame names');
      seen = parsed.fmt;
      const [w, h, size] = parsed.fmt === 'hd' ? [W, H, FRAME_BYTES] : [W4K, H4K, FRAME4K_BYTES];
      let rgb;
      try { rgb = await pngDecode(await e.read(), w, h); } catch (err) { throw new Error(`${e.name}: ${err.message}`); }
      inst.write(parsed.idx * size, rgb);
    }
    inst.format = seen || 'hd';
    inst.compact();
    return inst;
  }

  async save(fmt = this.format) {
    const files = [];
    if (fmt === 'hd') {
      for (let f = 0; f < FRAMES; f++) {
        if (this.frameInUse(f)) files.push({ name: `${frameName(f)}.png`, data: await pngEncode(this.frames[f], W, H) });
      }
    } else {
      for (let k = 0; k < FRAMES4K; k++) {
        if ([0, 1, 2, 3].every((j) => !this.frameInUse(k * 4 + j))) continue;
        files.push({ name: `${k + 1}.png`, data: await pngEncode(this.read(k * FRAME4K_BYTES, FRAME4K_BYTES), W4K, H4K) });
      }
    }
    return zipWrite(files);
  }

  // ---- embedded objects ----

  objects() {
    const out = [];
    for (let f = 0; f < FRAMES; f++) {
      const fr = this.frames[f];
      if (!fr) continue;
      for (let p = Math.ceil((f * FRAME_BYTES) / PAGE); p * PAGE + 7 <= (f + 1) * FRAME_BYTES; p++) {
        const o = p * PAGE - f * FRAME_BYTES;
        if (fr[o] === 0x55 && fr[o + 1] === 0x43 && fr[o + 2] === 0x4f && fr[o + 3] === 0x42 &&
            fr[o + 4] === 0x4a && fr[o + 5] === 0x31 && fr[o + 6] === 0x0a) {
          const obj = this.parseObject(p);
          if (obj) out.push(obj);
        }
      }
    }
    return out;
  }

  parseObject(page) {
    const buf = this.read(page * PAGE, PAGE);
    let end = -1;
    for (let i = 0; i + 1 < PAGE; i++) if (buf[i] === 10 && buf[i + 1] === 10) { end = i; break; }
    if (end < 0) return null;
    const fields = {};
    for (const line of new TextDecoder('latin1').decode(buf.subarray(7, end)).split('\n')) {
      const c = line.indexOf(':');
      if (c > 0 && !(line.slice(0, c) in fields)) fields[line.slice(0, c)] = line.slice(c + 1).replace(/^ +/, '');
    }
    if (!fields.name || !fields.type || !/^\d+$/.test(fields.length || '') || !/^[0-9a-f]+$/i.test(fields.crc32 || '')) return null;
    const obj = {
      page, name: fields.name, type: fields.type, length: Number(fields.length),
      crc32: parseInt(fields.crc32, 16) >>> 0, frames: fields.frames || '', payloadAddr: page * PAGE + end + 2, fields,
    };
    if (obj.payloadAddr + obj.length > BYTES) return null;
    obj.crcOk = crc32(this.payload(obj)) === obj.crc32;
    return obj;
  }

  payload(obj) { return this.read(obj.payloadAddr, obj.length); }

  embed(name, type, data, { page = null, frames = '', force = false } = {}) {
    if (typeof data === 'string') data = new TextEncoder().encode(data);
    if (name.includes('\n')) throw new Error('name may not contain newlines');
    let hdr = `UCOBJ1\nname: ${name}\ntype: ${type}\nlength: ${data.length}\ncrc32: ${crc32(data).toString(16).padStart(8, '0')}\n`;
    if (frames) hdr += `frames: ${frames}\n`;
    const h = new TextEncoder().encode(hdr + '\n');
    if (h.length >= PAGE) throw new Error('object header too long');
    const npages = Math.ceil((h.length + data.length) / PAGE);
    if (page === null) {
      for (let p = OBJ_AREA_PAGE, run = 0; p < TICK_PAGE; p++) {
        run = this.pageIsZero(p) ? run + 1 : 0;
        if (run === npages) { page = p - npages + 1; break; }
      }
      if (page === null) throw new Error(`no free run of ${npages} pages in the object area`);
    } else if (page + npages > PAGES) {
      throw new Error(`object does not fit at page ${page}`);
    } else if (!force) {
      for (let p = page; p < page + npages; p++) if (!this.pageIsZero(p)) throw new Error(`page ${p} is not empty`);
    }
    this.write(page * PAGE, concat([h, data]));
    return page;
  }

  // ---- tick log ----

  tickHeader() {
    const h = this.read(TICK_PAGE * PAGE, 20), v = new DataView(h.buffer);
    if (new TextDecoder().decode(h.subarray(0, 7)) !== 'UCTICK1' || h[7]) return null;
    return { tick: v.getUint32(8, true), total: v.getUint32(12, true), capacity: v.getUint32(16, true) };
  }

  // Append damage records [{frame, x, y, w, h}] for tick `tick`.
  logTick(tick, rects) {
    const hdr = this.tickHeader() || { total: 0 };
    const h = new Uint8Array(20), v = new DataView(h.buffer);
    h.set(new TextEncoder().encode('UCTICK1'), 0);
    v.setUint32(8, tick, true); v.setUint32(12, hdr.total + rects.length, true); v.setUint32(16, TICK_CAP, true);
    this.write(TICK_PAGE * PAGE, h);
    const rec = new Uint8Array(16), rv = new DataView(rec.buffer);
    rects.forEach((r, i) => {
      rv.setUint32(0, tick, true); rv.setUint16(4, r.frame, true); rv.setUint16(6, r.x, true);
      rv.setUint16(8, r.y, true); rv.setUint16(10, r.w, true); rv.setUint16(12, r.h, true);
      this.write((TICK_PAGE + 1) * PAGE + ((hdr.total + i) % TICK_CAP) * 16, rec);
    });
  }

  tickRecords(last = 20) {
    const hdr = this.tickHeader();
    if (!hdr) return [];
    const out = [];
    for (let r = Math.max(0, hdr.total - Math.min(last, TICK_CAP)); r < hdr.total; r++) {
      const d = this.read((TICK_PAGE + 1) * PAGE + (r % TICK_CAP) * 16, 16), v = new DataView(d.buffer);
      out.push({ tick: v.getUint32(0, true), frame: v.getUint16(4, true), x: v.getUint16(6, true),
        y: v.getUint16(8, true), w: v.getUint16(10, true), h: v.getUint16(12, true) });
    }
    return out;
  }
}

export { ZERO as ZERO_PAGE };
