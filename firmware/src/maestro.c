#include "maestro.h"
#include "maestro_settings.h"
#include "maestro_avatar.h"
#include "maestro_reply.h"
#include "muse_settings.h"
#include "muse_ui.h"
#include "esp_system.h"
#include "nvs.h"
#include "muse_mem.h"
#include "muse_state.h"
#include "muse_wifi.h"
#include "esp_random.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_sntp.h"
#include "esp_crt_bundle.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/idf_additions.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "maestro_font.h"
#include "cJSON.h"
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define TARGET_MAX 33
#define VIEW_MAX 34
#define CAPTURE_FRAMES (16000 * 20)
#define JSON_MAX (160 * 1024)
#define AUDIO_FRAMES 320
#define CAPTION_BYTES 64001
typedef struct { char id[200], name[64], detail[96], status[40]; bool available; int character; } target_t;
typedef struct { uint32_t gen; muse_hatch_ev_t type; char text[192]; } event_t;
typedef struct { uint32_t gen; size_t frames; int16_t pcm[AUDIO_FRAMES]; } audio_t;
typedef struct { uint32_t gen; int16_t *pcm; size_t frames; char target[200], id[37]; } job_t;
static QueueHandle_t s_jobs, s_events, s_audio, s_nav;
static SemaphoreHandle_t s_lock;
static target_t *s_targets, s_selected, s_record_target;
static size_t s_count;
static atomic_uint s_gen;
static atomic_bool s_switch, s_refresh;
static atomic_bool s_selection_changed;
static atomic_bool s_bridge_online, s_picker_open, s_settings_open, s_reboot;
static atomic_bool s_reader_open;
static atomic_int s_character;
static size_t s_focus;
static lv_obj_t *s_row_buttons[VIEW_MAX], *s_row_badges[VIEW_MAX], *s_list_note, *s_list_title, *s_home_badge;
static target_t *s_visible, *s_view;
static size_t s_visible_count;
static bool s_native = true;
static int16_t *s_capture;
static size_t s_frames;
static bool s_overflow;
static char *s_caption; // Full UTF-8 reply lives in PSRAM, leaving internal RAM for audio DMA.
static uint32_t s_caption_gen;
static maestro_reply_t s_reply;
static uint64_t s_home_reply_id;
static lv_obj_t *s_label, *s_panel, *s_rows;
static atomic_uint s_list_version;
static uint32_t s_shown_version;
static const char *TAG = "maestro";
static void remember_target(const target_t *target)
{
    cJSON *json = cJSON_CreateObject();
    cJSON_AddStringToObject(json, "id", target->id);
    cJSON_AddStringToObject(json, "name", target->name);
    cJSON_AddNumberToObject(json, "character", target->character);
    char *text = cJSON_PrintUnformatted(json);
    nvs_handle_t handle;
    if (text && nvs_open("maestro", NVS_READWRITE, &handle) == ESP_OK) {
        if (nvs_set_str(handle, "selected", text) == ESP_OK) nvs_commit(handle);
        nvs_close(handle);
    }
    free(text); cJSON_Delete(json);
}
static void text_copy(char *dst, const char *src, size_t cap)
{
    if (!cap) return;
    size_t n = strlen(src);
    if (n >= cap) {
        n = cap - 1;
        while (n && ((unsigned char)src[n] & 0xc0) == 0x80) n--;
    }
    memcpy(dst, src, n); dst[n] = 0;
}
static QueueHandle_t psram_queue(size_t count, size_t item_size)
{
    // Audio packets are CPU-only. Preserve scarce internal RAM for Wi-Fi and TLS.
    uint8_t *storage = heap_caps_malloc(count * item_size, MUSE_BIG_CAPS);
    StaticQueue_t *control = heap_caps_malloc(sizeof(*control), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    configASSERT(storage && control);
    return xQueueCreateStatic(count, item_size, storage, control);
}

static void emit(uint32_t gen, muse_hatch_ev_t type, const char *text)
{
    event_t event = {.gen = gen, .type = type};
    text_copy(event.text, text ? text : "", sizeof(event.text));
    while (gen == atomic_load(&s_gen) && xQueueSend(s_events, &event, pdMS_TO_TICKS(100)) != pdTRUE) {}
}
static const char *field(cJSON *json, const char *name)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(json, name);
    return cJSON_IsString(v) ? v->valuestring : "";
}
static esp_http_client_handle_t open_http(const char *path, const char *type, const void *data, size_t size)
{
    if (!maestro_url()[0] || !maestro_token()[0] || !muse_wifi_connected()) return NULL;
    char url[768], auth[160];
    snprintf(url, sizeof(url), "%s%s", maestro_url(), path);
    snprintf(auth, sizeof(auth), "Bearer %s", maestro_token());
    esp_http_client_config_t cfg = {
        .url = url, .cert_pem = maestro_public_ca() ? NULL : maestro_ca(),
        .crt_bundle_attach = maestro_public_ca() ? esp_crt_bundle_attach : NULL,
        .timeout_ms = !strcmp(path, "/api/speech") ? 60000 : !strncmp(path, "/api/inbox", 10) ? 4000 : 15000,
        .disable_auto_redirect = true, .buffer_size = 4096,
    };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    if (!client) return NULL;
    esp_http_client_set_header(client, "Authorization", auth);
    esp_http_client_set_method(client, data ? HTTP_METHOD_POST : HTTP_METHOD_GET);
    if (data) esp_http_client_set_header(client, "Content-Type", type);
    if (esp_http_client_open(client, size) != ESP_OK) goto fail;
    for (size_t sent = 0; sent < size;) {
        int n = esp_http_client_write(client, (const char *)data + sent, size - sent > 4096 ? 4096 : size - sent);
        if (n <= 0) goto fail;
        sent += n;
    }
    if (esp_http_client_fetch_headers(client) < 0) goto fail;
    int status = esp_http_client_get_status_code(client);
    if (status < 200 || status >= 300) {
        ESP_LOGW(TAG, "bridge HTTP %d", status);
        goto fail;
    }
    return client;
fail:
    esp_http_client_cleanup(client);
    return NULL;
}
static cJSON *json_http(const char *path, const char *type, const void *body, size_t size)
{
    esp_http_client_handle_t client = open_http(path, type, body, size);
    if (!client) return NULL;
    char *buf = heap_caps_malloc(JSON_MAX, MUSE_BIG_CAPS);
    size_t used = 0;
    int n = 0;
    if (buf) {
        while (used < JSON_MAX - 1 && (n = esp_http_client_read(client, buf + used, JSON_MAX - 1 - used)) > 0) used += n;
        buf[used] = '\0';
    }
    bool complete = esp_http_client_is_complete_data_received(client);
    esp_http_client_cleanup(client);
    cJSON *json = buf && n >= 0 && complete ? cJSON_Parse(buf) : NULL;
    free(buf);
    return json;
}
esp_http_client_handle_t maestro_tts_open(const char *text, const char *format)
{
    if (!text || !text[0]) return NULL;
    cJSON *json = cJSON_CreateObject();
    cJSON_AddStringToObject(json, "text", text);
    cJSON_AddStringToObject(json, "format", format);
    char *body = cJSON_PrintUnformatted(json);
    cJSON_Delete(json);
    if (!body) return NULL;
    esp_http_client_handle_t client = open_http("/api/speech", "application/json", body, strlen(body));
    free(body);
    return client;
}
static void refresh_targets(void)
{
    cJSON *json = json_http("/api/targets", NULL, NULL, 0);
    if (!json || !cJSON_IsArray(cJSON_GetObjectItem(json, "targets"))) {
        atomic_store(&s_bridge_online, false);
        atomic_fetch_add(&s_list_version, 1);
        cJSON_Delete(json); return;
    }
    atomic_store(&s_bridge_online, true);
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_count = 1;
    cJSON *item;
    cJSON_ArrayForEach(item, cJSON_GetObjectItem(json, "targets")) {
        if (s_count == TARGET_MAX) break;
        const char *id = field(item, "id");
        if (!id[0] || strlen(id) >= sizeof(s_targets[0].id)) continue;
        target_t *target = &s_targets[s_count++];
        strlcpy(target->id, id, sizeof(target->id));
        text_copy(target->name, field(item, "name"), sizeof(target->name));
        text_copy(target->detail, field(item, "detail"), sizeof(target->detail));
        text_copy(target->status, field(item, "status"), sizeof(target->status));
        const char *character = field(item, "character");
        target->character = !strcmp(character, "grok") ? 1 : !strcmp(character, "codex") ? 2 : !strcmp(character, "claude") ? 3 : !strcmp(character, "dot") ? 5 : 4;
        target->available = cJSON_IsTrue(cJSON_GetObjectItem(item, "available"));
    }
    if (strcmp(s_selected.id, "muse")) {
        s_selected.available = false;
        for (size_t i = 1; i < s_count; i++) if (!strcmp(s_selected.id, s_targets[i].id)) s_selected = s_targets[i];
    }
    atomic_fetch_add(&s_list_version, 1);
    xSemaphoreGive(s_lock);
    cJSON_Delete(json);
}
#include "maestro_inbox.inc"

