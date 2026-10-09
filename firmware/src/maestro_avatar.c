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

#define SIDE 128
#define FRAME_PIXELS (192 * 128)
static uint16_t *pixels, *frame;
static bool active;
static uint16_t color(unsigned c) { return ((c >> 8) & 0xf800) | ((c >> 5) & 0x07e0) | ((c >> 3) & 0x1f); }
static void box(int x, int y, int w, int h, unsigned c)
{
    for (int j = y; j < y + h; j++) for (int i = x; i < x + w; i++)
        if (i >= 0 && i < SIDE && j >= 0 && j < SIDE) pixels[j * SIDE + i] = color(c);
}
static void blit(const uint16_t *data, int width, int height, uint16_t key)
{
    if (width * height > FRAME_PIXELS) return;
    rle_decode_rgb565(data, frame, width * height);
    float scale = fminf(1, fminf(112.0f/width, 96.0f/height));
    int w = (int)(width*scale), h = (int)(height*scale), x = (SIDE-w)/2, y = 113-h;
    for (int j = 0; j < h; j++) for (int i = 0; i < w; i++) {
        uint16_t c = frame[(j*height/h)*width + i*width/w];
        if (c != key) pixels[(y+j)*SIDE+x+i] = c;
    }
}
#define CLAWD(name, PREFIX, fps) do { \
    int n = (int)(p->mode_t * fps) % PREFIX##_FRAME_COUNT; \
    blit(name##_rle_data + name##_frame_offsets[n], PREFIX##_WIDTH, PREFIX##_HEIGHT, PREFIX##_TRANSPARENT_KEY); \
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
    int start = 0, count = 6; float fps = 1.2f;
    switch (p->mode) {
    case MUSE_MODE_LISTENING: start = 30; count = 6; fps = 6; break;
    case MUSE_MODE_THINKING: start = 10; count = 6; fps = 7; break;
    case MUSE_MODE_SPEAKING: start = 6; count = 4; fps = 6; break;
    case MUSE_MODE_ERROR: start = 22; count = 8; fps = 6; break;
    default: break;
    }
    int n = start + (int)(p->mode_t * fps) % count;
    blit(codex_data + codex_offsets[n], 80, 87, 0);
}
static void grok(const muse_pose_t *p)
{
    // Maestro animation of the supplied Grok Bot character. A subtle edge keeps
    // its black silhouette visible against the AMOLED's black background.
    float breath = sinf(p->t * 2.0f), level = p->mode == MUSE_MODE_SPEAKING ? p->level : 0;
    float cy = 78 + breath, radius = 35 + level * 2;
    bool blink = fmodf(p->t, 5.2f) < .16f || p->mode == MUSE_MODE_OFF;
    float look = p->mode == MUSE_MODE_THINKING ? sinf(p->t * 1.5f) * 3 : 0;
    for (int y = 35; y < 120; y++) for (int x = 20; x < 110; x++) {
        float dx = x-64, dy = y-cy, a = atan2f(dy,dx);
        float edge = radius + 1.8f*sinf(3*a+p->t*.5f) + 1.1f*cosf(2*a-p->t*.3f);
        float d = sqrtf(dx*dx + dy*dy);
        if (d < edge) {
            unsigned v = (unsigned)(12 + (1-(dy+radius)/(2*radius))*14);
            pixels[y*SIDE+x] = color(d > edge-1.3f ? 0x454a50 : v*0x010101);
        }
    }
    for (int eye = 0; eye < 2; eye++) {
        float ex = 64 + eye*16 + look, ey = cy - 14 - eye*5;
        float h = blink ? 1 : p->mode == MUSE_MODE_LISTENING ? 8 : 6;
        for (int y = (int)ey-12; y < (int)ey+12; y++) for (int x = (int)ex-10; x < (int)ex+10; x++) {
            float dx=x-ex, dy=y-ey, u=dx*.91f-dy*.41f, v=dx*.41f+dy*.91f;
            float end=fmaxf(fabsf(v)-h,0);
            if (u*u+end*end < 10) box(x,y,1,1,0xf2f2ef);
        }
    }
}
static void pi(const muse_pose_t *p)
{
    // Pi's official three-color mark (pi.dev/logo-auto.svg).
    int dy=(int)roundf(sinf(p->t*2)*1.2f), x=34, y=45+dy, s=15;
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
    for (int y = y0; y <= y1; y++, dst += stride)
        for (int x = x0; x <= x1; x++) dst[x-x0] = pixels[(y*SIDE/size)*SIDE + x*SIDE/size];
    return true;
}
