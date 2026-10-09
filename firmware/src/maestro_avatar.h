#pragma once
#include "muse_pixel.h"
// Share the SDK's display layer, captions and frame cadence. Muse stays native.
bool maestro_avatar_render(const muse_pose_t *pose);
bool maestro_avatar_scale(uint16_t *dst, int stride, int x0, int x1, int y0, int y1, int size);
// UI startup only, before the first animated frame; caller restores canvas size.
void maestro_avatar_snapshot(int character, uint16_t *dst);
