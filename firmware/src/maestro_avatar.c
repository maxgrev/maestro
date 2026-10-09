#include "maestro_avatar.h"
#include "maestro.h"
#include "muse_mem.h"
#include "avatars/rle_sprite.h"
#include "avatars/codex.h"
#include "avatars/sprite_idle.h"
#include "avatars/sprite_alert.h"
#include "avatars/sprite_happy.h"
#include "avatars/sprite_sleeping.h"
#include "avatars/sprite_thinking.h"
#include "avatars/sprite_confused.h"
#include <math.h>
#include <string.h>

// Match the StopWatch's character canvas: no intermediate low-resolution image.
#define SIDE 320
#define FRAME_PIXELS (CODEX_WIDTH * CODEX_HEIGHT)
static uint16_t *pixels, *frame;
static bool active;
static uint16_t color(unsigned c) { return ((c >> 8) & 0xf800) | ((c >> 5) & 0x07e0) | ((c >> 3) & 0x1f); }
static void box(int x, int y, int w, int h, unsigned c)
{
    for (int j = y; j < y + h; j++) for (int i = x; i < x + w; i++)
        if (i >= 0 && i < SIDE && j >= 0 && j < SIDE) pixels[j * SIDE + i] = color(c);
}
static void blit(const uint16_t *data, int width, int height, uint16_t key, int scale)
{
    int w = width * scale, h = height * scale, x = (SIDE - w) / 2, y = 280 - h;
    // Leave room for the agent selector above the tallest gesture frames.
    if (y < 80) y = 80;
    if (width * height > FRAME_PIXELS || w > SIDE || y + h > SIDE) return;
    rle_decode_rgb565(data, frame, width * height);
    for (int j = 0; j < h; j++) for (int i = 0; i < w; i++) {
        uint16_t c = frame[(j / scale) * width + i / scale];
        if (c != key) pixels[(y+j)*SIDE+x+i] = c;
    }
}
#define CLAWD(name, PREFIX, fps) do { \
    int n = (int)(p->mode_t * fps) % PREFIX##_FRAME_COUNT; \
    blit(name##_rle_data + name##_frame_offsets[n], PREFIX##_WIDTH, PREFIX##_HEIGHT, PREFIX##_TRANSPARENT_KEY, 2); \
} while (0)
static void clawd(const muse_pose_t *p)
{
    switch (p->mode) {
    case MUSE_MODE_LISTENING: CLAWD(alert, ALERT, 10); break;
    case MUSE_MODE_THINKING: CLAWD(thinking, THINKING, 8); break;
    case MUSE_MODE_SPEAKING: CLAWD(happy, HAPPY, 10); break;
    case MUSE_MODE_ERROR: CLAWD(confused, CONFUSED, 8); break;
    case MUSE_MODE_OFF: CLAWD(sleeping, SLEEPING, 6); break;
    default: CLAWD(idle, IDLE, 6); break;
    }
}
static void codex(const muse_pose_t *p)
{
    int start = CODEX_IDLE_START, count = CODEX_IDLE_COUNT; float fps = 1.2f;
    switch (p->mode) {
    case MUSE_MODE_LISTENING: start = CODEX_LISTENING_START; count = CODEX_LISTENING_COUNT; fps = 6; break;
    case MUSE_MODE_THINKING: start = CODEX_THINKING_START; count = CODEX_THINKING_COUNT; fps = 7; break;
    case MUSE_MODE_SPEAKING: start = CODEX_SPEAKING_START; count = CODEX_SPEAKING_COUNT; fps = 6; break;
    case MUSE_MODE_ERROR: start = CODEX_ERROR_START; count = CODEX_ERROR_COUNT; fps = 6; break;
    default: break;
    }
    int n = start + (int)(p->mode_t * fps) % count;
    blit(codex_data + codex_offsets[n], CODEX_WIDTH, CODEX_HEIGHT, 0, 1);
}
static float coverage(float v) { return fminf(1, fmaxf(0, v)); }
static unsigned mix(unsigned a, unsigned b, float weight)
{
    unsigned r = (unsigned)(((a >> 16) & 255) * (1-weight) + ((b >> 16) & 255) * weight);
    unsigned g = (unsigned)(((a >> 8) & 255) * (1-weight) + ((b >> 8) & 255) * weight);
    unsigned blue = (unsigned)((a & 255) * (1-weight) + (b & 255) * weight);
    return (r << 16) | (g << 8) | blue;
}
static void grok(const muse_pose_t *p)
{
    // Keep the reference's circular silhouette. Flat charcoal avoids RGB565
    // gradient bands; a thin, antialiased edge separates it from the black screen.
    const unsigned body = 0x181818, rim = 0x383838;
    float cy = 188 + sinf(p->t * 1.6f), radius = 88;
    const uint16_t body_pixel = color(body);
    float level = p->mode == MUSE_MODE_SPEAKING ? coverage(p->level) : 0;
    float blink_t = fmodf(p->t, 5.2f);
    float open = blink_t < .24f ? fabsf(blink_t - .12f) / .12f : 1;
    if (p->mode == MUSE_MODE_OFF) open = 0;
    float look = p->mode == MUSE_MODE_THINKING ? sinf(p->t * 1.5f) * 5 : 0;
    for (int y = 97; y < 280; y++) for (int x = 70; x < 251; x++) {
        float dx = x - 160, dy = y - cy, squared = dx*dx + dy*dy;
        if (squared < (radius-1.5f)*(radius-1.5f)) {
            pixels[y*SIDE+x] = body_pixel;
            continue;
        }
        float d = sqrtf(squared);
        float alpha = coverage(radius - d + .5f);
        if (alpha > 0) {
            unsigned shade = mix(body, rim, coverage(d - radius + 1.5f));
            pixels[y*SIDE+x] = color(mix(0, shade, alpha));
        }
    }
    for (int eye = 0; eye < 2; eye++) {
        float ex = 168 + eye*37 + look, ey = cy - 32 - eye*12;
        float h = 12 + level*2 + (p->mode == MUSE_MODE_LISTENING ? 2 : 0);
        for (int y = (int)ey-25; y <= (int)ey+25; y++) for (int x = (int)ex-20; x <= (int)ex+20; x++) {
            float dx = x-ex, dy = y-ey, u = dx*.9135f-dy*.4067f, v = dx*.4067f+dy*.9135f;
            // Squeeze along the eye's long axis for a soft blink.
            v /= .12f + .88f*open;
            float end = fmaxf(fabsf(v)-h, 0);
            float alpha = coverage(7.5f - sqrtf(u*u + end*end));
            if (alpha > 0) pixels[y*SIDE+x] = color(mix(body, 0xf2f2ef, alpha));
        }
    }
}
static void pi(const muse_pose_t *p)
{
    // Pi's official three-color mark (pi.dev/logo-auto.svg).
    int dy=(int)roundf(sinf(p->t*2)), x=84, y=126+dy, s=38;
    box(x,y,s*3,s,0xf09082); box(x+s*2,y+s,s,s,0xf09082);
    box(x,y+s,s,s*3,0x4d9abf); box(x+s,y+s*2,s,s,0x4d9abf);
    int lift=p->mode==MUSE_MODE_SPEAKING?(int)(p->level*5):p->mode==MUSE_MODE_THINKING?(int)(sinf(p->t*5)*3):0;
    box(x+s*3,y+s*2-lift,s,s*2,0xf1be58);
}
bool maestro_avatar_render(const muse_pose_t *p)
{
    int who = maestro_character(); active = who != 0;
    if (!active) return false;
    if (!pixels) pixels = heap_caps_calloc(SIDE*SIDE, sizeof(*pixels), MUSE_BIG_CAPS);
    if (!frame) frame = heap_caps_calloc(FRAME_PIXELS, sizeof(*frame), MUSE_BIG_CAPS);
    if (!pixels || !frame) { active = false; return false; }
    memset(pixels, 0, SIDE*SIDE*sizeof(*pixels));
    if (who == 1) grok(p);
    else if (who == 2) codex(p);
    else if (who == 3) clawd(p);
    else pi(p);
    return true;
}
bool maestro_avatar_scale(uint16_t *dst, int stride, int x0, int x1, int y0, int y1, int size)
{
    if (!active || !pixels) return false;
    if (size == SIDE) {
        for (int y = y0; y <= y1; y++, dst += stride)
            memcpy(dst, pixels + y*SIDE + x0, (x1-x0+1)*sizeof(*dst));
        return true;
    }
    for (int y = y0; y <= y1; y++, dst += stride)
        for (int x = x0; x <= x1; x++) dst[x-x0] = pixels[(y*SIDE/size)*SIDE + x*SIDE/size];
    return true;
}
