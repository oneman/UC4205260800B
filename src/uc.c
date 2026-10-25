/* uc.c - UC4205260800B instance library: sparse memory, PNG, zip, objects. */
#define _FILE_OFFSET_BITS 64
#include "uc.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>

static char errbuf[512];

static int fail(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(errbuf, sizeof errbuf, fmt, ap);
    va_end(ap);
    return -1;
}

const char *uc_error(void) { return errbuf; }

/* ---- memory ------------------------------------------------------------ */

uc_t *uc_new(void)
{
    uc_t *u = calloc(1, sizeof *u);
    if (!u) return NULL;
    u->pages = calloc(UC_PAGES, sizeof *u->pages);
    if (!u->pages) { free(u); return NULL; }
    return u;
}

void uc_free(uc_t *u)
{
    if (!u) return;
    for (uint32_t i = 0; i < UC_PAGES; i++) free(u->pages[i]);
    free(u->pages);
    free(u);
}

void uc_read(const uc_t *u, uint64_t addr, void *buf, size_t len)
{
    uint8_t *out = buf;
    while (len) {
        if (addr >= UC_BYTES) { memset(out, 0, len); return; }
        uint32_t page = (uint32_t)(addr / UC_PAGE), off = (uint32_t)(addr % UC_PAGE);
        size_t n = UC_PAGE - off;
        if (n > len) n = len;
        if (u->pages[page]) memcpy(out, u->pages[page] + off, n);
        else memset(out, 0, n);
        out += n; addr += n; len -= n;
    }
}

static int all_zero(const uint8_t *p, size_t n)
{
    for (size_t i = 0; i < n; i++) if (p[i]) return 0;
    return 1;
}

int uc_write(uc_t *u, uint64_t addr, const void *buf, size_t len)
{
    const uint8_t *in = buf;
    if (addr > UC_BYTES || len > UC_BYTES - addr)
        return fail("write of %zu bytes at %llu is out of range", len, (unsigned long long)addr);
    while (len) {
        uint32_t page = (uint32_t)(addr / UC_PAGE), off = (uint32_t)(addr % UC_PAGE);
        size_t n = UC_PAGE - off;
        if (n > len) n = len;
        if (!u->pages[page]) {
            if (all_zero(in, n)) goto next;     /* keep zero pages unallocated */
            if (!(u->pages[page] = calloc(1, UC_PAGE))) return fail("out of memory");
        }
        memcpy(u->pages[page] + off, in, n);
    next:
        in += n; addr += n; len -= n;
    }
    return 0;
}

int uc_page_is_zero(const uc_t *u, uint32_t page)
{
    return page >= UC_PAGES || !u->pages[page] || all_zero(u->pages[page], UC_PAGE);
}

int uc_range_is_zero(const uc_t *u, uint64_t addr, uint64_t len)
{
    uint8_t buf[UC_PAGE];
    while (len) {
        uint32_t page = (uint32_t)(addr / UC_PAGE), off = (uint32_t)(addr % UC_PAGE);
        uint64_t n = UC_PAGE - off;
        if (n > len) n = len;
        if (page < UC_PAGES && u->pages[page]) {
            uc_read(u, addr, buf, (size_t)n);
            if (!all_zero(buf, (size_t)n)) return 0;
        }
        addr += n; len -= n;
    }
    return 1;
}

uint64_t uc_nonzero_pages(const uc_t *u)
{
    uint64_t n = 0;
    for (uint32_t i = 0; i < UC_PAGES; i++) n += !uc_page_is_zero(u, i);
    return n;
}

void uc_compact(uc_t *u)
{
    for (uint32_t i = 0; i < UC_PAGES; i++)
        if (u->pages[i] && all_zero(u->pages[i], UC_PAGE)) { free(u->pages[i]); u->pages[i] = NULL; }
}

void uc_rect_read(const uc_t *u, unsigned X, unsigned Y, unsigned w, unsigned h, uint8_t *rgb)
{
    for (unsigned y = 0; y < h; y++) uc_read(u, uc_addr(X, Y + y), rgb + (size_t)y * w * 3, (size_t)w * 3);
}

