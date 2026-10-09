#pragma once
#include "muse_pixel.h"
// These share the SDK's 64-pixel canvas, resizing, captions and frame cadence.
bool maestro_avatar_render(const muse_pose_t *pose);
bool maestro_avatar_scale(uint16_t *dst, int stride, int x0, int x1, int y0, int y1, int size);
