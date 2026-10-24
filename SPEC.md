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

## 2. Frames and the mosaic

Memory is cut into 676 consecutive **HD frames**. Frame `i` holds bytes
`[i × 6220800, (i + 1) × 6220800)` as row-major 8-bit RGB pixels:

```
addr(i, x, y) = i * 6220800 + (y * 1920 + x) * 3      # R, G, B at addr, addr+1, addr+2
```

Each frame has a two-letter name: `aa` is frame 0, `ab` is frame 1, …, `az` is
frame 25, `ba` is frame 26, …, `zz` is frame 675. The first letter is the row
and the second letter is the column of the frame in the 26 × 26 grid.

The **mosaic** is the single 49920 × 28080 picture made by laying the HD frames
out in that grid. Mosaic pixel `(X, Y)` is frame
`(Y / 1080) * 26 + (X / 1920)` at local pixel `(X % 1920, Y % 1080)`.

Note that the mosaic is *tiled*, not one long row-major scanline: a row of the
mosaic crosses 26 different frames. The tiling is what makes each frame a
real, self-contained screen.

## 3. Save formats

An instance is saved as a zip file of PNG images. All-zero frames are omitted.
Both formats describe the same bytes, so tools convert between them freely.

**HD format**: entries `aa.png` … `zz.png`, each a 1920 × 1080 8-bit RGB PNG
holding one HD frame.

**4K format**: entries `1.png` … `169.png`, each a 3840 × 2160 8-bit RGB PNG.
Image `k` holds bytes `[(k − 1) × 24883200, k × 24883200)` in row-major order,
i.e. exactly HD frames `4(k−1)` … `4(k−1)+3` in sequence. (Because the bytes are
wrapped at 3840 pixels, a 4K image does not look like four HD frames side by
side; it is the same memory at a different stride.)

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
all-zero pages starting at page **987188** (the first page fully inside frame
`za`, the bottom row of the grid) and ending before the tick log.

Because every object is just bytes, it is also visible as pixels: text shows
up as a speckled band of colour.

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

The host copies the cart's frames in, and after each tick copies back only
the 64 × 64 tiles that changed. The cart's state *is* its pixels: save the
instance and the game is saved too.

## 6. Tick log

The last 1024 pages (pages 1025651 … 1026674, inside frame `zz`) hold the
**tick log**, a ring buffer the host writes as it drives the system.

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
