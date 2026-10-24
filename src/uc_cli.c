/* uc_cli.c - command line tool for UC4205260800B instances. Run `uc help`. */
#define _FILE_OFFSET_BITS 64
#include "uc.h"

#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>

static void usage(void)
{
    puts("uc - Lush Stemsys Unit Computer UC4205260800B tools\n"
         "\n"
         "  uc info                         memory geometry\n"
         "  uc facts [--prime]              verify the README's number facts (--prime: ~10 s sieve)\n"
         "  uc where ADDR                   explain an address\n"
         "  uc new OUT.zip                  write an empty instance\n"
         "  uc stat FILE.zip                summary of an instance\n"
         "  uc convert IN.zip OUT.zip [--hd|--4k]\n"
         "  uc peek FILE.zip ADDR [LEN]     hex dump\n"
         "  uc poke FILE.zip ADDR < data    write stdin at ADDR and save in place\n"
         "  uc ls FILE.zip                  list embedded objects\n"
         "  uc cat FILE.zip NAME            print an object's payload\n"
         "  uc embed FILE.zip NAME TYPE PATH [--page N] [--frames aa,ab] [--force]\n"
         "  uc export FILE.zip FRAME OUT.png\n"
         "  uc import FILE.zip FRAME IN.png\n"
         "  uc ticklog FILE.zip [N]         last N tick log records\n"
         "\n"
         "ADDR is decimal, 0x hex, pN (page N) or FRAME:X,Y (e.g. ab:10,20).");
}

static int die(const char *what)
{
    fprintf(stderr, "uc: %s%s%s\n", what, *uc_error() ? ": " : "", uc_error());
    return 1;
}

static int parse_addr(const char *s, uint64_t *out)
{
    char *end;
    if (s[0] == 'p' && s[1] >= '0' && s[1] <= '9') {
        uint64_t p = strtoull(s + 1, &end, 10);
        if (*end || p >= UC_PAGES) return -1;
        *out = p * UC_PAGE;
        return 0;
    }
    const char *colon = strchr(s, ':');
    if (colon && colon - s == 2) {
        char name[3] = { s[0], s[1], 0 };
        int f = uc_frame_index(name);
        unsigned x, y;
        if (f < 0 || sscanf(colon + 1, "%u,%u", &x, &y) != 2 || x >= UC_W || y >= UC_H) return -1;
        *out = (uint64_t)f * UC_FRAME_BYTES + ((uint64_t)y * UC_W + x) * 3;
        return 0;
    }
    *out = strtoull(s, &end, 0);
    return *end || *out >= UC_BYTES ? -1 : 0;
}

static uc_t *load(const char *path, enum uc_format *fmt)
{
    uc_t *u = uc_new();
    if (!u) { fprintf(stderr, "uc: out of memory\n"); exit(1); }
    if (uc_load(u, path, fmt)) { die(path); exit(1); }
    return u;
}

static uint8_t *slurp(FILE *f, size_t *len)
{
    size_t cap = 1 << 16, n = 0;
    uint8_t *buf = malloc(cap);
    for (size_t r; buf && (r = fread(buf + n, 1, cap - n, f)) > 0;) {
        n += r;
        if (n == cap) buf = realloc(buf, cap *= 2);
    }
    *len = n;
    return buf;
}

static uint64_t ndivisors(uint64_t x)
{
    uint64_t c = 1;
    for (uint64_t p = 2; p * p <= x; p++) {
        uint64_t e = 0;
        while (x % p == 0) { x /= p; e++; }
        c *= e + 1;
    }
    return x > 1 ? c * 2 : c;
}

static int is_prime(uint64_t x)
{
    if (x < 2) return 0;
    for (uint64_t d = 2; d * d <= x; d++) if (x % d == 0) return 0;
    return 1;
}

/* Count primes <= n with a segmented sieve of Eratosthenes. */
static uint64_t prime_pi(uint64_t n)
{
    uint64_t r = 1;
    while ((r + 1) * (r + 1) <= n) r++;
    uint8_t *small = calloc(r + 1, 1), *seg = malloc(1 << 20);
    uint32_t *pr = malloc(sizeof *pr * (r + 1));
    size_t np = 0;
    for (uint64_t i = 2; i <= r; i++) {
        if (small[i]) continue;
        pr[np++] = (uint32_t)i;
        for (uint64_t j = i * i; j <= r; j += i) small[j] = 1;
    }
    uint64_t count = 0;
    for (uint64_t lo = 2; lo <= n; lo += 1 << 20) {
        uint64_t hi = lo + (1 << 20) - 1 < n ? lo + (1 << 20) - 1 : n;
        memset(seg, 0, hi - lo + 1);
        for (size_t k = 0; k < np && (uint64_t)pr[k] * pr[k] <= hi; k++) {
            uint64_t p = pr[k], st = (lo + p - 1) / p * p;
            if (st < p * p) st = p * p;
            for (uint64_t j = st; j <= hi; j += p) seg[j - lo] = 1;
        }
        for (uint64_t j = 0; j <= hi - lo; j++) count += !seg[j];
    }
    free(small); free(seg); free(pr);
    return count;
}

