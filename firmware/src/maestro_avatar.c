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
static int preview_character = -1;
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
    // A circular silhouette with expressive eyes, inspired by the Grok mascot.
    // Flat charcoal avoids RGB565 bands; only the edge is antialiased.
    const unsigned body = 0x181818, rim = 0x383838;
    float enter = 1 - expf(-p->mode_t * 5);
    float happy = p->mode == MUSE_MODE_IDLE ? coverage(p->happy) : 0;
    float level = coverage(p->level);
    float cx = 160, cy = 188 + sinf(p->t * 1.6f), radius = 88;
    float angle = -.42f, look_x = 0, look_y = 0, height = 12;
    float blink = fmodf(p->t, 5.2f);
    float open = blink < .24f ? fabsf(blink - .12f) / .12f : 1;
    if (p->mode == MUSE_MODE_LISTENING) {
        angle += enter * .3f;
        look_x = -12 * enter; look_y = -5 * enter;
        height += 5 * enter + level * 2;
    } else if (p->mode == MUSE_MODE_THINKING) {
        look_x = sinf(p->mode_t * 2.4f) * 14 * enter;
        look_y = -9 * enter;
        angle += sinf(p->mode_t * 2.4f) * .12f * enter;
        height -= 5 * enter;
    } else if (p->mode == MUSE_MODE_SPEAKING) {
        angle += sinf(p->mode_t * 3) * .12f * enter;
        height += level * 9;
        cy -= level * 4;
    } else if (p->mode == MUSE_MODE_ERROR) {
        cx += sinf(p->mode_t * 16) * 5 * expf(-p->mode_t * 2);
        angle += .65f * enter;
        look_y = 8 * enter; height -= 7 * enter;
    } else if (p->mode == MUSE_MODE_OFF) {
        open = 0; look_y = 8; angle = 0;
    }
    cy -= happy * 7;
    angle += happy * sinf(p->t * 9) * .16f;
    const uint16_t body_pixel = color(body);
    for (int y = 87; y < 283; y++) for (int x = 63; x < 258; x++) {
        float dx = x - cx, dy = y - cy, squared = dx*dx + dy*dy;
        if (squared < (radius-1.5f)*(radius-1.5f)) {
            pixels[y*SIDE+x] = body_pixel;
            continue;
        }
        float d = sqrtf(squared), alpha = coverage(radius - d + .5f);
        if (alpha > 0) pixels[y*SIDE+x] = color(mix(0, mix(body, rim, coverage(d-radius+1.5f)), alpha));
    }
    float cs = cosf(angle), sn = sinf(angle);
    for (int eye = 0; eye < 2; eye++) {
        float local_x = eye ? 38 : -1, local_y = -34;
        float ex = cx + local_x*cs - local_y*sn + look_x;
        float ey = cy + local_x*sn + local_y*cs + look_y;
        for (int y = (int)ey-34; y <= (int)ey+34; y++) for (int x = (int)ex-34; x <= (int)ex+34; x++) {
            float dx = x-ex, dy = y-ey, u = dx*cs+dy*sn, v = -dx*sn+dy*cs;
            // Pet/completion reaction: two smiling arches; work states always win.
            float curve = -7 + u*u*.055f;
            float eye_alpha;
            if (happy > .2f) {
                eye_alpha = coverage(3.5f - fabsf(v-curve)) * coverage(15 - fabsf(u));
            } else {
                v /= .12f + .88f*open;
                float end = fmaxf(fabsf(v)-height, 0);
                eye_alpha = coverage(7.5f - sqrtf(u*u + end*end));
            }
            if (eye_alpha > 0 && x >= 0 && x < SIDE && y >= 0 && y < SIDE)
                pixels[y*SIDE+x] = color(mix(body, 0xf2f2ef, eye_alpha));
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
static void dot(const muse_pose_t *p)
{
    // The owner's Dot is the pale ring. Draw at panel resolution, with a soft
    // edge and a moving center; keep its silhouette distinct from Grok's face.
    float level = coverage(p->level), cx = 160, cy = 185 + sinf(p->t * 1.5f) * 2;
    float radius = 82 + sinf(p->t * 1.5f), hole = 30, dx = 0, dy = 0;
    if (p->mode == MUSE_MODE_LISTENING) { hole += 4 + level * 5; dy = -6; }
    if (p->mode == MUSE_MODE_THINKING) { dx = sinf(p->mode_t * 2) * 9; dy = cosf(p->mode_t * 2) * 9; }
    if (p->mode == MUSE_MODE_SPEAKING) { radius += level * 5; hole += level * 9; }
    if (p->mode == MUSE_MODE_ERROR) { dx = sinf(p->mode_t * 12) * 5 * expf(-p->mode_t); hole = 21; }
    if (p->mode == MUSE_MODE_OFF) hole = 12;
    const unsigned body = p->mode == MUSE_MODE_OFF ? 0x777d91 : 0xbdc4db;
    for (int y = 90; y < 280; y++) for (int x = 65; x < 255; x++) {
        float ox = x - cx, oy = y - cy, ix = ox - dx, iy = oy - dy;
        float alpha = coverage(radius - sqrtf(ox*ox + oy*oy) + .5f) * coverage(sqrtf(ix*ix + iy*iy) - hole + .5f);
        if (alpha > 0) pixels[y * SIDE + x] = color(mix(0, body, alpha));
    }
}
bool maestro_avatar_render(const muse_pose_t *p)
{
    int who = preview_character < 0 ? maestro_character() : preview_character;
    active = who != 0;
    if (!active) return false;
    if (!pixels) pixels = heap_caps_calloc(SIDE*SIDE, sizeof(*pixels), MUSE_BIG_CAPS);
    if (!frame) frame = heap_caps_calloc(FRAME_PIXELS, sizeof(*frame), MUSE_BIG_CAPS);
    if (!pixels || !frame) { active = false; return false; }
    memset(pixels, 0, SIDE*SIDE*sizeof(*pixels));
    if (who == 1) grok(p);
    else if (who == 2) codex(p);
    else if (who == 3) clawd(p);
    else if (who == 5) dot(p);
    else pi(p);
    return true;
}
void maestro_avatar_snapshot(int character, uint16_t *dst)
{
    const muse_pose_t pose = {.mode = MUSE_MODE_IDLE, .t = 1, .mode_t = 1};
    preview_character = character;
    muse_pixel_render(&pose);
    muse_pixel_set_size(SIDE);
    muse_pixel_scale(dst, SIDE, 0, SIDE - 1, 0, SIDE - 1);
    preview_character = -1;
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