int uc_rect_write(uc_t *u, unsigned X, unsigned Y, unsigned w, unsigned h, const uint8_t *rgb)
{
    for (unsigned y = 0; y < h; y++)
        if (uc_write(u, uc_addr(X, Y + y), rgb + (size_t)y * w * 3, (size_t)w * 3)) return -1;
    return 0;
}

int uc_rect_is_zero(const uc_t *u, unsigned X, unsigned Y, unsigned w, unsigned h)
{
    for (unsigned y = 0; y < h; y++)
        if (!uc_range_is_zero(u, uc_addr(X, Y + y), (uint64_t)w * 3)) return 0;
    return 1;
}

void uc_frame_name(unsigned frame, char out[3])
{
    out[0] = (char)('a' + frame / UC_GRID);
    out[1] = (char)('a' + frame % UC_GRID);
    out[2] = 0;
}

int uc_frame_index(const char *s)
{
    if (!s || s[0] < 'a' || s[0] > 'z' || s[1] < 'a' || s[1] > 'z' || s[2]) return -1;
    return (s[0] - 'a') * UC_GRID + (s[1] - 'a');
}

/* ---- PNG --------------------------------------------------------------- */

static void put32(uint8_t *p, uint32_t v) { p[0] = v >> 24; p[1] = v >> 16; p[2] = v >> 8; p[3] = v; }
static uint32_t get32(const uint8_t *p) { return (uint32_t)p[0] << 24 | p[1] << 16 | p[2] << 8 | p[3]; }

static uint8_t *chunk(uint8_t *p, const char *type, const uint8_t *data, uint32_t len)
{
    put32(p, len);
    memcpy(p + 4, type, 4);
    if (len) memcpy(p + 8, data, len);
    uLong crc = crc32(0, p + 4, len + 4);
    put32(p + 8 + len, (uint32_t)crc);
    return p + 12 + len;
}

int uc_png_encode(const uint8_t *rgb, unsigned w, unsigned h, uint8_t **out, size_t *outlen)
{
    size_t stride = (size_t)w * 3, rawlen = (stride + 1) * h;
    uint8_t *raw = malloc(rawlen);
    if (!raw) return fail("out of memory");
    for (unsigned y = 0; y < h; y++) {
        raw[y * (stride + 1)] = 0;
        memcpy(raw + y * (stride + 1) + 1, rgb + y * stride, stride);
    }
    uLongf zlen = compressBound(rawlen);
    uint8_t *png = malloc(zlen + 8 + 25 + 12 + 12);
    if (!png) { free(raw); return fail("out of memory"); }
    uint8_t *z = png + 8 + 25 + 8;           /* compress straight into the IDAT body */
    if (compress2(z, &zlen, raw, rawlen, 6) != Z_OK) { free(raw); free(png); return fail("deflate failed"); }
    free(raw);

    static const uint8_t sig[8] = { 137, 'P', 'N', 'G', 13, 10, 26, 10 };
    uint8_t ihdr[13];
    put32(ihdr, w); put32(ihdr + 4, h);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = ihdr[11] = ihdr[12] = 0;
    memcpy(png, sig, 8);
    uint8_t *p = chunk(png + 8, "IHDR", ihdr, 13);
    put32(p, (uint32_t)zlen);
    memcpy(p + 4, "IDAT", 4);
    put32(p + 8 + zlen, (uint32_t)crc32(0, p + 4, (uInt)zlen + 4));
    p = chunk(p + 12 + zlen, "IEND", NULL, 0);
    *out = png;
    *outlen = (size_t)(p - png);
    return 0;
}