static bool speak_reply(uint32_t gen, const char *text)
{
    esp_http_client_handle_t client = maestro_tts_open(text, "pcm");
    if (!client) return false;
    audio_t packet = {.gen = gen};
    size_t used = 0, received = 0;
    while (gen == atomic_load(&s_gen)) {
        int n = esp_http_client_read(client, (char *)packet.pcm + used, sizeof(packet.pcm) - used);
        if (n < 0) break;
        received += n;
        used += n;
        if (used == sizeof(packet.pcm) || !n) {
            packet.frames = used / sizeof(int16_t);
            if (packet.frames) {
                while (gen == atomic_load(&s_gen) && xQueueSend(s_audio, &packet, pdMS_TO_TICKS(100)) != pdTRUE) {}
            }
            used = 0;
        }
        if (!n) break;
    }
    bool complete = received > 0 && esp_http_client_is_complete_data_received(client);
    esp_http_client_cleanup(client);
    return complete;
}
static void run_job(job_t *job)
{
    // A released recording owns its destination, even if the user switches
    // before the worker uploads it. Only playback follows the foreground.
    char path[768], escaped[601];
    static const char hex[] = "0123456789ABCDEF";
    size_t p = 0;
    for (const unsigned char *c = (const unsigned char *)job->target; *c && p + 3 < sizeof(escaped); c++) {
        escaped[p++] = '%'; escaped[p++] = hex[*c >> 4]; escaped[p++] = hex[*c & 15];
    }
    escaped[p] = 0;
    snprintf(path, sizeof(path), "/api/voice?id=%s&target=%s", job->id, escaped);
    cJSON *response = json_http(path, "audio/pcm", job->pcm, job->frames * 2);
    free(job->pcm); job->pcm = NULL;
    if (!response) {
        // Never replay an upload: the bridge may have accepted it before the link failed.
        emit(job->gen, MUSE_HATCH_EV_ERROR, "Delivery unclear. Check Maestro on Mac.");
        return;
    }
    cJSON_Delete(response);
    emit(job->gen, MUSE_HATCH_EV_SENT, "");
    // Wake on completion without a full second of blind sleep after each poll.
    snprintf(path, sizeof(path), "/api/turns/%s?wait=1000", job->id);
    int64_t deadline = esp_timer_get_time() + 180LL * 1000000;
    while (esp_timer_get_time() < deadline && job->gen == atomic_load(&s_gen)) {
        int64_t poll_started = esp_timer_get_time();
        response = json_http(path, NULL, NULL, 0);
        if (response) {
            const char *state = field(response, "state");
            if (!strcmp(state, "done") || !strcmp(state, "needs_attention")) {
                char *reply = strdup(field(response, "reply"));
                xSemaphoreTake(s_lock, portMAX_DELAY);
                if (job->gen != atomic_load(&s_gen)) {
                    xSemaphoreGive(s_lock);
                    free(reply); cJSON_Delete(response); return;
                }
                cJSON *target = cJSON_GetObjectItem(response, "target");
                const char *id = field(target, "id");
                if (!strncmp(job->target, "new:", 4) && !strcmp(s_selected.id, job->target)
                    && !strncmp(id, "herdr:", 6) && strlen(id) < sizeof(s_selected.id)) {
                    strlcpy(s_selected.id, id, sizeof(s_selected.id));
                    text_copy(s_selected.name, field(target, "name"), sizeof(s_selected.name));
                    text_copy(s_selected.detail, field(target, "detail"), sizeof(s_selected.detail));
                    s_selected.available = !strcmp(state, "done");
                    remember_target(&s_selected);
                    atomic_store(&s_selection_changed, true);
                    atomic_store(&s_refresh, true);
                }
                maestro_reply_update(&s_reply, 0, reply ? reply : "", true);
                s_caption_gen = job->gen;
                strlcpy(s_read_turn, job->id, sizeof(s_read_turn)); s_read_turn_gen = job->gen;
                xSemaphoreGive(s_lock);
                emit(job->gen, MUSE_HATCH_EV_REPLY, reply);
                cJSON_Delete(response);
                bool spoken = reply && speak_reply(job->gen, reply);
                free(reply);
                if (!spoken && job->gen == atomic_load(&s_gen)) {
                    emit(job->gen, MUSE_HATCH_EV_ERROR, "Speech stopped. Tap the reply.");
                    return;
                }
                emit(job->gen, MUSE_HATCH_EV_DONE, "");
                return;
            }
            if (!strcmp(state, "uncertain") || !strcmp(state, "failed")) {
                emit(job->gen, MUSE_HATCH_EV_ERROR, field(response, "error"));
                cJSON_Delete(response);
                return;
            }
            cJSON_Delete(response);
        }
        // Older bridges ignore the wait query. Keep their request rate bounded,
        // and back off after network failures; new bridges already waited.
        int remaining_ms = 1000 - (esp_timer_get_time() - poll_started) / 1000;
        if (remaining_ms > 0) vTaskDelay(pdMS_TO_TICKS(remaining_ms));
    }
    emit(job->gen, MUSE_HATCH_EV_ERROR, "Still working. Check Maestro on Mac.");
}
static void worker(void *arg)
{
    (void)arg;
    job_t job;
    int64_t refreshed = 0;
    for (;;) {
        if (atomic_exchange(&s_reboot, false)) { vTaskDelay(pdMS_TO_TICKS(500)); esp_restart(); }
        if (xQueueReceive(s_jobs, &job, pdMS_TO_TICKS(1000)) == pdTRUE) {
            run_job(&job);
            free(job.pcm);
        } else if (muse_wifi_connected() && (atomic_exchange(&s_refresh, false) || esp_timer_get_time() - refreshed > 15000000)) {
            refresh_targets();
            refreshed = esp_timer_get_time();
        }
    }
}
void maestro_init(void)
{
    maestro_settings_load();
    s_lock = xSemaphoreCreateMutex();
    s_targets = heap_caps_calloc(TARGET_MAX, sizeof(target_t), MUSE_BIG_CAPS);
    s_visible = heap_caps_calloc(VIEW_MAX, sizeof(target_t), MUSE_BIG_CAPS);
    s_view = heap_caps_calloc(VIEW_MAX, sizeof(target_t), MUSE_BIG_CAPS);
    s_counts = heap_caps_calloc(64, sizeof(inbox_count_t), MUSE_BIG_CAPS);
    configASSERT(s_targets && s_visible && s_view && s_counts);
    s_jobs = psram_queue(2, sizeof(job_t));
    s_events = psram_queue(12, sizeof(event_t));
    s_audio = psram_queue(24, sizeof(audio_t));
    s_nav = psram_queue(8, sizeof(unsigned));
    s_inbox_jobs = psram_queue(16, sizeof(inbox_job_t));
    s_inbox_views = psram_queue(1, sizeof(inbox_job_t));
    s_caption = heap_caps_calloc(CAPTION_BYTES, 1, MUSE_BIG_CAPS);
    configASSERT(s_lock && s_jobs && s_events && s_audio && s_caption);
    s_reply = (maestro_reply_t){.text = s_caption, .capacity = CAPTION_BYTES};
    s_targets[0] = (target_t){.id = "muse", .name = "Muse", .detail = "Your daily assistant", .available = true};
    s_selected = s_targets[0]; s_count = 1;
    nvs_handle_t handle;
    if (nvs_open("maestro", NVS_READONLY, &handle) == ESP_OK) {
        char text[512]; size_t size = sizeof(text);
        if (nvs_get_str(handle, "selected", text, &size) == ESP_OK) {
            cJSON *json = cJSON_Parse(text);
            const char *id = field(json, "id"), *name = field(json, "name");
            cJSON *who = cJSON_GetObjectItemCaseSensitive(json, "character");
            if (id[0] && strlen(id) < sizeof(s_selected.id) && name[0] && cJSON_IsNumber(who)
                && who->valueint >= 0 && who->valueint <= 5) {
                strlcpy(s_selected.id, id, sizeof(s_selected.id));
                text_copy(s_selected.name, name, sizeof(s_selected.name));
                s_selected.character = who->valueint;
                // Restore the identity, but wait for discovery to confirm availability.
                s_selected.available = !strcmp(id, "muse");
                atomic_store(&s_character, s_selected.character);
            }
            cJSON_Delete(json);
        }
        nvs_close(handle);
    }
    if (!esp_sntp_enabled()) {
        esp_sntp_setoperatingmode(SNTP_OPMODE_POLL);
        esp_sntp_setservername(0, "pool.ntp.org");
        esp_sntp_init();
    }
    atomic_store(&s_refresh, true);
    BaseType_t ok = xTaskCreateWithCaps(worker, "maestro", 12288, NULL, 4, NULL, MUSE_BIG_CAPS);
    configASSERT(ok == pdPASS);
    ok = xTaskCreateWithCaps(inbox_worker, "inbox", 10240, NULL, 3, &s_inbox_task, MUSE_BIG_CAPS);
    configASSERT(ok == pdPASS);
}
bool maestro_ready(void)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    bool native = !strcmp(s_selected.id, "muse");
    bool available = s_selected.available;
    xSemaphoreGive(s_lock);
    return native ? muse_hatch_ready() : available && atomic_load(&s_bridge_online) && muse_wifi_connected();
}
void maestro_status(muse_hatch_status_t *out)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    bool native = !strcmp(s_selected.id, "muse");
    xSemaphoreGive(s_lock);
    if (native) muse_hatch_status(out);
    else { memset(out, 0, sizeof(*out)); out->state = maestro_ready() ? MUSE_HATCH_REACHABLE : MUSE_HATCH_OFFLINE; }
}
void maestro_begin(void)
{
    atomic_fetch_add(&s_gen, 1);
    atomic_store(&s_switch, false);
    free(s_capture); s_capture = NULL; s_frames = 0; s_overflow = false;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_record_target = s_selected;
    s_home_reply_id = 0;
    maestro_reply_clear(&s_reply);
    xSemaphoreGive(s_lock);
    s_native = !strcmp(s_record_target.id, "muse");
    if (s_native) muse_hatch_turn_begin();
    else {
        s_capture = heap_caps_malloc(CAPTURE_FRAMES * sizeof(int16_t), MUSE_BIG_CAPS);
        if (!s_capture) emit(atomic_load(&s_gen), MUSE_HATCH_EV_ERROR, "No audio memory. Restart device.");
    }
}
size_t maestro_audio_wait(const int16_t *pcm, size_t frames, uint32_t wait_ms)
{
    if (s_native) return muse_hatch_turn_audio_wait(pcm, frames, wait_ms);
    if (!s_capture) return 0;
    size_t n = frames < CAPTURE_FRAMES - s_frames ? frames : CAPTURE_FRAMES - s_frames;
    memcpy(s_capture + s_frames, pcm, n * sizeof(int16_t)); s_frames += n;
    if (n < frames) s_overflow = true;
    return frames; // An overlong clip fails on release; never send a silently cut command.
}
void maestro_audio(const int16_t *pcm, size_t frames) { (void)maestro_audio_wait(pcm, frames, 0); }
void maestro_end(void)
{
    if (s_native) { muse_hatch_turn_end(); return; }
    if (!s_capture) return;
    uint32_t gen = atomic_load(&s_gen);
    if (s_overflow || s_frames < 4800) {
        free(s_capture); s_capture = NULL;
        emit(gen, MUSE_HATCH_EV_ERROR, "Record a short message and try again."); return;
    }
    job_t job = {.gen = gen, .pcm = s_capture, .frames = s_frames};
    strlcpy(job.target, s_record_target.id, sizeof(job.target));
    unsigned char id[16]; esp_fill_random(id, sizeof(id)); id[6] = (id[6] & 15) | 64; id[8] = (id[8] & 63) | 128;
    snprintf(job.id, sizeof(job.id), "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
        id[0],id[1],id[2],id[3],id[4],id[5],id[6],id[7],id[8],id[9],id[10],id[11],id[12],id[13],id[14],id[15]);
    if (xQueueSend(s_jobs, &job, 0) != pdTRUE) {
        free(s_capture); emit(gen, MUSE_HATCH_EV_ERROR, "Bridge is busy. Try again shortly.");
    }
    s_capture = NULL;
}
void maestro_cancel(void)
{
    atomic_fetch_add(&s_gen, 1);
    if (s_native) muse_hatch_turn_cancel();
    free(s_capture); s_capture = NULL;
}
muse_hatch_ev_t maestro_event(char *text, size_t cap)
{
    if (atomic_exchange(&s_switch, false)) {
        // Selection already invalidated the old generation. Keep the new one
        // so its saved-reply restore can finish after playback stops.
        if (s_native) muse_hatch_turn_cancel();
        free(s_capture); s_capture = NULL;
        strlcpy(text, "Agent changed. Previous work stays on Mac.", cap);
        return MUSE_HATCH_EV_ERROR;
    }
    if (s_native) return muse_hatch_turn_event(text, cap);
    event_t event;
    while (xQueueReceive(s_events, &event, 0) == pdTRUE) {
        if (event.gen == atomic_load(&s_gen)) { strlcpy(text, event.text, cap); return event.type; }
    }
    return MUSE_HATCH_EV_NONE;
}
size_t maestro_read(int16_t *pcm, size_t frames, uint32_t wait_ms)
{
    if (s_native) return muse_hatch_turn_read(pcm, frames, wait_ms);
    audio_t audio;
    while (xQueueReceive(s_audio, &audio, pdMS_TO_TICKS(wait_ms)) == pdTRUE) {
        if (audio.gen != atomic_load(&s_gen)) continue;
        size_t n = audio.frames < frames ? audio.frames : frames;
        memcpy(pcm, audio.pcm, n * sizeof(int16_t)); return n;
    }
    return 0;
}
bool maestro_caption(size_t played, char *out, size_t cap)
{
    if (s_native) return muse_hatch_turn_caption(played, out, cap);
    xSemaphoreTake(s_lock, portMAX_DELAY);
    bool valid = s_caption_gen == atomic_load(&s_gen) && s_caption[0];
    if (valid) {
        size_t length = strlen(s_caption), page = (played / (16000 * 7)) * 210;
        if (page >= length) page = ((length - 1) / 210) * 210;
        while (page && ((unsigned char)s_caption[page] & 0xc0) == 0x80) page--;
        text_copy(out, s_caption + page, cap < 211 ? cap : 211);
    }
    xSemaphoreGive(s_lock);
    return valid;
}
void maestro_resting(bool resting) { muse_hatch_set_resting(resting); }