static int check(int ok, const char *what)
{
    printf("%s  %s\n", ok ? "ok  " : "FAIL", what);
    return ok ? 0 : 1;
}

static int cmd_facts(int prime)
{
    uint64_t n = UC_BYTES;
    int bad = 0;
    bad += check(n * 8 == 33642086400ULL, "4205260800 bytes = 33642086400 bits");
    bad += check(1920ULL * 1080 * 3 * 676 == n, "1920 x 1080 x 3 x 676 = 4205260800 (676 HD frames, aa..zz)");
    bad += check(3840ULL * 2160 * 3 * 169 == n, "3840 x 2160 x 3 x 169 = 4205260800 (169 4K frames)");
    bad += check(49920ULL * 28080 * 3 == n, "49920 x 28080 x 3 = 4205260800 (one mosaic framebuffer)");
    bad += check(4096ULL * 1026675 == n, "4096 x 1026675 = 4205260800 (pages)");
    bad += check((1ULL << 32) - n == 89706496, "2^32 - 4205260800 = 89706496 unaddressed bytes");
    bad += check(1474560ULL * 8 == 11796480, "a 1.44 MB floppy is 1474560 bytes = 11796480 bits");
    bad += check(ndivisors(n) == 702, "4205260800 has 702 divisors");
    bad += check(ndivisors(n * 8) == 864, "33642086400 has 864 divisors");
    bad += check(is_prime(n - 1), "4205260799 is prime");
    if (prime) bad += check(prime_pi(n - 1) == 199234207, "4205260799 is the 199234207th prime");
    else puts("skip  4205260799 is the 199234207th prime (run with --prime)");
    return bad ? 1 : 0;
}

static void cmd_where(uint64_t a)
{
    unsigned frame = (unsigned)(a / UC_FRAME_BYTES);
    uint64_t off = a % UC_FRAME_BYTES;
    unsigned px = (unsigned)(off / 3), x = px % UC_W, y = px / UC_W;
    uint64_t off4 = a % UC_FRAME4K_BYTES;
    char name[3];
    uc_frame_name(frame, name);
    printf("address  %" PRIu64 " (0x%" PRIx64 ")\n", a, a);
    printf("page     %" PRIu64 " + %" PRIu64 "\n", a / UC_PAGE, a % UC_PAGE);
    printf("frame    %s (#%u) pixel %u,%u channel %c\n", name, frame, x, y, "RGB"[off % 3]);
    printf("mosaic   %u,%u\n", (frame % UC_GRID) * UC_W + x, (frame / UC_GRID) * UC_H + y);
    printf("4k image %" PRIu64 ".png pixel %" PRIu64 ",%" PRIu64 "\n", a / UC_FRAME4K_BYTES + 1,
           off4 / 3 % UC_W4K, off4 / 3 / UC_W4K);
}

static void hexdump(const uc_t *u, uint64_t a, size_t len)
{
    uint8_t row[16];
    for (size_t i = 0; i < len; i += 16) {
        size_t n = len - i < 16 ? len - i : 16;
        uc_read(u, a + i, row, n);
        printf("%010" PRIx64 "  ", a + i);
        for (size_t j = 0; j < 16; j++) j < n ? printf("%02x ", row[j]) : printf("   ");
        printf(" |");
        for (size_t j = 0; j < n; j++) putchar(row[j] >= 32 && row[j] < 127 ? row[j] : '.');
        puts("|");
    }
}