static uint8_t paeth(int a, int b, int c)
{
    int p = a + b - c, pa = abs(p - a), pb = abs(p - b), pc = abs(p - c);
    return (uint8_t)(pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
}

int uc_png_decode(const uint8_t *png, size_t len, unsigned want_w, unsigned want_h, uint8_t *rgb)
{
    if (len < 8 || memcmp(png, "\x89PNG\r\n\x1a\n", 8)) return fail("not a PNG");
    unsigned w = 0, h = 0, bpp = 0;
    z_stream zs = { 0 };
    size_t stride = 0, rawlen = 0;
    uint8_t *raw = NULL;
    int ret = -1, started = 0, done = 0;

    for (size_t pos = 8; pos + 12 <= len;) {
        uint32_t clen = get32(png + pos);
        const uint8_t *type = png + pos + 4, *data = png + pos + 8;
        if (clen > len - pos - 12) { fail("truncated PNG chunk"); goto out; }
        if (!memcmp(type, "IHDR", 4)) {
            w = get32(data); h = get32(data + 4);
            if (data[8] != 8 || (data[9] != 2 && data[9] != 6) || data[12]) {
                fail("PNG must be 8-bit RGB or RGBA, non-interlaced"); goto out;
            }
            if (w != want_w || h != want_h) { fail("PNG is %ux%u, expected %ux%u", w, h, want_w, want_h); goto out; }
            bpp = data[9] == 6 ? 4 : 3;
            stride = (size_t)w * bpp;
            rawlen = (stride + 1) * h;
            if (!(raw = malloc(rawlen))) { fail("out of memory"); goto out; }
            if (inflateInit(&zs) != Z_OK) { fail("inflate init failed"); goto out; }
            started = 1;
            zs.next_out = raw;
            zs.avail_out = (uInt)rawlen;
        } else if (!memcmp(type, "IDAT", 4)) {
            if (!started) { fail("IDAT before IHDR"); goto out; }
            if (done) goto skip;
            zs.next_in = (Bytef *)data;
            zs.avail_in = clen;
            int r = inflate(&zs, Z_NO_FLUSH);
            if (r == Z_STREAM_END) done = 1;
            else if (r != Z_OK && r != Z_BUF_ERROR) { fail("corrupt PNG data"); goto out; }
        } else if (!memcmp(type, "IEND", 4)) break;
    skip:
        pos += 12 + clen;
    }
    if (!started) { fail("PNG has no IHDR"); goto out; }
    if (zs.total_out != rawlen) { fail("PNG data is short"); goto out; }

    for (unsigned y = 0; y < h; y++) {
        uint8_t *row = raw + y * (stride + 1), f = row[0], *cur = row + 1;
        const uint8_t *prev = y ? raw + (y - 1) * (stride + 1) + 1 : NULL;
        for (size_t i = 0; i < stride; i++) {
            int a = i >= bpp ? cur[i - bpp] : 0, b = prev ? prev[i] : 0, c = prev && i >= bpp ? prev[i - bpp] : 0;
            switch (f) {
            case 0: break;
            case 1: cur[i] += a; break;
            case 2: cur[i] += b; break;
            case 3: cur[i] += (uint8_t)((a + b) / 2); break;
            case 4: cur[i] += paeth(a, b, c); break;
            default: fail("bad PNG filter %d", f); goto out;
            }
        }
        if (bpp == 3) memcpy(rgb + (size_t)y * w * 3, cur, stride);
        else for (unsigned x = 0; x < w; x++) memcpy(rgb + ((size_t)y * w + x) * 3, cur + x * 4, 3);
    }
    ret = 0;
out:
    if (started) inflateEnd(&zs);
    free(raw);
    return ret;
}

/* ---- zip --------------------------------------------------------------- */

static void le16(uint8_t *p, uint16_t v) { p[0] = v; p[1] = v >> 8; }
static void le32(uint8_t *p, uint32_t v) { le16(p, v); le16(p + 2, v >> 16); }
static void le64(uint8_t *p, uint64_t v) { le32(p, (uint32_t)v); le32(p + 4, (uint32_t)(v >> 32)); }
static uint16_t rd16(const uint8_t *p) { return (uint16_t)(p[0] | p[1] << 8); }
static uint32_t rd32(const uint8_t *p) { return rd16(p) | (uint32_t)rd16(p + 2) << 16; }
static uint64_t rd64(const uint8_t *p) { return rd32(p) | (uint64_t)rd32(p + 4) << 32; }

typedef struct { char name[16]; uint32_t crc, size; uint64_t offset; } zent_t;

/* Frame idx of the given format as a mosaic rectangle. */
static void frame_rect(enum uc_format fmt, unsigned idx, unsigned *X, unsigned *Y, unsigned *w, unsigned *h)
{
    unsigned cols = fmt == UC_FMT_HD ? UC_GRID : UC_GRID / 2;
    *w = fmt == UC_FMT_HD ? UC_W : UC_W4K;
    *h = fmt == UC_FMT_HD ? UC_H : UC_H4K;
    *X = idx % cols * *w;
    *Y = idx / cols * *h;
}

static int frame_bytes(const uc_t *u, enum uc_format fmt, unsigned idx, uint8_t *buf, char *name)
{
    unsigned X, Y, w, h;
    frame_rect(fmt, idx, &X, &Y, &w, &h);
    if (uc_rect_is_zero(u, X, Y, w, h)) return 0;
    uc_rect_read(u, X, Y, w, h, buf);
    if (fmt == UC_FMT_HD) { uc_frame_name(idx, name); strcat(name, ".png"); }
    else sprintf(name, "%u.png", idx + 1);
    return 1;
}

int uc_save(const uc_t *u, const char *path, enum uc_format fmt)
{
    unsigned count = fmt == UC_FMT_HD ? UC_FRAMES : UC_FRAMES4K;
    unsigned w = fmt == UC_FMT_HD ? UC_W : UC_W4K, h = fmt == UC_FMT_HD ? UC_H : UC_H4K;
    FILE *f = fopen(path, "wb");
    if (!f) return fail("cannot write %s", path);
    uint8_t *buf = malloc(fmt == UC_FMT_HD ? UC_FRAME_BYTES : UC_FRAME4K_BYTES);
    zent_t *ents = calloc(count, sizeof *ents);
    unsigned n = 0;
    uint64_t pos = 0;
    int ret = -1;
    if (!buf || !ents) { fail("out of memory"); goto out; }

    for (unsigned i = 0; i < count; i++) {
        zent_t *e = &ents[n];
        if (!frame_bytes(u, fmt, i, buf, e->name)) continue;
        uint8_t *png; size_t plen;
        if (uc_png_encode(buf, w, h, &png, &plen)) goto out;
        e->crc = (uint32_t)crc32(0, png, (uInt)plen);
        e->size = (uint32_t)plen;
        e->offset = pos;
        uint8_t lh[30] = { 0 };
        size_t nl = strlen(e->name);
        le32(lh, 0x04034b50); le16(lh + 4, 20); le16(lh + 12, 0x21); le32(lh + 14, e->crc);
        le32(lh + 18, e->size); le32(lh + 22, e->size); le16(lh + 26, (uint16_t)nl);
        int ok = fwrite(lh, 30, 1, f) == 1 && fwrite(e->name, nl, 1, f) == 1 && fwrite(png, plen, 1, f) == 1;
        free(png);
        if (!ok) { fail("write failed"); goto out; }
        pos += 30 + nl + plen;
        n++;
    }

    /* Central directory. Offsets past 4 GiB (only possible when nearly every
     * frame is full of noise) use zip64 extra fields. */
    uint64_t cd_start = pos, cd_size = 0;
    for (unsigned i = 0; i < n; i++) {
        zent_t *e = &ents[i];
        int z64 = e->offset >= 0xffffffffu;
        uint8_t ch[46] = { 0 }, ex[12];
        size_t nl = strlen(e->name);
        le32(ch, 0x02014b50); le16(ch + 4, z64 ? 45 : 20); le16(ch + 6, z64 ? 45 : 20); le16(ch + 14, 0x21);
        le32(ch + 16, e->crc); le32(ch + 20, e->size); le32(ch + 24, e->size);
        le16(ch + 28, (uint16_t)nl); le16(ch + 30, z64 ? 12 : 0);
        le32(ch + 42, z64 ? 0xffffffffu : (uint32_t)e->offset);
        le16(ex, 1); le16(ex + 2, 8); le64(ex + 4, e->offset);
        if (fwrite(ch, 46, 1, f) != 1 || fwrite(e->name, nl, 1, f) != 1 || (z64 && fwrite(ex, 12, 1, f) != 1)) {
            fail("write failed"); goto out;
        }
        cd_size += 46 + nl + (z64 ? 12 : 0);
    }
    if (cd_start + cd_size >= 0xffffffffu) {
        uint8_t z[56 + 20] = { 0 };
        le32(z, 0x06064b50); le64(z + 4, 44); le16(z + 12, 45); le16(z + 14, 45);
        le64(z + 24, n); le64(z + 32, n); le64(z + 40, cd_size); le64(z + 48, cd_start);
        le32(z + 56, 0x07064b50); le64(z + 64, cd_start + cd_size); le32(z + 72, 1);
        if (fwrite(z, sizeof z, 1, f) != 1) { fail("write failed"); goto out; }
    }
    uint8_t eo[22] = { 0 };
    le32(eo, 0x06054b50); le16(eo + 8, (uint16_t)n); le16(eo + 10, (uint16_t)n);
    le32(eo + 12, cd_size >= 0xffffffffu ? 0xffffffffu : (uint32_t)cd_size);
    le32(eo + 16, cd_start >= 0xffffffffu ? 0xffffffffu : (uint32_t)cd_start);
    if (fwrite(eo, 22, 1, f) != 1) { fail("write failed"); goto out; }
    ret = 0;
out:
    if (fclose(f) && !ret) ret = fail("write failed");
    free(buf);
    free(ents);
    return ret;
}

static int parse_frame_name(const char *name, size_t nl, enum uc_format *fmt, unsigned *idx)
{
    if (nl < 5 || memcmp(name + nl - 4, ".png", 4)) return 0;
    size_t stem = nl - 4;
    if (stem == 2 && name[0] >= 'a' && name[0] <= 'z' && name[1] >= 'a' && name[1] <= 'z') {
        *fmt = UC_FMT_HD;
        *idx = (unsigned)((name[0] - 'a') * UC_GRID + (name[1] - 'a'));
        return 1;
    }
    if (stem >= 1 && stem <= 3 && name[0] != '0') {
        unsigned v = 0;
        for (size_t i = 0; i < stem; i++) {
            if (name[i] < '0' || name[i] > '9') return 0;
            v = v * 10 + (unsigned)(name[i] - '0');
        }
        if (v < 1 || v > UC_FRAMES4K) return 0;
        *fmt = UC_FMT_4K;
        *idx = v - 1;
        return 1;
    }
    return 0;
}

static int read_at(FILE *f, uint64_t off, void *buf, size_t n)
{
    return fseeko(f, (off_t)off, SEEK_SET) == 0 && fread(buf, 1, n, f) == n;
}

static uint8_t *entry_data(FILE *f, uint64_t lho, int method, uint64_t csize, uint64_t usize)
{
    uint8_t lh[30];
    if (!read_at(f, lho, lh, 30) || rd32(lh) != 0x04034b50) { fail("bad local header"); return NULL; }
    uint64_t data = lho + 30 + rd16(lh + 26) + rd16(lh + 28);
    uint8_t *comp = malloc(csize ? csize : 1), *out = NULL;
    if (!comp) { fail("out of memory"); return NULL; }
    if (!read_at(f, data, comp, (size_t)csize)) { fail("truncated zip entry"); goto done; }
    if (method == 0) { out = comp; comp = NULL; goto done; }
    if (method != 8) { fail("unsupported zip compression method %d", method); goto done; }
    if (!(out = malloc(usize ? usize : 1))) { fail("out of memory"); goto done; }
    z_stream zs = { 0 };
    inflateInit2(&zs, -15);
    zs.next_in = comp; zs.avail_in = (uInt)csize;
    zs.next_out = out; zs.avail_out = (uInt)usize;
    int r = inflate(&zs, Z_FINISH);
    inflateEnd(&zs);
    if (r != Z_STREAM_END || zs.total_out != usize) { fail("corrupt zip entry"); free(out); out = NULL; }
done:
    free(comp);
    return out;
}

int uc_load(uc_t *u, const char *path, enum uc_format *fmt_out)
{
    FILE *f = fopen(path, "rb");
    if (!f) return fail("cannot open %s", path);
    int ret = -1, seen = -1;
    uint8_t *cd = NULL, *rgb = NULL;
    fseeko(f, 0, SEEK_END);
    uint64_t fsize = (uint64_t)ftello(f);
    size_t tail = fsize < 65557 ? (size_t)fsize : 65557;
    uint8_t *t = malloc(tail ? tail : 1);
    if (!t || !read_at(f, fsize - tail, t, tail)) { fail("cannot read %s", path); goto out; }
    long eo = -1;
    for (long i = (long)tail - 22; i >= 0; i--) if (rd32(t + i) == 0x06054b50) { eo = i; break; }
    if (eo < 0) { fail("%s is not a zip file", path); goto out; }
    uint64_t n = rd16(t + eo + 10), cd_size = rd32(t + eo + 12), cd_off = rd32(t + eo + 16);
    if (eo >= 20 && rd32(t + eo - 20) == 0x07064b50) {
        uint8_t z[56];
        if (!read_at(f, rd64(t + eo - 20 + 8), z, 56) || rd32(z) != 0x06064b50) { fail("bad zip64 record"); goto out; }
        n = rd64(z + 32); cd_size = rd64(z + 40); cd_off = rd64(z + 48);
    }
    if (!(cd = malloc(cd_size ? cd_size : 1)) || !read_at(f, cd_off, cd, (size_t)cd_size)) {
        fail("cannot read zip directory"); goto out;
    }
    rgb = malloc(UC_FRAME4K_BYTES);
    if (!rgb) { fail("out of memory"); goto out; }

    size_t p = 0;
    for (uint64_t i = 0; i < n; i++) {
        if (p + 46 > cd_size || rd32(cd + p) != 0x02014b50) { fail("bad zip directory"); goto out; }
        int method = rd16(cd + p + 10);
        uint64_t csize = rd32(cd + p + 20), usize = rd32(cd + p + 24), lho = rd32(cd + p + 42);
        size_t nl = rd16(cd + p + 28), xl = rd16(cd + p + 30), cl = rd16(cd + p + 32);
        const char *name = (const char *)cd + p + 46;
        for (size_t x = 0; x + 4 <= xl;) {                 /* zip64 extra field */
            const uint8_t *ex = cd + p + 46 + nl + x;
            size_t sz = rd16(ex + 2), q = 4;
            if (rd16(ex) == 1) {
                if (usize == 0xffffffffu && q + 8 <= sz + 4) { usize = rd64(ex + q); q += 8; }
                if (csize == 0xffffffffu && q + 8 <= sz + 4) { csize = rd64(ex + q); q += 8; }
                if (lho == 0xffffffffu && q + 8 <= sz + 4) { lho = rd64(ex + q); }
            }
            x += 4 + sz;
        }
        p += 46 + nl + xl + cl;

        enum uc_format fmt;
        unsigned idx;
        if (!parse_frame_name(name, nl, &fmt, &idx)) continue;
        if (seen >= 0 && seen != (int)fmt) { fail("zip mixes HD and 4K frame names"); goto out; }
        seen = (int)fmt;
        uint8_t *png = entry_data(f, lho, method, csize, usize);
        if (!png) goto out;
        unsigned w = fmt == UC_FMT_HD ? UC_W : UC_W4K, h = fmt == UC_FMT_HD ? UC_H : UC_H4K;
        int r = uc_png_decode(png, (size_t)usize, w, h, rgb);
        free(png);
        if (r) { fail("%.*s: %s", (int)nl, name, uc_error()); goto out; }
        unsigned X, Y, fw, fh;
        frame_rect(fmt, idx, &X, &Y, &fw, &fh);
        if (uc_rect_write(u, X, Y, fw, fh, rgb)) goto out;
    }
    if (fmt_out) *fmt_out = seen < 0 ? UC_FMT_HD : (enum uc_format)seen;
    ret = 0;
out:
    fclose(f);
    free(t);
    free(cd);
    free(rgb);
    return ret;
}

/* ---- objects ----------------------------------------------------------- */

static int header_field(const char *hdr, const char *key, char *out, size_t max)
{
    size_t kl = strlen(key);
    for (const char *l = hdr; *l; ) {
        const char *e = strchr(l, '\n');
        size_t ll = e ? (size_t)(e - l) : strlen(l);
        if (ll > kl + 1 && !strncmp(l, key, kl) && l[kl] == ':') {
            const char *v = l + kl + 1;
            while (*v == ' ') v++;
            size_t vl = ll - (size_t)(v - l);
            if (vl >= max) vl = max - 1;
            memcpy(out, v, vl);
            out[vl] = 0;
            return 1;
        }
        if (!e) break;
        l = e + 1;
    }
    return 0;
}

static int parse_object(const uc_t *u, uint32_t page, uc_obj_t *o)
{
    uint8_t buf[UC_PAGE + 1];
    if (!u->pages[page] || memcmp(u->pages[page], UC_OBJ_MAGIC, 7)) return 0;
    memcpy(buf, u->pages[page], UC_PAGE);
    buf[UC_PAGE] = 0;
    char *end = strstr((char *)buf, "\n\n");
    if (!end) return 0;
    end[1] = 0;
    char num[32] = "", crc[32] = "";
    memset(o, 0, sizeof *o);
    if (!header_field((char *)buf, "name", o->name, sizeof o->name) ||
        !header_field((char *)buf, "type", o->type, sizeof o->type) ||
        !header_field((char *)buf, "length", num, sizeof num) ||
        !header_field((char *)buf, "crc32", crc, sizeof crc)) return 0;
    header_field((char *)buf, "frames", o->frames, sizeof o->frames);
    o->page = page;
    o->length = strtoull(num, NULL, 10);
    o->crc32 = (uint32_t)strtoul(crc, NULL, 16);
    o->payload_addr = (uint64_t)page * UC_PAGE + (size_t)(end + 2 - (char *)buf);
    if (o->payload_addr + o->length > UC_BYTES) return 0;
    uLong c = crc32(0, NULL, 0);
    uint8_t chunkbuf[65536];
    for (uint64_t off = 0; off < o->length; off += sizeof chunkbuf) {
        size_t m = o->length - off < sizeof chunkbuf ? (size_t)(o->length - off) : sizeof chunkbuf;
        uc_read(u, o->payload_addr + off, chunkbuf, m);
        c = crc32(c, chunkbuf, (uInt)m);
    }
    o->crc_ok = (uint32_t)c == o->crc32;
    return 1;
}

size_t uc_scan_objects(const uc_t *u, uc_obj_t *objs, size_t max)
{
    size_t n = 0;
    for (uint32_t p = 0; p < UC_PAGES && n < max; p++)
        if (parse_object(u, p, &objs[n])) n++;
    return n;
}

long uc_embed(uc_t *u, long page, const char *name, const char *type,
              const char *frames, const uint8_t *data, size_t len, int force)
{
    char hdr[UC_PAGE];
    for (const char *s = name; *s; s++) if (*s == '\n') return fail("name may not contain newlines");
    int hl = snprintf(hdr, sizeof hdr, "UCOBJ1\nname: %s\ntype: %s\nlength: %zu\ncrc32: %08lx\n%s%s%s\n",
                      name, type, len, (unsigned long)crc32(0, data, (uInt)len),
                      frames && *frames ? "frames: " : "", frames && *frames ? frames : "",
                      frames && *frames ? "\n" : "");
    if (hl < 0 || hl >= (int)sizeof hdr) return fail("object header too long");
    uint64_t total = (uint64_t)hl + len, npages = (total + UC_PAGE - 1) / UC_PAGE;
    if (page < 0) {
        uint64_t run = 0;
        for (uint32_t p = UC_OBJ_AREA_PAGE; p < UC_TICK_PAGE; p++) {
            run = uc_page_is_zero(u, p) ? run + 1 : 0;
            if (run == npages) { page = (long)(p - npages + 1); break; }
        }
        if (page < 0) return fail("no free run of %llu pages in the object area", (unsigned long long)npages);
    } else if ((uint64_t)page + npages > UC_PAGES) {
        return fail("object does not fit at page %ld", page);
    } else if (!force) {
        for (uint64_t p = (uint64_t)page; p < (uint64_t)page + npages; p++)
            if (!uc_page_is_zero(u, (uint32_t)p))
                return fail("page %llu is not empty (use --force to overwrite)", (unsigned long long)p);
    }
    uint64_t addr = (uint64_t)page * UC_PAGE;
    if (uc_write(u, addr, hdr, (size_t)hl) || uc_write(u, addr + hl, data, len)) return -1;
    return page;
}
