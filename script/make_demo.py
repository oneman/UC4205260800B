#!/usr/bin/env python3
"""Build the demo instance: title art, two carts and the docs, all in one zip.

    python3 script/make_demo.py htdocs/demo.zip

Layout: aa title, ab Game of Life board (stored as pixels), ac skirmish,
objects from page 987188 (the top of grid row z), tick log in the bottom 28 mosaic rows.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import uc  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Same 5x7 font as htdocs/cart-runtime.js: ASCII 32..90, five column bytes per glyph.
FONT = bytes.fromhex(
    "0000000000" "00005f0000" "0007000700" "147f147f14" "242a7f2a12" "2313086462" "3649552250"
    "0005030000" "001c224100" "0041221c00" "082a1c2a08" "08083e0808" "0050300000" "0808080808"
    "0060600000" "2010080402" "3e5149453e" "00427f4000" "4261514946" "2141454b31" "1814127f10"
    "2745454539" "3c4a494930" "0171090503" "3649494936" "064949291e" "0036360000" "0056360000"
    "0008142241" "1414141414" "4122140800" "0201510906" "324979413e" "7e1111117e" "7f49494936"
    "3e41414122" "7f4141221c" "7f49494941" "7f09090101" "3e41415132" "7f0808087f" "00417f4100"
    "2040413f01" "7f08142241" "7f40404040" "7f0204027f" "7f0408107f" "3e4141413e" "7f09090906"
    "3e4151215e" "7f09192946" "4649494931" "01017f0101" "3f4040403f" "1f2040201f" "7f2018207f"
    "6314081463" "0304780403" "6151494543")


def fill(buf, x, y, w, h, rgb):
    row = bytes(rgb) * w
    for yy in range(max(0, y), min(uc.H, y + h)):
        o = (yy * uc.W + x) * 3
        buf[o:o + w * 3] = row


def text(buf, x, y, s, scale, rgb):
    for ch in s.upper():
        c = ord(ch) if 32 <= ord(ch) <= 90 else 63
        cols = FONT[(c - 32) * 5:(c - 32) * 5 + 5]
        for cx, bits in enumerate(cols):
            for cy in range(7):
                if bits >> cy & 1:
                    fill(buf, x + cx * scale, y + cy * scale, scale, scale, rgb)
        x += 6 * scale


def centered(buf, y, s, scale, rgb):
    text(buf, (uc.W - len(s) * 6 * scale) // 2, y, s, scale, rgb)


def title_frame():
    buf = bytearray(uc.FRAME_BYTES)
    cols = [(math.sin(x / 97.0), math.sin(x / 41.0 + 1.3)) for x in range(uc.W)]
    for y in range(uc.H):
        sy, sy2 = math.sin(y / 73.0), math.sin(y / 29.0 + 0.7)
        row = bytearray(uc.W * 3)
        for x, (a, b) in enumerate(cols):
            v = a + sy + 0.5 * (b * sy2)
            row[x * 3] = int(40 + 30 * math.sin(v * 2.1))
            row[x * 3 + 1] = int(30 + 25 * math.sin(v * 1.7 + 2))
            row[x * 3 + 2] = int(80 + 60 * math.sin(v * 1.3 + 4))
        buf[y * uc.W * 3:(y + 1) * uc.W * 3] = row
    fill(buf, 160, 230, 1600, 620, (8, 10, 18))
    centered(buf, 280, "LUSH STEMSYS UNIT COMPUTER", 6, (200, 220, 255))
    centered(buf, 360, "UC4205260800B", 18, (255, 204, 51))
    centered(buf, 530, "4205260800 BYTES  1026675 PAGES  676 FRAMES", 4, (230, 230, 230))
    centered(buf, 600, "AB LIFE   AC SKIRMISH   ROW Z OBJECTS + TICK LOG", 4, (126, 231, 135))
    centered(buf, 680, "PIX OR IT DIDN'T HAPPEN", 5, (255, 123, 114))
    centered(buf, 780, "OPEN THE OBJECTS PANEL AND PRESS RUN", 3, (160, 170, 190))
    return bytes(buf)


def life_frame():
    """A Game of Life board in the life cart's pixel format, with a glider gun and some acorns."""
    cell, top, cw, ch = 8, 16, 240, 133
    alive = set()
    gun = ["........................O...........",
           "......................O.O...........",
           "............OO......OO............OO",
           "...........O...O....OO............OO",
           "OO........O.....O...OO..............",
           "OO........O...O.OO....O.O...........",
           "..........O.....O.......O...........",
           "...........O...O....................",
           "............OO......................"]
    for y, row in enumerate(gun):
        for x, c in enumerate(row):
            if c == "O":
                alive.add((4 + x, 4 + y))
    for ox, oy in [(120, 60), (180, 100), (60, 100)]:
        for x, y in [(1, 0), (3, 1), (0, 2), (1, 2), (4, 2), (5, 2), (6, 2)]:  # acorn
            alive.add((ox + x, oy + y))
    buf = bytearray(uc.FRAME_BYTES)
    for cy in range(ch):
        row = bytearray(uc.W * 3)
        for cx in range(cw):
            rgb = (120, 255, 160) if (cx, cy) in alive else (10, 18, 28)
            row[cx * cell * 3:(cx * cell + cell - 1) * 3] = bytes(rgb) * (cell - 1)
        for r in range(cell - 1):
            y = top + cy * cell + r
            buf[y * uc.W * 3:(y + 1) * uc.W * 3] = row
    return bytes(buf)


def main(out):
    inst = uc.Instance()
    inst.write_rect(*uc.frame_origin(uc.frame_index("aa")), uc.W, uc.H, title_frame())
    inst.write_rect(*uc.frame_origin(uc.frame_index("ab")), uc.W, uc.H, life_frame())
    for name, path, kind, frames in [
        ("README.md", "README.md", "text/markdown", None),
        ("SPEC.md", "SPEC.md", "text/markdown", None),
        ("life", "htdocs/carts/life.js", uc.CART_TYPE, "ab"),
        ("skirmish", "htdocs/carts/skirmish.js", uc.CART_TYPE, "ac"),
    ]:
        with open(os.path.join(ROOT, path), "rb") as f:
            inst.embed(name, kind, f.read(), frames=frames)
    inst.save(out, "hd")
    print(f"wrote {out}: {len(inst.frames_in_use())} frames, {len(inst.objects())} objects")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "htdocs", "demo.zip"))