static void ticklog(const uc_t *u, unsigned want)
{
    uint8_t h[20];
    uc_read(u, (uint64_t)UC_TICK_PAGE * UC_PAGE, h, sizeof h);
    if (memcmp(h, "UCTICK1", 8)) { puts("no tick log"); return; }
    uint32_t tick = h[8] | h[9] << 8 | h[10] << 16 | (uint32_t)h[11] << 24;
    uint32_t total = h[12] | h[13] << 8 | h[14] << 16 | (uint32_t)h[15] << 24;
    printf("tick %u, %u damage records\n", tick, total);
    uint32_t first = total > want ? total - want : 0;
    if (total - first > UC_TICK_CAP) first = total - UC_TICK_CAP;
    for (uint32_t r = first; r < total; r++) {
        uint8_t d[16];
        uc_read(u, ((uint64_t)UC_TICK_PAGE + 1) * UC_PAGE + (uint64_t)(r % UC_TICK_CAP) * 16, d, 16);
        char name[3];
        uc_frame_name(d[4] | d[5] << 8, name);
        printf("  tick %-8u %s %4u,%-4u %4ux%u\n", d[0] | d[1] << 8 | d[2] << 16 | (uint32_t)d[3] << 24,
               name, d[6] | d[7] << 8, d[8] | d[9] << 8, d[10] | d[11] << 8, d[12] | d[13] << 8);
    }
}

static void stat(const uc_t *u, enum uc_format fmt)
{
    unsigned frames = 0;
    char line[UC_GRID + 1];
    printf("saved as  %s\n", fmt == UC_FMT_HD ? "HD (aa.png..zz.png)" : "4K (1.png..169.png)");
    uint64_t pages = uc_nonzero_pages(u);
    printf("pages     %" PRIu64 " of %u in use (%.4f%%)\n", pages, UC_PAGES, 100.0 * pages / UC_PAGES);
    puts("frames    (# = has data)\n          abcdefghijklmnopqrstuvwxyz");
    for (unsigned r = 0; r < UC_GRID; r++) {
        for (unsigned c = 0; c < UC_GRID; c++) {
            int used = !uc_range_is_zero(u, (uint64_t)(r * UC_GRID + c) * UC_FRAME_BYTES, UC_FRAME_BYTES);
            line[c] = used ? '#' : '.';
            frames += used;
        }
        line[UC_GRID] = 0;
        printf("        %c %s\n", 'a' + r, line);
    }
    printf("          %u of %u HD frames in use\n", frames, UC_FRAMES);
    uc_obj_t objs[64];
    size_t n = uc_scan_objects(u, objs, 64);
    printf("objects   %zu\n", n);
}