uint32_t maestro_reply_generation(void) { return atomic_load(&s_gen); }
void maestro_muse_reply(uint32_t gen, unsigned message, const char *text, bool final)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (gen == atomic_load(&s_gen) && !strcmp(s_selected.id, "muse")) {
        maestro_reply_update(&s_reply, message, text, final);
        s_caption_gen = gen;
    }
    xSemaphoreGive(s_lock);
}

#include "maestro_reader.inc"
#include "maestro_thumbnails.inc"
#include "maestro_inbox_ui.inc"

static void close_list(void)
{
    lv_obj_add_flag(s_panel, LV_OBJ_FLAG_HIDDEN);
    atomic_store(&s_picker_open, false);
    muse_ui_set_swipe_enabled(true);
}
static void navigate(unsigned key)
{
    // Preserve button order while LVGL is busy drawing or building a page.
    xQueueSend(s_nav, &key, 0);
}
static void session_label(void)
{
    const char *session = strstr(s_selected.name, " / ");
    lv_label_set_text(s_label, session ? session + 3 :
        s_selected.character >= 2 && !strncmp(s_selected.name, "New ", 4) ? "New session" : "");
}
static void select_target(const target_t *target)
{
    float secs;
    muse_mode_t mode = muse_state_mode(&secs);
    if (mode == MUSE_MODE_LISTENING) return;
    if (inbox_choose(target)) return;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    // A refreshed list can invalidate a row while its confirmation is queued.
    bool current = false;
    for (size_t i = 0; i < s_count; i++)
        if (!strcmp(target->id, s_targets[i].id)) current = s_targets[i].available;
    if (current && (!strcmp(target->id, "muse") || atomic_load(&s_bridge_online))) {
        bool changed = strcmp(s_selected.id, target->id) != 0;
        s_selected = *target;
        if (changed) remember_target(target);
        if (changed) {
            // Invalidate in-flight replies before the voice task handles cancellation.
            atomic_fetch_add(&s_gen, 1);
            maestro_reply_clear(&s_reply);
            s_home_reply_id = 0;
        }
        atomic_store(&s_character, target->character);
        session_label();
        if (changed && (mode == MUSE_MODE_THINKING || mode == MUSE_MODE_SPEAKING)) atomic_store(&s_switch, true);
        else if (changed) {
            muse_state_set_caption("%s", "");
            muse_state_set_mode(MUSE_MODE_IDLE);
        }
        close_list();
        inbox_job_t restore = {.kind = INBOX_RESTORE, .gen = atomic_load(&s_gen), .ticket = atomic_fetch_add(&s_inbox_ticket, 1) + 1};
        strlcpy(restore.target, target->id, sizeof(restore.target));
        if (changed) inbox_queue(restore);
        maestro_haptic();
    }
    xSemaphoreGive(s_lock);
    muse_state_poke();
}
static void choose(lv_event_t *event) { select_target(lv_event_get_user_data(event)); }
static void row_deleted(lv_event_t *event) { free(lv_event_get_user_data(event)); }
static void rows_scrolled(lv_event_t *event) { (void)event; muse_state_poke(); }
static void focus_row(void)
{
    for (size_t i = 0; i < s_visible_count; i++) {
        lv_obj_set_style_border_opa(s_row_buttons[i], i == s_focus ? LV_OPA_COVER : LV_OPA_TRANSP, 0);
    }
    if (!s_visible_count) return;
    lv_obj_update_layout(s_rows);
    lv_area_t row, list;
    lv_obj_get_coords(s_row_buttons[s_focus], &row);
    lv_obj_get_coords(s_rows, &list);
    // Bring a button-selected row out of either curved edge before confirming.
    if (row.y1 < list.y1 + 8 || row.y2 > list.y1 + 272)
        lv_obj_scroll_by_bounded(s_rows, 0, list.y1 + 136 - (row.y1 + row.y2) / 2, LV_ANIM_OFF);
}
static void list_render(void)
{
    const char *note = s_inbox_view ? s_inbox_note : !muse_wifi_connected() ? "Connect Wi-Fi in Settings" :
        atomic_load(&s_bridge_online) ? "" : "Mac offline. Open Maestro.";
    lv_label_set_text(s_list_note, note);
    int top = note[0] ? 142 : 120;
    lv_obj_set_y(s_rows, top);
    lv_obj_set_height(s_rows, lv_obj_get_height(s_panel) - top);
    xSemaphoreTake(s_lock, portMAX_DELAY);
    target_t *view = s_view;
    size_t count;
    if (s_inbox_view) { count = s_inbox_count; memcpy(view, s_inbox_rows, count * sizeof(target_t)); }
    else {
        view[0] = (target_t){.id = "inbox", .name = "Inbox", .character = -1, .available = true};
        memcpy(view + 1, s_targets, s_count * sizeof(target_t)); count = s_count + 1;
    }
    lv_label_set_text(s_list_title, s_inbox_view ? "INBOX" : "AGENTS");
    bool unchanged = s_visible_count == count;
    for (size_t i = 0; unchanged && i < count; i++)
        unchanged = !memcmp(&s_visible[i], &view[i], sizeof(target_t));
    if (unchanged) {
        // Polling the Mac must not reset a finger scroll or delete a pressed row.
        s_shown_version = atomic_load(&s_list_version);
        xSemaphoreGive(s_lock);
        return;
    }
    char focused[200] = "";
    if (s_focus < s_visible_count) strlcpy(focused, s_visible[s_focus].id, sizeof(focused));
    s_visible_count = 0;
    lv_obj_clean(s_rows);
    if (!focused[0]) strlcpy(focused, s_inbox_view ? "" : "inbox", sizeof(focused));
    for (size_t i = 0; i < count; i++) {
        // The row owns its target, so a background refresh cannot change a tap's recipient.
        target_t *target = heap_caps_malloc(sizeof(*target), MUSE_BIG_CAPS);
        if (!target) continue;
        *target = view[i];
        s_visible[s_visible_count] = *target;
        lv_obj_t *button = lv_button_create(s_rows);
        s_row_buttons[s_visible_count++] = button;
        if (!strcmp(focused, target->id)) s_focus = s_visible_count - 1;
        lv_obj_remove_style_all(button);
        lv_obj_set_size(button, 382, 72);
        lv_obj_set_style_bg_opa(button, LV_OPA_COVER, 0);
        lv_obj_set_style_bg_color(button, lv_color_hex(!strcmp(target->id, s_selected.id) ? 0x2e2552 : 0x1a1530), 0);
        lv_obj_set_style_bg_color(button, lv_color_hex(0x3c315d), LV_STATE_PRESSED);
        lv_obj_set_style_radius(button, 0, 0);
        lv_obj_set_style_pad_hor(button, 10, 0);
        lv_obj_set_style_pad_ver(button, 4, 0);
        lv_obj_set_style_border_width(button, 2, 0);
        lv_obj_set_style_border_color(button, lv_color_hex(0xe8cb65), 0);
        lv_obj_set_flex_flow(button, LV_FLEX_FLOW_ROW);
        lv_obj_set_flex_align(button, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
        lv_obj_set_style_pad_column(button, 8, 0);
        if (target->character >= 0) {
            lv_obj_t *portrait = lv_image_create(button);
            lv_image_set_src(portrait, &s_portraits[target->character]);
        } else {
            lv_obj_t *icon = lv_label_create(button);
            lv_obj_set_width(icon, 56); lv_obj_set_style_text_align(icon, LV_TEXT_ALIGN_CENTER, 0);
            lv_obj_set_style_text_font(icon, &maestro_font_24, 0);
            lv_label_set_text(icon, !strcmp(target->id, "inbox") ? LV_SYMBOL_ENVELOPE : LV_SYMBOL_DOWN);
        }
        lv_obj_t *text = lv_obj_create(button);
        lv_obj_remove_style_all(text);
        lv_obj_remove_flag(text, LV_OBJ_FLAG_SCROLLABLE | LV_OBJ_FLAG_CLICKABLE);
        lv_obj_set_flex_grow(text, 1);
        lv_obj_set_height(text, 44);
        lv_obj_t *label = lv_label_create(text);
        // Dots mode needs a fixed height to keep long session names on one line.
        lv_obj_set_size(label, lv_pct(100), lv_font_get_line_height(&maestro_font_20));
        lv_label_set_long_mode(label, LV_LABEL_LONG_MODE_DOTS);
        lv_label_set_text(label, target->name);
        lv_obj_align(label, target->available && !target->detail[0] ? LV_ALIGN_LEFT_MID : LV_ALIGN_TOP_LEFT, 0, 0);
        lv_obj_t *detail = lv_label_create(text);
        lv_obj_set_style_text_font(detail, &maestro_font_16, 0);
        lv_obj_set_style_text_color(detail, lv_color_hex(target->available ? 0xb7c9c1 : 0xd7b98b), 0);
        lv_obj_set_size(detail, lv_pct(100), lv_font_get_line_height(&maestro_font_16));
        lv_label_set_long_mode(detail, LV_LABEL_LONG_MODE_DOTS);
        lv_label_set_text(detail, target->available ? target->detail : target->status);
        lv_obj_align(detail, LV_ALIGN_BOTTOM_LEFT, 0, 0);
        {
            lv_obj_t *selected = lv_label_create(button);
            s_row_badges[s_visible_count - 1] = selected;
            lv_obj_set_style_text_font(selected, &maestro_font_16, 0);
            lv_obj_set_style_text_color(selected, lv_color_hex(0xa77dff), 0);
            lv_label_set_text(selected, "");
        }
        lv_obj_add_event_cb(button, choose, LV_EVENT_CLICKED, target);
        lv_obj_add_event_cb(button, row_deleted, LV_EVENT_DELETE, target);
    }
    s_shown_version = atomic_load(&s_list_version);
    xSemaphoreGive(s_lock);
    if (s_focus >= s_visible_count) s_focus = 0;
    focus_row();
}
static void open_list(lv_event_t *event)
{
    (void)event;
    float secs;
    if (muse_state_mode(&secs) == MUSE_MODE_LISTENING) return;
    close_reader(NULL);
    if (!lv_obj_has_flag(s_panel, LV_OBJ_FLAG_HIDDEN)) {
        if (s_inbox_view) { s_inbox_view = false; s_visible_count = 0; atomic_fetch_add(&s_inbox_ticket, 1); list_render(); return; }
        close_list(); return;
    }
    s_inbox_view = false;
    muse_ui_show_face();
    muse_ui_set_swipe_enabled(false);
    s_focus = 0;
    s_visible_count = 0;
    lv_obj_remove_flag(s_panel, LV_OBJ_FLAG_HIDDEN);
    list_render();
    atomic_store(&s_picker_open, true);
    lv_obj_move_foreground(s_panel);
    atomic_store(&s_refresh, true);
    muse_state_poke();
}
#include "maestro_benchmark.inc"
static void ui_tick(lv_timer_t *timer)
{
    (void)timer;
    unsigned key = 0;
    xQueueReceive(s_nav, &key, 0);
#if CONFIG_LV_USE_SNAPSHOT
    if (key == 8) scroll_benchmark_start();
    scroll_benchmark_tick();
#endif
    inbox_ui_tick();
    reader_tick();
    if (key == 6) open_reader(NULL);
    if (key == 7) inbox_open("", 0);
    if (key == 5) open_list(NULL);
    bool settings = !atomic_load(&s_picker_open) && maestro_ui_settings_is_open();
    maestro_settings_visible(settings);
    if (key == 3) {
        if (atomic_load(&s_reader_open)) close_reader(NULL);
        else if (atomic_load(&s_picker_open)) open_list(NULL);
        else if (settings) maestro_settings_key(3);
        else maestro_ui_open_settings();
    }
    if (key == 4) { close_reader(NULL); close_list(); maestro_ui_open_settings(); }
    if (key == 1) {
        if (atomic_load(&s_reader_open)) reader_page(1);
        else if (settings) maestro_settings_key(1);
        else if (!atomic_load(&s_picker_open)) open_list(NULL);
        else if (s_visible_count) { s_focus = (s_focus + 1) % s_visible_count; focus_row(); }
    }
    if (key == 2) {
        if (atomic_load(&s_reader_open)) reader_page(-1);
        else if (settings) maestro_settings_key(2);
        else if (atomic_load(&s_picker_open) && s_focus < s_visible_count) select_target(&s_visible[s_focus]);
    }
    if (atomic_exchange(&s_selection_changed, false)) {
        xSemaphoreTake(s_lock, portMAX_DELAY);
        session_label();
        xSemaphoreGive(s_lock);
    }
    if (!lv_obj_has_flag(s_panel, LV_OBJ_FLAG_HIDDEN) && s_shown_version != atomic_load(&s_list_version)) list_render();
    float secs;
    static uint32_t caption_version;
    static char caption[MUSE_CAPTION_MAX];
    muse_state_caption(caption, sizeof(caption), &caption_version);
    lv_obj_set_flag(s_label, LV_OBJ_FLAG_HIDDEN, muse_state_mode(&secs) != MUSE_MODE_IDLE || caption[0]);
}
void maestro_show_agents(void) { navigate(5); }
void maestro_show_reply(void) { navigate(6); }
bool maestro_picker_is_open(void) { return atomic_load(&s_picker_open); }
bool maestro_reader_is_open(void) { return atomic_load(&s_reader_open); }
void maestro_settings_visible(bool visible) { atomic_store(&s_settings_open, visible); }
int maestro_character(void) { return atomic_load(&s_character); }
const char *maestro_idle_label(void)
{
    if (!maestro_character()) return "READY";
    if (!atomic_load(&s_bridge_online)) return "MAC OFF";
    return maestro_ready() ? "READY" : "CHECK APP";
}
bool maestro_confirm(void)
{
    if (!atomic_load(&s_picker_open) && !atomic_load(&s_settings_open) && !atomic_load(&s_reader_open)) return false;
    navigate(2); return true;
}
void maestro_aux(bool pressed, bool edge)
{
    static int64_t began;
    static bool swallowed;
    if (pressed && edge) {
        began = esp_timer_get_time();
        swallowed = muse_state_asleep();
        if (swallowed) muse_state_set_asleep(false);
        muse_state_poke();
    }
    float secs;
    if (muse_state_mode(&secs) == MUSE_MODE_LISTENING) { swallowed = true; return; }
    if (pressed && !swallowed && esp_timer_get_time() - began >= 650000) {
        navigate(3); swallowed = true;
    }
    if (!pressed && edge && !swallowed) {
        navigate(1);
        muse_state_poke();
    }
}
bool maestro_console(const char *line, bool whole)
{
    if (strncmp(line, "maestro.", 8)) return false;
    if (!whole) { puts("@maestro.error command too long"); return true; }
    if (!strcmp(line, "maestro.agents")) maestro_show_agents();
    else if (!strcmp(line, "maestro.next")) navigate(1);
    else if (!strcmp(line, "maestro.confirm")) maestro_confirm();
    else if (!strcmp(line, "maestro.settings")) navigate(4);
    else if (!strcmp(line, "maestro.back")) navigate(3);
    else if (!strcmp(line, "maestro.reply")) maestro_show_reply();
    else if (!strcmp(line, "maestro.inbox")) navigate(7);
#if CONFIG_LV_USE_SNAPSHOT
    else if (!strcmp(line, "maestro.benchmark")) navigate(8);
    else if (!strncmp(line, "maestro.preview=", 16)) {
        // USB bench preview, alongside the SDK's face= and screenshot commands.
        // Never sends a message or changes the selected agent.
        xSemaphoreTake(s_lock, portMAX_DELAY);
        maestro_reply_clear(&s_reply);
        maestro_reply_update(&s_reply, 0, line + 16, true);
        s_caption_gen = atomic_fetch_add(&s_gen, 1) + 1;
        xSemaphoreGive(s_lock);
        muse_state_set_caption("%s", line + 16);
    }
#endif
    else if (!strncmp(line, "maestro.setup=", 14)) {
        bool ok = maestro_settings_save(line + 14);
        printf("@maestro.setup {\"ok\":%s}\n", ok ? "true" : "false");
        if (ok) atomic_store(&s_reboot, true);
    } else if (!strcmp(line, "maestro.status")) {
        cJSON *json = cJSON_CreateObject();
        cJSON_AddNumberToObject(json, "version", 3);
        cJSON_AddBoolToObject(json, "remote", maestro_public_ca());
        cJSON_AddBoolToObject(json, "configured", maestro_url()[0]);
        cJSON_AddBoolToObject(json, "bridge", atomic_load(&s_bridge_online));
        cJSON_AddBoolToObject(json, "picker", atomic_load(&s_picker_open));
        cJSON_AddBoolToObject(json, "settings", atomic_load(&s_settings_open));
        cJSON_AddBoolToObject(json, "reader", atomic_load(&s_reader_open));
        cJSON_AddNumberToObject(json, "readerScroll", atomic_load(&s_reader_y));
        cJSON_AddNumberToObject(json, "readerRemaining", atomic_load(&s_reader_remaining));
        xSemaphoreTake(s_lock, portMAX_DELAY);
        cJSON_AddStringToObject(json, "selected", s_selected.id);
        cJSON_AddStringToObject(json, "name", s_selected.name);
        cJSON_AddNumberToObject(json, "agents", s_count);
        cJSON_AddNumberToObject(json, "unread", s_unread);
        cJSON_AddNumberToObject(json, "alertGroups", s_alert_groups);
        cJSON_AddBoolToObject(json, "inbox", s_inbox_view);
        cJSON_AddNumberToObject(json, "inboxRows", s_inbox_view ? s_inbox_count : 0);
        cJSON_AddNumberToObject(json, "inboxViewMs", s_inbox_view_ms);
        cJSON_AddNumberToObject(json, "replyBytes", s_reply.length);
        xSemaphoreGive(s_lock);
        char *text = cJSON_PrintUnformatted(json);
        if (text) printf("@maestro.status %s\n", text);
        free(text); cJSON_Delete(json);
    }
    fflush(stdout);
    return true;
}
void maestro_menu_icons(lv_obj_t *parent)
{
    for (int i = 0; i < 2; i++) {
        lv_obj_t *icon = lv_label_create(parent);
        lv_obj_set_style_text_font(icon, &maestro_font_24, 0);
        lv_obj_set_style_text_color(icon, lv_color_hex(i ? 0x658cff : 0xe8cb65), 0);
        lv_label_set_text(icon, i ? LV_SYMBOL_DOWN : LV_SYMBOL_OK);
        lv_obj_align(icon, LV_ALIGN_CENTER, i ? 128 : -128, -138);
    }
}
lv_obj_t *maestro_back_button(lv_obj_t *parent, lv_event_cb_t callback)
{
    lv_obj_t *button = lv_button_create(parent);
    lv_obj_remove_style_all(button);
    lv_obj_set_size(button, 92, 52);
    lv_obj_align(button, LV_ALIGN_TOP_MID, 0, 18);
    lv_obj_set_style_text_font(button, &maestro_font_16, 0);
    lv_obj_set_style_text_color(button, lv_color_hex(0xa77dff), 0);
    lv_obj_set_style_text_opa(button, LV_OPA_60, LV_STATE_PRESSED);
    lv_obj_add_flag(button, LV_OBJ_FLAG_USER_1); // Physical hold already goes back.
    lv_obj_t *label = lv_label_create(button);
    lv_label_set_text(label, LV_SYMBOL_LEFT "  Back");
    lv_obj_center(label);
    lv_obj_add_event_cb(button, callback, LV_EVENT_CLICKED, NULL);
    return button;
}
void maestro_ui_build(lv_obj_t *parent)
{
    s_inbox_rows = heap_caps_calloc(INBOX_ROWS, sizeof(target_t), MUSE_BIG_CAPS);
    configASSERT(s_inbox_rows);
    portraits_build();
    s_home_badge = lv_label_create(parent);
    lv_obj_set_style_text_font(s_home_badge, &maestro_font_16, 0);
    lv_obj_set_style_text_color(s_home_badge, lv_color_hex(0xeeeaf5), 0);
    lv_obj_set_style_bg_color(s_home_badge, lv_color_hex(0x563593), 0);
    lv_obj_set_style_bg_opa(s_home_badge, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(s_home_badge, 0, 0);
    lv_obj_set_style_pad_hor(s_home_badge, 5, 0);
    lv_obj_set_style_pad_ver(s_home_badge, 2, 0);
    lv_obj_align(s_home_badge, LV_ALIGN_CENTER, 140, -118);
    lv_obj_add_flag(s_home_badge, LV_OBJ_FLAG_HIDDEN);
    s_label = lv_label_create(parent);
    lv_obj_set_style_text_font(s_label, &maestro_font_16, 0);
    lv_obj_set_style_text_color(s_label, lv_color_hex(0xb7b0cc), 0);
    lv_obj_set_size(s_label, 270, lv_font_get_line_height(&maestro_font_16));
    lv_obj_set_style_text_align(s_label, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_long_mode(s_label, LV_LABEL_LONG_MODE_DOTS);
    session_label();
    lv_obj_align(s_label, LV_ALIGN_TOP_MID, 0, 376);
    s_panel = lv_obj_create(lv_screen_active());
    lv_obj_remove_style_all(s_panel);
    lv_obj_set_size(s_panel, lv_pct(100), lv_pct(100));
    lv_obj_center(s_panel);
    lv_obj_set_style_bg_color(s_panel, lv_color_black(), 0);
    lv_obj_set_style_bg_opa(s_panel, LV_OPA_COVER, 0);
    lv_obj_set_style_text_font(s_panel, &maestro_font_20, 0);
    // The panel clips the edges. A software circular mask forces LVGL to
    // allocate and blend an offscreen layer on every scroll frame.
    lv_obj_remove_flag(s_panel, LV_OBJ_FLAG_SCROLLABLE);
    maestro_menu_icons(s_panel);
    maestro_back_button(s_panel, open_list);
    lv_obj_t *title = lv_label_create(s_panel); s_list_title = title;
    lv_obj_set_style_text_font(title, &maestro_font_24, 0);
    lv_obj_set_style_text_color(title, lv_color_hex(0xa77dff), 0);
    lv_obj_set_style_text_letter_space(title, 2, 0);
    lv_label_set_text(title, "AGENTS"); lv_obj_align(title, LV_ALIGN_CENTER, 0, -138);
    s_rows = lv_obj_create(s_panel);
    lv_obj_remove_style_all(s_rows);
    lv_obj_set_size(s_rows, lv_pct(100), 346); lv_obj_align(s_rows, LV_ALIGN_TOP_MID, 0, 120);
    lv_obj_set_flex_flow(s_rows, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(s_rows, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_row(s_rows, 10, 0);
    lv_obj_set_style_pad_top(s_rows, 8, 0);
    lv_obj_set_style_pad_bottom(s_rows, 136, 0);
    lv_obj_set_scroll_dir(s_rows, LV_DIR_VER);
    lv_obj_remove_flag(s_rows, LV_OBJ_FLAG_SCROLL_CHAIN | LV_OBJ_FLAG_SCROLL_ELASTIC);
    lv_obj_set_scrollbar_mode(s_rows, LV_SCROLLBAR_MODE_OFF);
    lv_obj_add_event_cb(s_rows, rows_scrolled, LV_EVENT_SCROLL, NULL);
    s_list_note = lv_label_create(s_panel);
    lv_obj_set_style_text_font(s_list_note, &maestro_font_16, 0);
    lv_obj_align(s_list_note, LV_ALIGN_TOP_MID, 0, 118);
    lv_obj_add_flag(s_panel, LV_OBJ_FLAG_HIDDEN);
    reader_build();
#if CONFIG_LV_USE_SNAPSHOT
    lv_display_add_event_cb(lv_display_get_default(), scroll_benchmark_event, LV_EVENT_ALL, NULL);
#endif
    lv_timer_create(ui_tick, 30, NULL);
}
