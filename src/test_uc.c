/* test_uc.c - unit tests for the C library. */
#define _FILE_OFFSET_BITS 64
#include "uc.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int failures;
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "%s:%d: CHECK(%s) failed: %s\n", __FILE__, __LINE__, #c, uc_error()); failures++; } } while (0)

static void test_memory(void)
{
    uc_t *u = uc_new();
    uint8_t buf[10000];
    uc_read(u, 123456789, buf, sizeof buf);
    for (size_t i = 0; i < sizeof buf; i++) CHECK(buf[i] == 0);
    CHECK(uc_nonzero_pages(u) == 0);
    memset(buf, 0, sizeof buf);
    CHECK(uc_write(u, 5, buf, sizeof buf) == 0);
    CHECK(uc_nonzero_pages(u) == 0);                 /* zeros allocate nothing */
    for (size_t i = 0; i < sizeof buf; i++) buf[i] = (uint8_t)(i * 7 + 1);
    CHECK(uc_write(u, UC_PAGE - 3, buf, sizeof buf) == 0);
    uint8_t back[10000];
    uc_read(u, UC_PAGE - 3, back, sizeof back);
    CHECK(!memcmp(buf, back, sizeof buf));
    CHECK(uc_nonzero_pages(u) == 4);
    CHECK(uc_write(u, UC_BYTES - 1, buf, 1) == 0);
    CHECK(uc_write(u, UC_BYTES - 1, buf, 2) != 0);
    char n[3];
    uc_frame_name(0, n); CHECK(!strcmp(n, "aa"));
    uc_frame_name(27, n); CHECK(!strcmp(n, "bb"));
    uc_frame_name(675, n); CHECK(!strcmp(n, "zz"));
    CHECK(uc_frame_index("zz") == 675);
    CHECK(uc_frame_index("a") == -1);
    uc_free(u);
}

static void test_png(void)
{
    unsigned w = 37, h = 11;
    uint8_t rgb[37 * 11 * 3], back[37 * 11 * 3];
    for (size_t i = 0; i < sizeof rgb; i++) rgb[i] = (uint8_t)(i * 31);
    uint8_t *png; size_t len;
    CHECK(uc_png_encode(rgb, w, h, &png, &len) == 0);
    CHECK(uc_png_decode(png, len, w, h, back) == 0);
    CHECK(!memcmp(rgb, back, sizeof rgb));
    CHECK(uc_png_decode(png, len, w + 1, h, back) != 0);
    free(png);
}

static void test_save_load(enum uc_format fmt)
{
    char path[] = "/tmp/uctestXXXXXX";
    int fd = mkstemp(path);
    close(fd);
    uc_t *u = uc_new();
    const char msg[] = "Hello Super Intelligence World!";
    CHECK(uc_write(u, 0, msg, sizeof msg) == 0);
    CHECK(uc_write(u, UC_BYTES - sizeof msg, msg, sizeof msg) == 0);
    CHECK(uc_write(u, 7ULL * UC_FRAME_BYTES - 2, msg, sizeof msg) == 0);   /* straddles two frames */
    CHECK(uc_save(u, path, fmt) == 0);
    uc_t *v = uc_new();
    enum uc_format got;
    CHECK(uc_load(v, path, &got) == 0);
    CHECK(got == fmt);
    char b[sizeof msg];
    uc_read(v, 0, b, sizeof b); CHECK(!memcmp(b, msg, sizeof msg));
    uc_read(v, UC_BYTES - sizeof msg, b, sizeof b); CHECK(!memcmp(b, msg, sizeof msg));
    uc_read(v, 7ULL * UC_FRAME_BYTES - 2, b, sizeof b); CHECK(!memcmp(b, msg, sizeof msg));
    CHECK(uc_nonzero_pages(v) == uc_nonzero_pages(u));
    uc_free(u);
    uc_free(v);
    unlink(path);
}

static void test_objects(void)
{
    uc_t *u = uc_new();
    const char *text = "plain text payload\n";
    long p = uc_embed(u, -1, "note", "text/plain", NULL, (const uint8_t *)text, strlen(text), 0);
    CHECK(p == UC_OBJ_AREA_PAGE);
    long q = uc_embed(u, -1, "cart", "application/x-uc-cart+javascript", "ab", (const uint8_t *)text, strlen(text), 0);
    CHECK(q == UC_OBJ_AREA_PAGE + 1);
    CHECK(uc_embed(u, p, "x", "text/plain", NULL, (const uint8_t *)"x", 1, 0) < 0);
    uc_obj_t objs[8];
    CHECK(uc_scan_objects(u, objs, 8) == 2);
    CHECK(!strcmp(objs[0].name, "note") && objs[0].crc_ok && objs[0].length == strlen(text));
    CHECK(!strcmp(objs[1].frames, "ab"));
    char back[64] = { 0 };
    uc_read(u, objs[0].payload_addr, back, objs[0].length);
    CHECK(!strcmp(back, text));
    uc_write(u, objs[0].payload_addr, "P", 1);
    uc_scan_objects(u, objs, 8);
    CHECK(!objs[0].crc_ok);
    uc_free(u);
}

int main(void)
{
    test_memory();
    test_png();
    test_save_load(UC_FMT_HD);
    test_save_load(UC_FMT_4K);
    test_objects();
    if (failures) { fprintf(stderr, "%d failures\n", failures); return 1; }
    puts("C tests passed");
    return 0;
}
