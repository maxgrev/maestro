// Render once from the same artwork as the animated face. Transparent corners
// let the selected row show through; no separate art files to keep in sync.
#define THUMB 56
static lv_image_dsc_t s_portraits[6];
static void portraits_build(void)
{
    uint16_t *source = heap_caps_calloc(320 * 320, sizeof(*source), MUSE_BIG_CAPS);
    configASSERT(source);
    for (int who = 0; who < 6; who++) {
        maestro_avatar_snapshot(who, source);
        int left = 320, right = 0, top = 320, bottom = 0;
        for (int y = 0; y < 320; y++) for (int x = 0; x < 320; x++) if (source[y * 320 + x]) {
            if (x < left) left = x;
            if (x > right) right = x;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
        }
        uint8_t *data = heap_caps_calloc(THUMB * THUMB, 3, MUSE_BIG_CAPS);
        configASSERT(data);
        s_portraits[who] = (lv_image_dsc_t){
            .header = {.magic = LV_IMAGE_HEADER_MAGIC, .cf = LV_COLOR_FORMAT_RGB565A8,
                       .w = THUMB, .h = THUMB, .stride = THUMB * 2},
            .data_size = THUMB * THUMB * 3, .data = data,
        };
        int span = LV_MAX(right - left + 1, bottom - top + 1);
        left -= (span - (right - left + 1)) / 2;
        top -= (span - (bottom - top + 1)) / 2;
        for (int y = 4; y < THUMB - 4; y++) for (int x = 4; x < THUMB - 4; x++) {
            // A 48-cell portrait, sampled once without blended outlines.
            int sx = left + ((x - 4) * 2 + 1) * span / 96;
            int sy = top + ((y - 4) * 2 + 1) * span / 96;
            uint16_t c = sx >= 0 && sx < 320 && sy >= 0 && sy < 320 ? source[sy * 320 + sx] : 0;
            ((uint16_t *)data)[y * THUMB + x] = c;
            data[THUMB * THUMB * 2 + y * THUMB + x] = c ? 255 : 0;
        }
    }
    free(source);
}
