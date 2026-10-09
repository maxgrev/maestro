#include "maestro_avatar.h"
#include "maestro.h"
#include "muse_mem.h"
#include <math.h>
#include <string.h>

static uint16_t *pixels;
static bool active;
static int dy;
static uint16_t color(unsigned c) { return ((c >> 8) & 0xf800) | ((c >> 5) & 0x07e0) | ((c >> 3) & 0x1f); }
static void box(int x, int y, int w, int h, unsigned c)
{
    for (int j = y + dy; j < y + dy + h; j++)
        for (int i = x; i < x + w; i++)
            // Leave the top of the shared canvas clear for the agent selector.
            if (i >= 0 && i < 64 && j >= 0 && j < 64) pixels[(j * 4 / 5 + 12) * 64 + i * 4 / 5 + 6] = color(c);
}
static void oval(int x, int y, int rx, int ry, unsigned c)
{
    for (int j = -ry; j <= ry; j++) for (int i = -rx; i <= rx; i++)
        if (i*i*ry*ry + j*j*rx*rx <= rx*rx*ry*ry) box(x+i, y+j, 1, 1, c);
}
bool maestro_avatar_render(const muse_pose_t *p)
{
    int who = maestro_character();
    active = who != 0;
    if (!active) return false;
    if (!pixels) pixels = heap_caps_calloc(64 * 64, sizeof(*pixels), MUSE_BIG_CAPS);
    if (!pixels) { active = false; return false; }
    memset(pixels, 0, 64 * 64 * sizeof(*pixels));
    dy = 0;
    oval(32, 53, 17, 2, 0x141917);
    dy = (int)roundf(sinf(p->t * 2) * 0.8f - p->happy * 3);
    const unsigned ink = 0x182320;
    unsigned body = who == 1 ? 0xb8c1c6 : who == 2 ? 0x9cceb2 : who == 3 ? 0xd99271 : 0xe2c16f;
    unsigned light = who == 1 ? 0xe7edf0 : who == 2 ? 0xceedd8 : who == 3 ? 0xf3c09a : 0xf6dc96;
    // The silhouette identifies the agent even on a monochrome display.
    if (who == 1) { // Grok: an alert, asymmetric space cat.
        box(14, 13, 7, 18, ink); box(16, 16, 3, 11, body);
        box(43, 9, 7, 22, ink); box(45, 12, 3, 15, body);
        oval(32, 34, 22, 17, ink); oval(32, 33, 19, 14, body);
        box(17, 25, 8, 3, light); box(48, 38, 5, 4, ink); box(51, 32, 3, 9, body);
    } else if (who == 2) { // Codex: a square, mint terminal with an antenna.
        box(31, 11, 2, 10, ink); box(29, 8, 6, 5, body);
        box(13, 22, 38, 27, ink); box(16, 20, 32, 31, ink);
        box(16, 23, 32, 24, body); box(18, 23, 28, 3, light);
        box(8, 30, 5, 11, body); box(51, 30, 5, 11, body);
    } else if (who == 3) { // Claude: a warm, star-shaped companion.
        for (int n = 0; n < 10; n++) {
            float a = n * 6.2831853f / 10;
            int x = 32 + (int)(cosf(a)*19), y = 32 + (int)(sinf(a)*19);
            oval(x, y, 4, 4, ink); oval(x, y, 2, 2, body);
        }
        oval(32, 32, 19, 19, ink); oval(32, 32, 17, 17, body);
        oval(27, 23, 7, 3, light);
    } else { // Pi / future agents: a small golden bird with a sprout.
        box(31, 9, 2, 11, ink); oval(27, 11, 5, 3, 0x9cceb2);
        oval(36, 8, 5, 3, 0xceedd8);
        oval(32, 34, 19, 18, ink); oval(32, 33, 17, 16, body);
        oval(26, 23, 7, 3, light);
    }
    box(21, 49, 7, 4, ink); box(36, 49, 7, 4, ink);
    if (who == 2) { box(19, 29, 26, 14, ink); }
    unsigned eyes = who == 2 ? light : ink;
    int eyeY = p->mode == MUSE_MODE_THINKING ? 29 : 31;
    bool blink = fmodf(p->t + who * .6f, 5) < .14f || p->mode == MUSE_MODE_OFF;
    int eyeH = blink ? 1 : p->mode == MUSE_MODE_LISTENING ? 6 : 4;
    box(23, eyeY, 3, eyeH, eyes); box(38, eyeY, 3, eyeH, eyes);
    if (p->mode == MUSE_MODE_ERROR) { box(21, 27, 6, 1, eyes); box(37, 26, 6, 1, eyes); }
    if (p->mode == MUSE_MODE_SPEAKING) oval(32, 40, 3, 1 + (int)(p->level * 5), eyes);
    else { box(29, 40, 6, 1, eyes); if (p->mode != MUSE_MODE_ERROR) { box(28,39,1,1,eyes); box(35,39,1,1,eyes); } }
    return true;
}
bool maestro_avatar_scale(uint16_t *dst, int stride, int x0, int x1, int y0, int y1, int size)
{
    if (!active || !pixels) return false;
    for (int y = y0; y <= y1; y++, dst += stride)
        for (int x = x0; x <= x1; x++) dst[x-x0] = pixels[(y*64/size)*64 + x*64/size];
    return true;
}
