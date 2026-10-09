#pragma once
#include "muse_chat.h"
#include "esp_http_client.h"
#include "lvgl.h"
#ifdef __cplusplus
extern "C" {
#endif
void maestro_init(void);
void maestro_ui_build(lv_obj_t *parent);
void maestro_show_agents(void);
bool maestro_ready(void);
void maestro_status(muse_hatch_status_t *out);
void maestro_begin(void);
void maestro_audio(const int16_t *pcm, size_t frames);
size_t maestro_audio_wait(const int16_t *pcm, size_t frames, uint32_t wait_ms);
void maestro_end(void);
void maestro_cancel(void);
muse_hatch_ev_t maestro_event(char *text, size_t cap);
size_t maestro_read(int16_t *pcm, size_t frames, uint32_t wait_ms);
bool maestro_caption(size_t played, char *out, size_t cap);
void maestro_resting(bool resting);
esp_http_client_handle_t maestro_tts_open(const char *text, const char *format);
#ifdef __cplusplus
}
#endif
