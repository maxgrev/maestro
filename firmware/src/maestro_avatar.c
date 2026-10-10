#include "maestro_avatar.h"
#include "maestro.h"
#include "muse_mem.h"
#include "avatars/rle_sprite.h"
#include "avatars/codex.h"
#include "avatars/dot.h"
#include "avatars/sprite_idle.h"
#include "avatars/sprite_alert.h"
#include "avatars/sprite_happy.h"
#include "avatars/sprite_sleeping.h"
#include "avatars/sprite_thinking.h"
#include "avatars/sprite_confused.h"
#include <math.h>
#include <string.h>

// Native display canvas; shared 4px cells keep added art crisp at integer scale.
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
static void sleep_glint(float t)
{
    // A small rising pixel Z; no text label or extra UI control.
    int y = 100 - ((int)(t * 2) % 3) * 4;
    box(232, y, 16, 4, 0x8c80b3);
    box(240, y+4, 4, 4, 0x8c80b3);
    box(236, y+8, 4, 4, 0x8c80b3);
    box(232, y+12, 16, 4, 0x8c80b3);
}
static void dim(void)
{
    for (int i = 0; i < SIDE * SIDE; i++) pixels[i] = (pixels[i] & 0xf7de) >> 1;
}
static void blit(const uint16_t *data, int width, int height, uint16_t key, int scale)
{
    int w = width * scale, h = height * scale, x = (SIDE - w) / 2, y = 280 - h;
    // Leave room for the agent selector above the tallest gesture frames.
    if (y < 80) y = 80;
    if (width * height > FRAME_PIXELS || w > SIDE || y + h > SIDE) return;
    rle_decode_rgb565(data, frame, width * height);
    for (int j = 0; j < h; j++) for (int i = 0; i < w; i++) {
        int sx = i / scale, sy = j / scale;
        // Reuse every original Codex pose, sampled on a fixed 48x52 cell grid.
        // Never rescale frames independently or introduce blended edge pixels.
        if (width == CODEX_WIDTH) { sx = sx / 4 * 4 + 2; sy = sy / 4 * 4 + 2; }
        uint16_t c = frame[sy * width + sx];
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
    default: if (p->happy > .2f) { CLAWD(happy, HAPPY, 10); } else { CLAWD(idle, IDLE, 6); } break;
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
    int n = p->mode == MUSE_MODE_OFF ? CODEX_IDLE_START + 1 : start + (int)(p->mode_t * fps) % count;
    blit(codex_data + codex_offsets[n], CODEX_WIDTH, CODEX_HEIGHT, 0, 1);
    if (p->mode == MUSE_MODE_OFF) { dim(); sleep_glint(p->mode_t); }
}
static float coverage(float v) { return fminf(1, fmaxf(0, v)); }
static void grok(const muse_pose_t *p)
{
    // A circle on a fixed cell grid, with the same expressive state-driven eyes.
    const unsigned body = 0x20202b, rim = 0x545268;
    float enter = 1 - expf(-p->mode_t * 5);
    float happy = p->mode == MUSE_MODE_IDLE ? coverage(p->happy) : 0;
    float level = coverage(p->level);
    float cx = 160, cy = 188, radius = 88;
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
    // Move the whole silhouette by cells; subpixel motion made its rim shimmer.
    cx = roundf(cx / 4) * 4; cy = roundf(cy / 4) * 4;
    for (int y = 88; y < 284; y += 4) for (int x = 64; x < 260; x += 4) {
        float dx = x - cx, dy = y - cy, squared = dx*dx + dy*dy;
        if (squared < radius*radius) box(x, y, 4, 4, squared < (radius-4)*(radius-4) ? body : rim);
    }
    float cs = cosf(angle), sn = sinf(angle);
    for (int eye = 0; eye < 2; eye++) {
        float local_x = eye ? 38 : -1, local_y = -34;
        float ex = cx + local_x*cs - local_y*sn + look_x;
        float ey = cy + local_x*sn + local_y*cs + look_y;
        for (int y = ((int)ey-36)/4*4; y <= (int)ey+36; y += 4) for (int x = ((int)ex-36)/4*4; x <= (int)ex+36; x += 4) {
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
            if (eye_alpha >= .5f) box(x, y, 4, 4, 0xf2f2ef);
        }
    }
}
static void pi(const muse_pose_t *p)
{
    // Keep Pi's three-color silhouette, with a face and a waving yellow hand.
    int x=88, y=128, s=36, lift=0, gaze=0, eye=8, mouth=4;
    bool happy=p->mode==MUSE_MODE_IDLE && p->happy>.2f;
    if (p->mode==MUSE_MODE_LISTENING) { gaze=-4; eye=12; lift=20; }
    else if (p->mode==MUSE_MODE_THINKING) {
        gaze=sinf(p->mode_t*2)>0 ? -4 : 4; eye=4;
        lift=12+((int)(p->mode_t*3)%3)*4;
    } else if (p->mode==MUSE_MODE_SPEAKING) {
        int beat=(int)(coverage(p->level)*3);
        y-=beat*4; lift=beat*8; mouth=4+beat*4;
    } else if (p->mode==MUSE_MODE_ERROR) {
        x+=(int)(sinf(p->mode_t*14)*2*expf(-p->mode_t*2))*4;
    } else if (p->mode==MUSE_MODE_OFF) { eye=4; y+=4; }
    else { y+=sinf(p->t*1.8f)>.6f ? 4 : 0; if (happy) lift=12+((int)(p->t*5)%2)*8; }
    if (p->mode!=MUSE_MODE_OFF && fmodf(p->t,5.2f)<.18f) eye=4;
    box(x,y,s*3,s,0xf09082); box(x+s*2,y+s,s,s,0xf09082);
    box(x,y+s,s,s*3,0x4d9abf); box(x+s,y+s*2,s,s,0x4d9abf);
    box(x+s*3,y+s*2-lift,s,s*2,0xf1be58);
    for (int i=0; i<2; i++) {
        int ex=x+24+i*48+gaze, ey=y+12;
        if (p->mode==MUSE_MODE_ERROR) {
            box(ex,ey,4,4,0x292638); box(ex+8,ey,4,4,0x292638);
            box(ex+4,ey+4,4,4,0x292638);
            box(ex,ey+8,4,4,0x292638); box(ex+8,ey+8,4,4,0x292638);
        } else if (happy) {
            box(ex,ey,12,4,0x292638); box(ex,ey+4,4,4,0x292638); box(ex+8,ey+4,4,4,0x292638);
        } else box(ex,ey,12,eye,0x292638);
    }
    if (p->mode==MUSE_MODE_SPEAKING) box(x+48,y+20,12,mouth,0x292638);
    if (p->mode==MUSE_MODE_OFF) { dim(); sleep_glint(p->mode_t); }
}
static void dot(const muse_pose_t *p)
{
    int x = 64, y = 92 + (sinf(p->t*1.5f) > .5f ? 4 : 0);
    if (p->mode == MUSE_MODE_LISTENING) y -= 4;
    if (p->mode == MUSE_MODE_SPEAKING) y -= (int)(coverage(p->level)*2)*4;
    if (p->mode == MUSE_MODE_ERROR) x += (int)(sinf(p->mode_t*12)*2*expf(-p->mode_t*2))*4;
    if (p->mode == MUSE_MODE_OFF) y += 4;
    for (int row = 0; row < 48; row++) for (int col = 0; col < 48; col++) {
        uint16_t c = dot_sprite[row*48+col];
        if (!c) continue;
        if (p->mode == MUSE_MODE_OFF) c = (c & 0xf7de) >> 1;
        for (int dy = 0; dy < 4; dy++) for (int dx = 0; dx < 4; dx++)
            pixels[(y+row*4+dy)*SIDE+x+col*4+dx] = c;
    }
    if (p->mode == MUSE_MODE_THINKING) {
        int step = (int)(p->mode_t*4) % 3;
        for (int i = 0; i < 3; i++) box(144+i*12, 292, 8, 4, i == step ? 0x93ffe1 : 0x235f54);
    } else if (p->mode == MUSE_MODE_OFF) sleep_glint(p->mode_t);
    else if (p->mode == MUSE_MODE_ERROR) {
        box(x+116,y+64,12,4,0xf1be58); box(x+124,y+68,4,12,0xf1be58);
    } else if (p->mode == MUSE_MODE_LISTENING || (p->mode == MUSE_MODE_IDLE && p->happy > .2f)) {
        // One small glint answers a tap or a listening transition.
        if ((int)(p->mode_t*4) % 4 < 2) {
            box(x+60, y+80, 12, 4, 0xc6ffee); box(x+64, y+76, 4, 12, 0xc6ffee);
        }
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
