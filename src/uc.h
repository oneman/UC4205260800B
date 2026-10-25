/* uc.h - Lush Stemsys Unit Computer UC4205260800B instance library.
 * See SPEC.md for the memory layout and save formats. */
#ifndef UC_LIB_H
#define UC_LIB_H

#include <stddef.h>
#include <stdint.h>

#define UC_BYTES        4205260800ULL
#define UC_PAGE         4096u
#define UC_PAGES        1026675u
#define UC_W            1920u
#define UC_H            1080u
#define UC_FRAME_BYTES  6220800u            /* 1920 * 1080 * 3 */
#define UC_FRAMES       676u                /* 26 * 26 */
#define UC_GRID         26u
#define UC_W4K          3840u
#define UC_H4K          2160u
#define UC_FRAME4K_BYTES 24883200u          /* 3840 * 2160 * 3 */
#define UC_FRAMES4K     169u                /* 13 * 13 */
#define UC_MOSAIC_W     49920u
#define UC_MOSAIC_H     28080u
#define UC_STRIDE       149760u             /* bytes per mosaic row: 49920 * 3 */

#define UC_OBJ_MAGIC     "UCOBJ1\n"
#define UC_OBJ_AREA_PAGE 987188u            /* first page fully inside frame za */
#define UC_TICK_PAGE     1025651u           /* last 1024 pages */
#define UC_TICK_CAP      261888u

enum uc_format { UC_FMT_HD = 0, UC_FMT_4K = 1 };

/* A sparse instance: pages are allocated on first nonzero write. */
typedef struct uc {
    uint8_t **pages;                        /* UC_PAGES entries, NULL = all zero */
} uc_t;

uc_t *uc_new(void);
void  uc_free(uc_t *u);

/* Byte access. Out-of-range reads give zero; out-of-range writes fail. */
void uc_read(const uc_t *u, uint64_t addr, void *buf, size_t len);
int  uc_write(uc_t *u, uint64_t addr, const void *buf, size_t len);
int  uc_page_is_zero(const uc_t *u, uint32_t page);
int  uc_range_is_zero(const uc_t *u, uint64_t addr, uint64_t len);
uint64_t uc_nonzero_pages(const uc_t *u);
/* Drop pages that are allocated but contain only zeros. */
void uc_compact(uc_t *u);

/* Memory is one row-major 49920x28080 RGB framebuffer (the mosaic).
 * HD frame f is the 1920x1080 tile at column f % 26, row f / 26;
 * 4K frame k is the 3840x2160 tile at column k % 13, row k / 13. */
static inline uint64_t uc_addr(unsigned X, unsigned Y) { return (uint64_t)Y * UC_STRIDE + (uint64_t)X * 3; }
/* Copy a rectangle of the mosaic to or from packed RGB rows. */
void uc_rect_read(const uc_t *u, unsigned X, unsigned Y, unsigned w, unsigned h, uint8_t *rgb);
int  uc_rect_write(uc_t *u, unsigned X, unsigned Y, unsigned w, unsigned h, const uint8_t *rgb);
int  uc_rect_is_zero(const uc_t *u, unsigned X, unsigned Y, unsigned w, unsigned h);

/* Frame names: 0 -> "aa", 675 -> "zz". Returns -1 for a bad name. */
void uc_frame_name(unsigned frame, char out[3]);
int  uc_frame_index(const char *name);

/* PNG codec for 8-bit RGB images (decoder also accepts RGBA). */
int uc_png_encode(const uint8_t *rgb, unsigned w, unsigned h, uint8_t **out, size_t *outlen);
int uc_png_decode(const uint8_t *png, size_t len, unsigned want_w, unsigned want_h, uint8_t *rgb);

/* Save and load whole instances as zip files of PNGs. */
int uc_save(const uc_t *u, const char *path, enum uc_format fmt);
int uc_load(uc_t *u, const char *path, enum uc_format *fmt_out);

/* Embedded objects (SPEC.md section 4). */
typedef struct uc_obj {
    uint32_t page;
    char name[256];
    char type[256];
    char frames[256];
    uint64_t length;
    uint32_t crc32;
    uint64_t payload_addr;
    int crc_ok;
} uc_obj_t;

/* Fills up to max objects, returns how many were found. */
size_t uc_scan_objects(const uc_t *u, uc_obj_t *objs, size_t max);
/* page < 0 picks the first free run in the object area. Returns the page or -1. */
long uc_embed(uc_t *u, long page, const char *name, const char *type,
              const char *frames, const uint8_t *data, size_t len, int force);

const char *uc_error(void);

#endif
