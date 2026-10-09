#include "muse_pixel.h"
#include <assert.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>

#define SIZE 320
#define DIRTY_RECTS_MAX 8
#define DIRTY_MERGE_PX 2048
#define LV_MIN(a, b) ((a) < (b) ? (a) : (b))
#define LV_MAX(a, b) ((a) > (b) ? (a) : (b))
typedef struct { int32_t x1, y1, x2, y2; } lv_area_t;
static uint16_t display[SIZE * SIZE], fresh[SIZE * SIZE];
static uint16_t cells[MUSE_PX_W * MUSE_PX_H], row[SIZE];
static uint16_t *s_cells = cells, *s_cell_row = row;
static bool s_cells_valid;
static void *s_canvas;
static struct { struct { int w; } header; } s_muse_src = {{SIZE}};
static int character;
int maestro_character(void) { return character; }
static int lv_area_get_width(const lv_area_t *a) { return a->x2 - a->x1 + 1; }
static int lv_area_get_height(const lv_area_t *a) { return a->y2 - a->y1 + 1; }
static void lv_obj_get_coords(void *object, lv_area_t *a)
{
    (void)object;
    *a = (lv_area_t){0, 0, SIZE - 1, SIZE - 1};
}
static void lv_obj_invalidate_area(void *object, const lv_area_t *a)
{
    (void)object;
    assert(a->x1 >= 0 && a->y1 >= 0 && a->x2 < SIZE && a->y2 < SIZE);
    // The real decoder draws strips. Preserve all pixels outside the dirty area.
    for (int y = a->y1; y <= a->y2; y += 16) {
        int bottom = LV_MIN(y + 15, a->y2);
        muse_pixel_scale(display + y * SIZE + a->x1, SIZE, a->x1, a->x2, y, bottom);
    }
}
static void lv_obj_invalidate(void *object)
{
    lv_area_t all = {0, 0, SIZE - 1, SIZE - 1};
    lv_obj_invalidate_area(object, &all);
}

// Extracted from the prepared SDK, including Maestro's integration patch.
#include "damage.c"

int main(void)
{
    muse_pixel_set_size(SIZE);
    memset(display, 0xff, sizeof(display));
    const int sequence[] = {0, 1, 0, 2, 0, 3, 0, 4, 0};
    int rendered = 0;
    for (unsigned c = 0; c < sizeof(sequence) / sizeof(sequence[0]); c++) {
        character = sequence[c];
        // Muse keeps its own renderer and damage tracker. Check the first frame
        // on return to it; exercise all frames and modes of the added characters.
        int modes = character ? MUSE_MODE_COUNT : MUSE_MODE_IDLE + 1;
        for (int mode = MUSE_MODE_IDLE; mode < modes; mode++) {
            for (int f = 0; f < (character ? 100 : 1); f++) {
                muse_pose_t pose = { .mode = mode, .t = f / 6.0f,
                    .mode_t = f / 6.0f, .level = (f % 11) / 10.0f, .happy = 0 };
                muse_pixel_render(&pose);
                invalidate_muse();
                muse_pixel_scale(fresh, SIZE, 0, SIZE - 1, 0, SIZE - 1);
                if (character) {
                    // On StopWatch the agent selector overlaps the canvas's
                    // first 80 rows. Gesture effects must stay below it.
                    for (int i = 0; i < 80 * SIZE; i++) assert(fresh[i] == 0);
                }
                if (memcmp(display, fresh, sizeof(display))) {
                    int stale = 0;
                    for (int i = 0; i < SIZE * SIZE; i++) stale += display[i] != fresh[i];
                    fprintf(stderr, "Character %d, mode %d, frame %d: %d stale pixels\n",
                            character, mode, f, stale);
                    return 1;
                }
                // An arbitrary clipped tile with padded stride must match the
                // full render and leave the decoder's padding untouched.
                uint16_t tile[17 * 131];
                memset(tile, 0xa5, sizeof(tile));
                muse_pixel_scale(tile, 131, 97, 223, 139, 155);
                for (int y = 0; y < 17; y++) {
                    assert(!memcmp(tile + y * 131, fresh + (y + 139) * SIZE + 97, 127 * 2));
                    for (int x = 127; x < 131; x++) assert(tile[y * 131 + x] == 0xa5a5);
                }
                rendered++;
            }
        }
    }
    printf("%d frames: damage, transitions, clipping and memory checks passed\n", rendered);
    return 0;
}
