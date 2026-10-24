"""Tests for uc.py, plus cross-checks against the C tool and the JS library.

    python3 -m unittest discover -s script -p 'test_*.py'

The cross-language tests run when build/uc (``make``) and node are available.
"""
import os
import shutil
import struct
import subprocess
import tempfile
import unittest
import zlib

import uc

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UC_BIN = os.path.join(ROOT, "build", "uc")
MSG = b"Hello Super Intelligence World!"
SPOTS = [0, uc.BYTES - len(MSG), 7 * uc.FRAME_BYTES - 2]


def sample():
    inst = uc.Instance()
    for a in SPOTS:
        inst.write(a, MSG)
    inst.embed("note", "text/plain", b"plain text payload\n")
    return inst


class Memory(unittest.TestCase):
    def test_facts(self):
        for ok, what in uc.facts():
            self.assertTrue(ok, what)

    def test_read_write(self):
        inst = uc.Instance()
        inst.write(5, bytes(10000))
        self.assertEqual(inst.pages, {})
        data = bytes((i * 7 + 1) & 255 for i in range(10000))
        inst.write(uc.PAGE - 3, data)
        self.assertEqual(inst.read(uc.PAGE - 3, 10000), data)
        self.assertEqual(inst.nonzero_pages(), 4)
        with self.assertRaises(ValueError):
            inst.write(uc.BYTES - 1, b"ab")

    def test_addresses(self):
        self.assertEqual(uc.parse_addr("ab:10,20"), 6336030)
        self.assertEqual(uc.parse_addr("p2"), 8192)
        self.assertEqual(uc.parse_addr("0x10"), 16)
        self.assertEqual(uc.frame_name(675), "zz")
        self.assertEqual(uc.frame_index("bb"), 27)


class Formats(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.dir)

    def round_trip(self, fmt):
        path = os.path.join(self.dir, f"{fmt}.zip")
        sample().save(path, fmt)
        back = uc.Instance.load(path)
        self.assertEqual(back.format, fmt)
        for a in SPOTS:
            self.assertEqual(back.read(a, len(MSG)), MSG)
        self.assertEqual([o["name"] for o in back.objects()], ["note"])

    def test_hd(self):
        self.round_trip("hd")

    def test_4k(self):
        self.round_trip("4k")

    def test_png_filters(self):
        w, h = 33, 17
        rgb = bytes((i * i * 31 + i) & 255 for i in range(w * h * 3))
        self.assertEqual(uc.png_decode(uc.png_encode(rgb, w, h), w, h)[2], rgb)
        self.assertEqual(uc.png_decode(filtered_png(rgb, w, h), w, h)[2], rgb)

    def test_rgba_accepted(self):
        w, h = 4, 2
        rgba = bytes(range(w * h * 4))
        raw = b"".join(b"\0" + rgba[y * w * 4:(y + 1) * w * 4] for y in range(h))
        png = (b"\x89PNG\r\n\x1a\n" + uc._chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
               + uc._chunk(b"IDAT", zlib.compress(raw)) + uc._chunk(b"IEND", b""))
        rgb = uc.png_decode(png)[2]
        self.assertEqual(rgb, b"".join(rgba[i:i + 3] for i in range(0, len(rgba), 4)))

    def test_objects(self):
        inst = sample()
        page = inst.embed("cart", uc.CART_TYPE, b"function tick() {}", frames="ab")
        self.assertEqual(page, uc.OBJ_AREA_PAGE + 1)
        objs = inst.objects()
        self.assertEqual([(o["name"], o["crc_ok"], o["frames"]) for o in objs],
                         [("note", True, ""), ("cart", True, "ab")])
        with self.assertRaises(ValueError):
            inst.embed("x", "text/plain", b"x", page=uc.OBJ_AREA_PAGE)
        inst.write(objs[0]["payload_addr"], b"P")
        self.assertFalse(inst.objects()[0]["crc_ok"])


def filtered_png(rgb, w, h):
    """A PNG whose rows cycle through all five filter types."""
    stride, raw, prev = w * 3, bytearray(), bytes(w * 3)
    for y in range(h):
        f, cur = y % 5, rgb[y * stride:(y + 1) * stride]
        raw.append(f)
        for i in range(stride):
            a = cur[i - 3] if i >= 3 else 0
            b = prev[i]
            c = prev[i - 3] if i >= 3 else 0
            p = a + b - c
            pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
            pred = [0, a, b, (a + b) >> 1, a if pa <= pb and pa <= pc else b if pb <= pc else c][f]
            raw.append((cur[i] - pred) & 255)
        prev = cur
    return (b"\x89PNG\r\n\x1a\n" + uc._chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + uc._chunk(b"IDAT", zlib.compress(bytes(raw))) + uc._chunk(b"IEND", b""))


@unittest.skipUnless(os.path.exists(UC_BIN), "run `make` to build the C tool")
class CrossLanguage(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.dir)

    def run_c(self, *args, stdin=None):
        return subprocess.run([UC_BIN, *args], input=stdin, capture_output=True, check=True).stdout

    def test_python_to_c_to_python(self):
        for fmt in ("hd", "4k"):
            a, b = os.path.join(self.dir, f"a-{fmt}.zip"), os.path.join(self.dir, f"b-{fmt}.zip")
            sample().save(a, fmt)
            self.run_c("poke", a, "p987300", stdin=b"from C")
            self.run_c("convert", a, b, "--4k" if fmt == "hd" else "--hd")
            back = uc.Instance.load(b)
            self.assertEqual(back.format, "4k" if fmt == "hd" else "hd")
            for addr in SPOTS:
                self.assertEqual(back.read(addr, len(MSG)), MSG)
            self.assertEqual(back.read(987300 * uc.PAGE, 6), b"from C")
            self.assertIn(b"note", self.run_c("ls", b))

    def test_filtered_png_import(self):
        path, png = os.path.join(self.dir, "x.zip"), os.path.join(self.dir, "frame.png")
        rgb = bytes((i * 13) & 255 for i in range(uc.FRAME_BYTES))
        with open(png, "wb") as f:
            f.write(filtered_png(rgb, uc.W, uc.H))
        uc.Instance().save(path)
        self.run_c("import", path, "ac", png)
        back = uc.Instance.load(path)
        self.assertEqual(back.read(2 * uc.FRAME_BYTES, uc.FRAME_BYTES), rgb)

    @unittest.skipUnless(shutil.which("node"), "node not installed")
    def test_js_reads_c_and_python(self):
        path = os.path.join(self.dir, "x.zip")
        sample().save(path, "4k")
        self.run_c("poke", path, "zz:0,0", stdin=b"from C")
        script = (f"import * as uc from '{ROOT}/htdocs/uc.js'; import fs from 'fs';"
                  f"const i = await uc.Instance.load(fs.readFileSync('{path}'));"
                  f"const t = new TextDecoder();"
                  f"console.log(t.decode(i.read(0, {len(MSG)})), t.decode(i.read(uc.parseAddr('zz:0,0'), 6)), i.objects()[0].name);"
                  f"fs.writeFileSync('{path}.js.zip', await i.save('hd'));")
        out = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, check=True, text=True).stdout
        self.assertEqual(out.split(), ["Hello", "Super", "Intelligence", "World!", "from", "C", "note"])
        back = uc.Instance.load(path + ".js.zip")
        self.assertEqual(back.read(uc.parse_addr("zz:0,0"), 6), b"from C")
        self.assertIn(b"note", self.run_c("ls", path + ".js.zip"))


if __name__ == "__main__":
    unittest.main()
