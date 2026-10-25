# UC4205260800B Technical Specification (draft 1)

This document pins down the parts of the README that tools need to agree on.
Everything here is implemented identically by the C tools (`src/`), the Python
tools (`script/`) and the web tools (`htdocs/`), and the three are tested
against each other.

## 1. Memory

A Unit Computer Instance is exactly **4205260800 bytes** (33642086400 bits) of
linear memory, addressed from `0` to `4205260799`. Unwritten memory is zero.

| Fact | Value |
| --- | --- |
| Bytes | 4205260800 = 1920 × 1080 × 3 × 676 = 3840 × 2160 × 3 × 169 = 49920 × 28080 × 3 |
| Pages (4096 bytes) | 1026675 |
| HD frames (1920×1080 RGB, 6220800 bytes) | 676, in a 26 × 26 grid |
| 4K frames (3840×2160 RGB, 24883200 bytes) | 169, in a 13 × 13 grid |
| Unaddressed in a 32-bit space | 2^32 − 4205260800 = 89706496 |
| Divisors | 4205260800 has 702, 33642086400 has 864 |
| Prime | 4205260799 is the 199234207th prime |

All of these are verified by `uc facts` (C) and `uc.py facts` (Python).

## 2. The mosaic and its frames

Memory is **one row-major 49920 × 28080 RGB framebuffer**, the mosaic. Each
mosaic row is **149760 bytes** (49920 × 3), and mosaic pixel `(X, Y)` lives at

```
addr(X, Y) = Y * 149760 + X * 3          # R, G, B at addr, addr+1, addr+2
```

The mosaic is cut into a 26 × 26 grid of **HD frames**, each a 1920 × 1080
tile. Frame `f` is the tile at column `f % 26`, row `f / 26`, so its pixel
`(x, y)` is mosaic pixel `((f % 26) * 1920 + x, (f / 26) * 1080 + y)`.

Each frame has a two-letter name: `aa` is frame 0 (top left), `ab` is frame 1
(to its right), …, `az` is frame 25 (top right), `ba` is frame 26 (below `aa`),
…, `zz` is frame 675 (bottom right). The first letter is the row and the
second letter is the column.

Because memory is row-major across the whole mosaic, a frame is *not* a
contiguous run of bytes: one frame row is 5760 bytes, and the next frame row
starts 149760 bytes later. A 4096-byte page covers 1365⅓ pixels of a single
mosaic row (or the end of one row and the start of the next).

The same mosaic can also be cut into a 13 × 13 grid of **4K frames**, each a
3840 × 2160 tile. 4K frame `k` (0-based) is the tile at column `k % 13`, row
`k / 13`, which is exactly the 2 × 2 block of HD frames at rows `2(k/13)`,
`2(k/13)+1` and columns `2(k%13)`, `2(k%13)+1`.

## 3. Save formats

An instance is saved as a zip file of PNG images. All-zero frames are omitted.
Both formats describe the same mosaic, so tools convert between them freely.

**HD format**: entries `aa.png` … `zz.png`, each a 1920 × 1080 8-bit RGB PNG
holding one HD frame (tile).

**4K format**: entries `1.png` … `169.png`, each a 3840 × 2160 8-bit RGB PNG
holding one 4K frame (tile). `1.png` has `aa` and `ab` in its top half and
`ba` and `bb` in its bottom half; `2.png` holds `ac ad / bc bd`; `14.png`
holds `ca cb / da db`; `169.png` holds `yy yz / zy zz`.

Rules for readers:

* PNGs must be 8-bit, non-interlaced, colour type 2 (RGB). Readers also accept
  colour type 6 (RGBA) and drop the alpha channel, since image editors often
  save that way.
* Zip entries may be stored or deflated. Entries that are not frame images
  (for example a `README.txt`) are ignored. A zip mixing both naming schemes
  is an error.
* A missing frame image means that frame is all zero.

Writers use stored (uncompressed) zip entries, PNG filter 0 and zlib level 6.

## 4. Embedded objects

Plain data (text, HTML, JavaScript, anything) can be embedded in memory. An
object starts at the first byte of a page with an ASCII header:

```
UCOBJ1
name: life
type: application/x-uc-cart+javascript
length: 5123
crc32: 1a2b3c4d
frames: ab

<payload: exactly `length` bytes>
```

* Lines end with `\n`. The header ends at the first empty line, and the payload
  starts on the byte after it. The header must fit in one page (4096 bytes).
* `name`, `type`, `length` and `crc32` (lowercase hex, zlib CRC-32 of the
  payload) are required. Unknown keys are kept and ignored.
* The payload continues across following pages as needed.
* Scanners look for `UCOBJ1\n` at the start of every page.

By convention, tools placing an object automatically use the first run of
all-zero pages starting at page **987188** (the first page that starts in
mosaic row 27000, the top row of grid row `z`) and ending before the tick log.

Because every object is just bytes, it is also visible as pixels: an object
shows up as a speckled horizontal streak running across the top of grid row
`z` (one page is about 1365 pixels of one mosaic row).

## 5. Carts

A **cart** is an object of type `application/x-uc-cart+javascript`. Its
`frames` header lists the frames (by name, comma separated) the cart may draw
on. The web host runs a cart inside a sandboxed iframe and drives it with
ticks; the cart's JavaScript defines:

```js
function init(uc) { ... }            // optional, called once
function tick(uc, t, input) { ... }  // called once per system tick
```

`uc.frame(name)` returns a surface for one of the cart's frames with
`w`, `h`, `get(x, y)`, `set(x, y, r, g, b)`, `fill(x, y, w, h, r, g, b)` and
`text(x, y, string, scale, r, g, b)`. `input` holds `keys` (a set of
`KeyboardEvent.key` values held down), `pressed` (keys pressed since the last
tick) and `clicks` (`{frame, x, y, button}` in frame coordinates).

The host copies the cart's frames in (each as a packed 1920 × 1080 RGB
image), and after each tick copies back only the 64 × 64 tiles that changed. The cart's state *is* its pixels: save the
instance and the game is saved too.

## 6. Tick log

The last 1024 pages (pages 1025651 … 1026674, the bottom 28 rows of the
mosaic, running across frames `za` … `zz`) hold the **tick log**, a ring buffer the host writes as it drives the system.

Page 1025651 is the header (little-endian):

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 8 | magic `UCTICK1\0` |
| 8 | 4 | current tick |
| 12 | 4 | total records ever written |
| 16 | 4 | capacity in records (261888) |

Pages 1025652 … 1026674 hold 16-byte records; record `n` lives at slot
`n % capacity`:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 4 | tick |
| 4 | 2 | frame index |
| 6 | 2 | x |
| 8 | 2 | y |
| 10 | 2 | width |
| 12 | 2 | height |
| 14 | 2 | reserved (0) |

Each record is one damaged rectangle, in the sense of an X11/VNC damage
event, so the log is a replayable history of what changed and when.
