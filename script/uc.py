#!/usr/bin/env python3
"""uc.py - Python tools for Lush Stemsys Unit Computer UC4205260800B instances.

Standard library only. Use it as a module (``from uc import Instance``) or as a
command line tool (``python3 script/uc.py help``). See SPEC.md for the layout.
"""
import struct
import sys
import zipfile
import zlib

BYTES = 4205260800
PAGE = 4096
PAGES = 1026675
W, H = 1920, 1080
FRAME_BYTES = W * H * 3
FRAMES = 676
GRID = 26
W4K, H4K = 3840, 2160
FRAME4K_BYTES = W4K * H4K * 3
FRAMES4K = 169
MOSAIC_W, MOSAIC_H = W * GRID, H * GRID
STRIDE = MOSAIC_W * 3  # memory is one row-major MOSAIC_W x MOSAIC_H RGB framebuffer
OBJ_MAGIC = b"UCOBJ1\n"
OBJ_AREA_PAGE = 987188
TICK_PAGE = 1025651
TICK_CAP = 261888
CART_TYPE = "application/x-uc-cart+javascript"

_ZERO_PAGE = bytes(PAGE)


def frame_name(i):
    return chr(97 + i // GRID) + chr(97 + i % GRID)


def frame_index(name):
    if len(name) != 2 or not all("a" <= c <= "z" for c in name):
        raise ValueError(f"bad frame name {name!r} (aa..zz)")
    return (ord(name[0]) - 97) * GRID + ord(name[1]) - 97


def addr(X, Y):
    """Address of mosaic pixel X, Y."""
    return Y * STRIDE + X * 3


def frame_origin(frame, size="hd"):
    """Mosaic X, Y of the top-left pixel of an HD frame (0..675) or 4K frame (0..168)."""
    if size == "hd":
        return frame % GRID * W, frame // GRID * H
    return frame % (GRID // 2) * W4K, frame // (GRID // 2) * H4K


def parse_addr(s):
    """Decimal, 0x hex, pN (page N) or FRAME:X,Y."""
    if s[:1] == "p" and s[1:].isdigit():
        page = int(s[1:])
        if page >= PAGES:
            raise ValueError(f"page {page} out of range")
        return page * PAGE
    if len(s) > 3 and s[2] == ":":
        x, y = (int(v) for v in s[3:].split(","))
        if not (0 <= x < W and 0 <= y < H):
            raise ValueError(f"pixel {x},{y} out of range")
        X, Y = frame_origin(frame_index(s[:2]))
        return addr(X + x, Y + y)
    a = int(s, 0)
    if not 0 <= a < BYTES:
        raise ValueError(f"address {a} out of range")
    return a


# ---- PNG -------------------------------------------------------------------

def _chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def png_encode(rgb, w, h):
    stride = w * 3
    raw = bytearray((stride + 1) * h)
    for y in range(h):
        raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)] = rgb[y * stride:(y + 1) * stride]
    return (b"\x89PNG\r\n\x1a\n"
            + _chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + _chunk(b"IDAT", zlib.compress(bytes(raw), 6))
            + _chunk(b"IEND", b""))