int main(int argc, char **argv)
{
    if (argc < 2 || !strcmp(argv[1], "help") || !strcmp(argv[1], "-h") || !strcmp(argv[1], "--help")) {
        usage();
        return argc < 2;
    }
    const char *cmd = argv[1];
    enum uc_format fmt;
    uint64_t addr;

    if (!strcmp(cmd, "info")) {
        printf("bytes     %llu (%llu bits)\n", UC_BYTES, UC_BYTES * 8);
        printf("pages     %u x %u bytes\n", UC_PAGES, UC_PAGE);
        printf("HD        %u frames of %ux%u RGB (aa..zz, 26x26 grid)\n", UC_FRAMES, UC_W, UC_H);
        printf("4K        %u frames of %ux%u RGB (1..169, 13x13 grid)\n", UC_FRAMES4K, UC_W4K, UC_H4K);
        printf("mosaic    %ux%u RGB\n", UC_MOSAIC_W, UC_MOSAIC_H);
        printf("objects   auto-placed from page %u\n", UC_OBJ_AREA_PAGE);
        printf("tick log  pages %u..%u\n", UC_TICK_PAGE, UC_PAGES - 1);
        return 0;
    }
    if (!strcmp(cmd, "facts")) return cmd_facts(argc > 2 && !strcmp(argv[2], "--prime"));
    if (!strcmp(cmd, "where") && argc == 3) {
        if (parse_addr(argv[2], &addr)) { fprintf(stderr, "uc: bad address %s\n", argv[2]); return 1; }
        cmd_where(addr);
        return 0;
    }
    if (!strcmp(cmd, "new") && argc == 3) {
        uc_t *u = uc_new();
        int r = uc_save(u, argv[2], UC_FMT_HD);
        uc_free(u);
        return r ? die(argv[2]) : 0;
    }
    if (argc < 3) { usage(); return 1; }
    const char *file = argv[2];
    uc_t *u = load(file, &fmt);
    int ret = 0;

    if (!strcmp(cmd, "stat")) {
        stat(u, fmt);
    } else if (!strcmp(cmd, "convert") && argc >= 4) {
        enum uc_format to = argc > 4 && !strcmp(argv[4], "--4k") ? UC_FMT_4K
                          : argc > 4 && !strcmp(argv[4], "--hd") ? UC_FMT_HD : fmt;
        if (uc_save(u, argv[3], to)) ret = die(argv[3]);
    } else if (!strcmp(cmd, "peek") && argc >= 4) {
        if (parse_addr(argv[3], &addr)) { fprintf(stderr, "uc: bad address %s\n", argv[3]); ret = 1; }
        else hexdump(u, addr, argc > 4 ? strtoul(argv[4], NULL, 0) : 256);
    } else if (!strcmp(cmd, "poke") && argc >= 4) {
        size_t len;
        uint8_t *data = slurp(stdin, &len);
        if (parse_addr(argv[3], &addr)) { fprintf(stderr, "uc: bad address %s\n", argv[3]); ret = 1; }
        else if (uc_write(u, addr, data, len) || uc_save(u, file, fmt)) ret = die("poke");
        else printf("wrote %zu bytes at %" PRIu64 "\n", len, addr);
        free(data);
    } else if (!strcmp(cmd, "ls")) {
        uc_obj_t objs[1024];
        size_t n = uc_scan_objects(u, objs, 1024);
        for (size_t i = 0; i < n; i++)
            printf("p%-8u %10" PRIu64 "  %-4s %-36s %s%s%s\n", objs[i].page, objs[i].length,
                   objs[i].crc_ok ? "ok" : "BAD", objs[i].type, objs[i].name,
                   *objs[i].frames ? "  frames=" : "", objs[i].frames);
    } else if (!strcmp(cmd, "cat") && argc == 4) {
        uc_obj_t objs[1024];
        size_t n = uc_scan_objects(u, objs, 1024), i;
        for (i = 0; i < n && strcmp(objs[i].name, argv[3]); i++);
        if (i == n) { fprintf(stderr, "uc: no object named %s\n", argv[3]); ret = 1; }
        else {
            uint8_t *buf = malloc(objs[i].length ? objs[i].length : 1);
            uc_read(u, objs[i].payload_addr, buf, objs[i].length);
            fwrite(buf, 1, objs[i].length, stdout);
            free(buf);
        }
    } else if (!strcmp(cmd, "embed") && argc >= 6) {
        long page = -1;
        const char *frames = NULL;
        int force = 0;
        for (int i = 6; i < argc; i++) {
            if (!strcmp(argv[i], "--page") && i + 1 < argc) page = strtol(argv[++i], NULL, 0);
            else if (!strcmp(argv[i], "--frames") && i + 1 < argc) frames = argv[++i];
            else if (!strcmp(argv[i], "--force")) force = 1;
        }
        FILE *in = fopen(argv[5], "rb");
        size_t len;
        uint8_t *data = in ? slurp(in, &len) : NULL;
        if (in) fclose(in);
        long at;
        if (!data) { fprintf(stderr, "uc: cannot read %s\n", argv[5]); ret = 1; }
        else if ((at = uc_embed(u, page, argv[3], argv[4], frames, data, len, force)) < 0 || uc_save(u, file, fmt))
            ret = die("embed");
        else printf("embedded %s (%zu bytes) at page %ld\n", argv[3], len, at);
        free(data);
    } else if ((!strcmp(cmd, "export") || !strcmp(cmd, "import")) && argc == 5) {
        int f = uc_frame_index(argv[3]);
        uint8_t *rgb = malloc(UC_FRAME_BYTES);
        if (f < 0) { fprintf(stderr, "uc: bad frame name %s (aa..zz)\n", argv[3]); ret = 1; }
        else if (!strcmp(cmd, "export")) {
            uint8_t *png; size_t len;
            uc_read(u, (uint64_t)f * UC_FRAME_BYTES, rgb, UC_FRAME_BYTES);
            FILE *o = fopen(argv[4], "wb");
            if (uc_png_encode(rgb, UC_W, UC_H, &png, &len) || !o || fwrite(png, len, 1, o) != 1) ret = die(argv[4]);
            else free(png);
            if (o) fclose(o);
        } else {
            FILE *in = fopen(argv[4], "rb");
            size_t len;
            uint8_t *png = in ? slurp(in, &len) : NULL;
            if (in) fclose(in);
            if (!png || uc_png_decode(png, len, UC_W, UC_H, rgb) ||
                uc_write(u, (uint64_t)f * UC_FRAME_BYTES, rgb, UC_FRAME_BYTES) || uc_save(u, file, fmt))
                ret = die(argv[4]);
            free(png);
        }
        free(rgb);
    } else if (!strcmp(cmd, "ticklog")) {
        ticklog(u, argc > 3 ? (unsigned)strtoul(argv[3], NULL, 10) : 20);
    } else {
        usage();
        ret = 1;
    }
    uc_free(u);
    return ret;
}