def png_decode(png, want_w=None, want_h=None):
    """Return (w, h, rgb bytes). Accepts 8-bit RGB or RGBA, drops alpha."""
    if png[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos, idat, w = 8, [], None
    while pos + 12 <= len(png):
        n, kind = struct.unpack(">I4s", png[pos:pos + 8])
        data = png[pos + 8:pos + 8 + n]
        if kind == b"IHDR":
            w, h, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", data)
            if depth != 8 or ctype not in (2, 6) or interlace:
                raise ValueError("PNG must be 8-bit RGB or RGBA, non-interlaced")
            if want_w is not None and (w, h) != (want_w, want_h):
                raise ValueError(f"PNG is {w}x{h}, expected {want_w}x{want_h}")
            bpp = 4 if ctype == 6 else 3
        elif kind == b"IDAT":
            idat.append(data)
        elif kind == b"IEND":
            break
        pos += 12 + n
    if w is None:
        raise ValueError("PNG has no IHDR")
    raw = zlib.decompress(b"".join(idat))
    stride = w * bpp
    if len(raw) < (stride + 1) * h:
        raise ValueError("PNG data is short")
    out = bytearray(stride * h)
    prev = bytearray(stride)
    for y in range(h):
        f = raw[y * (stride + 1)]
        row = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        if f == 1:
            for i in range(bpp, stride):
                row[i] = (row[i] + row[i - bpp]) & 255
        elif f == 2:
            for i in range(stride):
                row[i] = (row[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = row[i - bpp] if i >= bpp else 0
                row[i] = (row[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = row[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                row[i] = (row[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        elif f != 0:
            raise ValueError(f"bad PNG filter {f}")
        out[y * stride:(y + 1) * stride] = row
        prev = row
    if bpp == 4:
        rgb = bytearray(w * h * 3)
        for c in range(3):
            rgb[c::3] = out[c::4]
        out = rgb
    return w, h, bytes(out)


# ---- instances -------------------------------------------------------------

class Instance:
    """A sparse 4205260800-byte Unit Computer memory."""

    def __init__(self):
        self.pages = {}
        self.format = "hd"

    def read(self, addr, n):
        out = bytearray(n)
        pos = 0
        while pos < n:
            a = addr + pos
            if a >= BYTES:
                break
            page, off = divmod(a, PAGE)
            k = min(PAGE - off, n - pos)
            p = self.pages.get(page)
            if p is not None:
                out[pos:pos + k] = p[off:off + k]
            pos += k
        return bytes(out)

    def write(self, addr, data):
        data = memoryview(bytes(data))
        if addr < 0 or addr + len(data) > BYTES:
            raise ValueError(f"write of {len(data)} bytes at {addr} is out of range")
        pos = 0
        while pos < len(data):
            page, off = divmod(addr + pos, PAGE)
            k = min(PAGE - off, len(data) - pos)
            piece = data[pos:pos + k]
            p = self.pages.get(page)
            if p is None:
                if piece == _ZERO_PAGE[:k]:
                    pos += k
                    continue
                p = self.pages[page] = bytearray(PAGE)
            p[off:off + k] = piece
            pos += k

    def page_is_zero(self, page):
        p = self.pages.get(page)
        return p is None or p == _ZERO_PAGE

    def range_is_zero(self, addr, n):
        first, last = addr // PAGE, (addr + n - 1) // PAGE
        if not any(not self.page_is_zero(p) for p in range(first, last + 1) if p in self.pages):
            return True
        return self.read(addr, n) == bytes(n)

    def read_rect(self, X, Y, w, h):
        """Packed RGB rows of a mosaic rectangle."""
        return b"".join(self.read(addr(X, Y + y), w * 3) for y in range(h))

    def write_rect(self, X, Y, w, h, rgb):
        for y in range(h):
            self.write(addr(X, Y + y), rgb[y * w * 3:(y + 1) * w * 3])

    def rect_is_zero(self, X, Y, w, h):
        return all(self.range_is_zero(addr(X, Y + y), w * 3) for y in range(h))

    def _tiles_in_use(self, size):
        """Indices of HD or 4K frames that hold nonzero bytes."""
        tw, th = (W, H) if size == "hd" else (W4K, H4K)
        cols = MOSAIC_W // tw
        touched = set()
        for p in self.pages:
            if self.page_is_zero(p):
                continue
            first, last = p * PAGE // 3, ((p + 1) * PAGE - 1) // 3
            ys, xs, ye, xe = first // MOSAIC_W, first % MOSAIC_W, last // MOSAIC_W, last % MOSAIC_W
            for X, Y in ((xs, ys), (MOSAIC_W - 1, ys), (0, ye), (xe, ye)):
                if (Y, X) >= (ys, xs) and (Y, X) <= (ye, xe):
                    touched.add(Y // th * cols + X // tw)
        return sorted(t for t in touched
                      if not self.rect_is_zero(t % cols * tw, t // cols * th, tw, th))

    def nonzero_pages(self):
        return sum(1 for p in self.pages if not self.page_is_zero(p))

    def get_pixel(self, frame, x, y):
        X, Y = frame_origin(frame)
        return tuple(self.read(addr(X + x, Y + y), 3))

    def set_pixel(self, frame, x, y, rgb):
        X, Y = frame_origin(frame)
        self.write(addr(X + x, Y + y), bytes(rgb))

    def frames_in_use(self):
        return self._tiles_in_use("hd")

    # -- save formats --

    def save(self, path, fmt=None):
        fmt = fmt or self.format
        w, h = (W, H) if fmt == "hd" else (W4K, H4K)
        with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED, allowZip64=True) as z:
            for i in self._tiles_in_use(fmt):
                name = (frame_name(i) if fmt == "hd" else str(i + 1)) + ".png"
                z.writestr(zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0)),
                           png_encode(self.read_rect(*frame_origin(i, fmt), w, h), w, h))

    @classmethod
    def load(cls, path):
        inst = cls()
        seen = None
        with zipfile.ZipFile(path) as z:
            for info in z.infolist():
                parsed = _parse_frame_name(info.filename)
                if parsed is None:
                    continue
                fmt, idx = parsed
                if seen and seen != fmt:
                    raise ValueError("zip mixes HD and 4K frame names")
                seen = fmt
                w, h = (W, H) if fmt == "hd" else (W4K, H4K)
                try:
                    _, _, rgb = png_decode(z.read(info), w, h)
                except ValueError as e:
                    raise ValueError(f"{info.filename}: {e}") from None
                inst.write_rect(*frame_origin(idx, fmt), w, h, rgb)
        inst.format = seen or "hd"
        return inst

    # -- frames as images --

    def export_frame(self, frame):
        return png_encode(self.read_rect(*frame_origin(frame), W, H), W, H)

    def import_frame(self, frame, png):
        _, _, rgb = png_decode(png, W, H)
        self.write_rect(*frame_origin(frame), W, H, rgb)

    def thumbnail(self, step=20):
        """Downsampled picture of the whole mosaic as PNG bytes."""
        tw, th = MOSAIC_W // step, MOSAIC_H // step
        out = bytearray(tw * th * 3)
        rows = {p * PAGE // STRIDE for p in self.pages} | {((p + 1) * PAGE - 1) // STRIDE for p in self.pages}
        for ty in range(th):
            if ty * step not in rows:
                continue
            row = self.read(ty * step * STRIDE, STRIDE)
            for c in range(3):
                out[ty * tw * 3 + c:(ty + 1) * tw * 3:3] = row[c::step * 3][:tw]
        return png_encode(bytes(out), tw, th)

    # -- embedded objects --

    def objects(self):
        objs = []
        for page in sorted(self.pages):
            if self.pages[page][:7] != OBJ_MAGIC:
                continue
            obj = _parse_object(self, page)
            if obj:
                objs.append(obj)
        return objs

    def object_payload(self, obj):
        return self.read(obj["payload_addr"], obj["length"])

    def embed(self, name, type_, data, page=None, frames=None, force=False):
        if "\n" in name:
            raise ValueError("name may not contain newlines")
        hdr = f"UCOBJ1\nname: {name}\ntype: {type_}\nlength: {len(data)}\ncrc32: {zlib.crc32(data):08x}\n"
        if frames:
            hdr += f"frames: {frames}\n"
        hdr = (hdr + "\n").encode()
        if len(hdr) >= PAGE:
            raise ValueError("object header too long")
        npages = -(-(len(hdr) + len(data)) // PAGE)
        if page is None:
            run = 0
            for p in range(OBJ_AREA_PAGE, TICK_PAGE):
                run = run + 1 if self.page_is_zero(p) else 0
                if run == npages:
                    page = p - npages + 1
                    break
            else:
                raise ValueError(f"no free run of {npages} pages in the object area")
        elif page + npages > PAGES:
            raise ValueError(f"object does not fit at page {page}")
        elif not force:
            for p in range(page, page + npages):
                if not self.page_is_zero(p):
                    raise ValueError(f"page {p} is not empty (use force to overwrite)")
        self.write(page * PAGE, hdr + data)
        return page

    def ticklog(self):
        """Return (tick, total, records) or None. Records are dicts, oldest first."""
        h = self.read(TICK_PAGE * PAGE, 20)
        if h[:8] != b"UCTICK1\0":
            return None
        tick, total, _cap = struct.unpack("<III", h[8:20])
        recs = []
        for r in range(max(0, total - TICK_CAP), total):
            d = self.read((TICK_PAGE + 1) * PAGE + (r % TICK_CAP) * 16, 16)
            t, f, x, y, w, hh, _ = struct.unpack("<IHHHHHH", d)
            recs.append(dict(tick=t, frame=f, x=x, y=y, w=w, h=hh))
        return tick, total, recs


def _parse_frame_name(name):
    if not name.endswith(".png"):
        return None
    stem = name[:-4]
    if len(stem) == 2 and all("a" <= c <= "z" for c in stem):
        return "hd", frame_index(stem)
    if stem.isdigit() and stem[0] != "0" and 1 <= int(stem) <= FRAMES4K:
        return "4k", int(stem) - 1
    return None


def _parse_object(inst, page):
    buf = bytes(inst.pages[page])
    end = buf.find(b"\n\n")
    if end < 0:
        return None
    fields = {}
    for line in buf[7:end].decode("latin-1").split("\n"):
        k, sep, v = line.partition(":")
        if sep:
            fields.setdefault(k, v.strip(" "))
    try:
        obj = dict(page=page, name=fields["name"], type=fields["type"],
                   length=int(fields["length"]), crc32=int(fields["crc32"], 16),
                   frames=fields.get("frames", ""), payload_addr=page * PAGE + end + 2)
    except (KeyError, ValueError):
        return None
    if obj["payload_addr"] + obj["length"] > BYTES:
        return None
    obj["crc_ok"] = zlib.crc32(inst.object_payload(obj)) == obj["crc32"]
    return obj


# ---- number facts ----------------------------------------------------------

def ndivisors(x):
    count, p = 1, 2
    while p * p <= x:
        e = 0
        while x % p == 0:
            x //= p
            e += 1
        count *= e + 1
        p += 1
    return count * 2 if x > 1 else count


def is_prime(x):
    if x < 2:
        return False
    d = 2
    while d * d <= x:
        if x % d == 0:
            return False
        d += 1
    return True


def facts():
    return [
        (BYTES * 8 == 33642086400, "4205260800 bytes = 33642086400 bits"),
        (W * H * 3 * FRAMES == BYTES, "1920 x 1080 x 3 x 676 = 4205260800 (676 HD frames, aa..zz)"),
        (W4K * H4K * 3 * FRAMES4K == BYTES, "3840 x 2160 x 3 x 169 = 4205260800 (169 4K frames)"),
        (MOSAIC_W * MOSAIC_H * 3 == BYTES, "49920 x 28080 x 3 = 4205260800 (one mosaic framebuffer)"),
        (PAGE * PAGES == BYTES, "4096 x 1026675 = 4205260800 (pages)"),
        (2 ** 32 - BYTES == 89706496, "2^32 - 4205260800 = 89706496 unaddressed bytes"),
        (ndivisors(BYTES) == 702, "4205260800 has 702 divisors"),
        (ndivisors(BYTES * 8) == 864, "33642086400 has 864 divisors"),
        (is_prime(BYTES - 1), "4205260799 is prime (the 199234207th: see `uc facts --prime`)"),
    ]


# ---- command line ----------------------------------------------------------

USAGE = """uc.py - Lush Stemsys Unit Computer UC4205260800B tools

  uc.py facts                          verify the README's number facts
  uc.py where ADDR                     explain an address
  uc.py stat FILE.zip                  summary of an instance
  uc.py convert IN.zip OUT.zip [hd|4k]
  uc.py peek FILE.zip ADDR [LEN]       hex dump
  uc.py poke FILE.zip ADDR < data      write stdin at ADDR and save in place
  uc.py ls FILE.zip                    list embedded objects
  uc.py cat FILE.zip NAME              print an object's payload
  uc.py embed FILE.zip NAME TYPE PATH [--page N] [--frames aa,ab] [--force]
  uc.py export FILE.zip FRAME OUT.png
  uc.py import FILE.zip FRAME IN.png
  uc.py thumb FILE.zip OUT.png         2496x1404 picture of the whole mosaic
  uc.py ticklog FILE.zip [N]           last N tick log records

ADDR is decimal, 0x hex, pN (page N) or FRAME:X,Y (e.g. ab:10,20)."""


def hexdump(data, addr):
    lines = []
    for i in range(0, len(data), 16):
        row = data[i:i + 16]
        hx = " ".join(f"{b:02x}" for b in row).ljust(47)
        asc = "".join(chr(b) if 32 <= b < 127 else "." for b in row)
        lines.append(f"{addr + i:010x}  {hx}  |{asc}|")
    return "\n".join(lines)


def where(a):
    Y, X = divmod(a // 3, MOSAIC_W)
    frame = Y // H * GRID + X // W
    return "\n".join([
        f"address  {a} (0x{a:x})",
        f"page     {a // PAGE} + {a % PAGE}",
        f"mosaic   {X},{Y} channel {'RGB'[a % 3]}",
        f"frame    {frame_name(frame)} (#{frame}) pixel {X % W},{Y % H}",
        f"4k image {Y // H4K * (GRID // 2) + X // W4K + 1}.png pixel {X % W4K},{Y % H4K}",
    ])


def main(argv):
    if not argv or argv[0] in ("help", "-h", "--help"):
        print(USAGE)
        return 0 if argv else 1
    cmd, args = argv[0], argv[1:]
    if cmd == "facts":
        bad = 0
        for ok, what in facts():
            print(("ok    " if ok else "FAIL  ") + what)
            bad += not ok
        return 1 if bad else 0
    if cmd == "where":
        print(where(parse_addr(args[0])))
        return 0
    if not args:
        print(USAGE)
        return 1
    path = args[0]
    inst = Instance.load(path)
    if cmd == "stat":
        used = set(inst.frames_in_use())
        n = inst.nonzero_pages()
        print(f"saved as  {'HD (aa.png..zz.png)' if inst.format == 'hd' else '4K (1.png..169.png)'}")
        print(f"pages     {n} of {PAGES} in use ({100 * n / PAGES:.4f}%)")
        print("frames    (# = has data)\n          abcdefghijklmnopqrstuvwxyz")
        for r in range(GRID):
            print(f"        {chr(97 + r)} " + "".join("#" if r * GRID + c in used else "." for c in range(GRID)))
        print(f"          {len(used)} of {FRAMES} HD frames in use")
        print(f"objects   {len(inst.objects())}")
    elif cmd == "convert":
        inst.save(args[1], args[2] if len(args) > 2 else inst.format)
    elif cmd == "peek":
        a = parse_addr(args[1])
        print(hexdump(inst.read(a, int(args[2], 0) if len(args) > 2 else 256), a))
    elif cmd == "poke":
        data = sys.stdin.buffer.read()
        a = parse_addr(args[1])
        inst.write(a, data)
        inst.save(path)
        print(f"wrote {len(data)} bytes at {a}")
    elif cmd == "ls":
        for o in inst.objects():
            extra = f"  frames={o['frames']}" if o["frames"] else ""
            print(f"p{o['page']:<8} {o['length']:>10}  {'ok' if o['crc_ok'] else 'BAD':<4} {o['type']:<36} {o['name']}{extra}")
    elif cmd == "cat":
        for o in inst.objects():
            if o["name"] == args[1]:
                sys.stdout.buffer.write(inst.object_payload(o))
                return 0
        print(f"uc.py: no object named {args[1]}", file=sys.stderr)
        return 1
    elif cmd == "embed":
        name, type_, src = args[1:4]
        opts = args[4:]
        page = int(opts[opts.index("--page") + 1], 0) if "--page" in opts else None
        frames = opts[opts.index("--frames") + 1] if "--frames" in opts else None
        with open(src, "rb") as f:
            data = f.read()
        at = inst.embed(name, type_, data, page, frames, "--force" in opts)
        inst.save(path)
        print(f"embedded {name} ({len(data)} bytes) at page {at}")
    elif cmd == "export":
        with open(args[2], "wb") as f:
            f.write(inst.export_frame(frame_index(args[1])))
    elif cmd == "import":
        with open(args[2], "rb") as f:
            inst.import_frame(frame_index(args[1]), f.read())
        inst.save(path)
    elif cmd == "thumb":
        with open(args[1], "wb") as f:
            f.write(inst.thumbnail())
    elif cmd == "ticklog":
        log = inst.ticklog()
        if not log:
            print("no tick log")
            return 0
        tick, total, recs = log
        print(f"tick {tick}, {total} damage records")
        for r in recs[-(int(args[1]) if len(args) > 1 else 20):]:
            print(f"  tick {r['tick']:<8} {frame_name(r['frame'])} {r['x']:>4},{r['y']:<4} {r['w']:>4}x{r['h']}")
    else:
        print(USAGE)
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (ValueError, OSError, zipfile.BadZipFile) as e:
        print(f"uc.py: {e}", file=sys.stderr)
        sys.exit(1)
