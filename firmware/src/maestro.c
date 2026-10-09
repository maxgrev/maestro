#include "maestro.h"
#include "maestro_config.h"
#include "muse_mem.h"
#include "muse_state.h"
#include "muse_wifi.h"
#include "esp_random.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_sntp.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/idf_additions.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "cJSON.h"
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define TARGET_MAX 17
#define CAPTURE_FRAMES (16000 * 20)
#define JSON_MAX 65536
#define AUDIO_FRAMES 320
typedef struct { char id[200], name[64], detail[96]; bool available; } target_t;
typedef struct { uint32_t gen; muse_hatch_ev_t type; char text[192]; } event_t;
typedef struct { uint32_t gen; size_t frames; int16_t pcm[AUDIO_FRAMES]; } audio_t;
typedef struct { uint32_t gen; int16_t *pcm; size_t frames; char target[200], id[37]; } job_t;
static QueueHandle_t s_jobs, s_events, s_audio;
static SemaphoreHandle_t s_lock;
static target_t s_targets[TARGET_MAX], s_selected, s_record_target;
static size_t s_count;
static atomic_uint s_gen;
static atomic_bool s_switch, s_refresh;
static atomic_bool s_show_agents;
static atomic_bool s_selection_changed;
static bool s_native = true;
static int16_t *s_capture;
static size_t s_frames;
static bool s_overflow;
static char s_caption[1801];
static uint32_t s_caption_gen;
static lv_obj_t *s_label, *s_panel, *s_rows;
static atomic_uint s_list_version;
static uint32_t s_shown_version;
static const char *TAG = "maestro";
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
    if (!MAESTRO_URL[0] || !MAESTRO_TOKEN[0] || !muse_wifi_connected()) return NULL;
    char url[768], auth[160];
    snprintf(url, sizeof(url), "%s%s", MAESTRO_URL, path);
    snprintf(auth, sizeof(auth), "Bearer %s", MAESTRO_TOKEN);
    esp_http_client_config_t cfg = {
        .url = url, .cert_pem = MAESTRO_CA, .timeout_ms = 15000,
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
    char short_text[1801];
    text_copy(short_text, text, sizeof(short_text));
    cJSON_AddStringToObject(json, "text", short_text);
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
    if (!json) return;
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
        target->available = cJSON_IsTrue(cJSON_GetObjectItem(item, "available"));
    }
    atomic_fetch_add(&s_list_version, 1);
    xSemaphoreGive(s_lock);
    cJSON_Delete(json);
}
static void speak_reply(uint32_t gen, const char *text)
{
    esp_http_client_handle_t client = maestro_tts_open(text, "pcm");
    if (!client) return; // Text remains usable when host speech is unavailable.
    audio_t packet = {.gen = gen};
    size_t used = 0;
    while (gen == atomic_load(&s_gen)) {
        int n = esp_http_client_read(client, (char *)packet.pcm + used, sizeof(packet.pcm) - used);
        if (n < 0) break;
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
    esp_http_client_cleanup(client);
}
static void run_job(job_t *job)
{
    if (job->gen != atomic_load(&s_gen)) return;
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
    snprintf(path, sizeof(path), "/api/turns/%s", job->id);
    int64_t deadline = esp_timer_get_time() + 180LL * 1000000;
    while (esp_timer_get_time() < deadline && job->gen == atomic_load(&s_gen)) {
        response = json_http(path, NULL, NULL, 0);
        if (response) {
            const char *state = field(response, "state");
            if (!strcmp(state, "done") || !strcmp(state, "needs_attention")) {
                char *reply = strdup(field(response, "reply"));
                xSemaphoreTake(s_lock, portMAX_DELAY);
                cJSON *target = cJSON_GetObjectItem(response, "target");
                const char *id = field(target, "id");
                if (!strncmp(job->target, "new:", 4) && !strcmp(s_selected.id, job->target)
                    && !strncmp(id, "herdr:", 6) && strlen(id) < sizeof(s_selected.id)) {
                    strlcpy(s_selected.id, id, sizeof(s_selected.id));
                    text_copy(s_selected.name, field(target, "name"), sizeof(s_selected.name));
                    text_copy(s_selected.detail, field(target, "detail"), sizeof(s_selected.detail));
                    s_selected.available = !strcmp(state, "done");
                    atomic_store(&s_selection_changed, true);
                    atomic_store(&s_refresh, true);
                }
                text_copy(s_caption, reply ? reply : "", sizeof(s_caption));
                s_caption_gen = job->gen;
                xSemaphoreGive(s_lock);
                emit(job->gen, MUSE_HATCH_EV_REPLY, reply);
                cJSON_Delete(response);
                if (reply) speak_reply(job->gen, reply);
                free(reply);
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
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
    emit(job->gen, MUSE_HATCH_EV_ERROR, "Still working. Check Maestro on Mac.");
}
static void worker(void *arg)
{
    (void)arg;
    job_t job;
    for (;;) {
        if (xQueueReceive(s_jobs, &job, pdMS_TO_TICKS(1000)) == pdTRUE) {
            run_job(&job);
            free(job.pcm);
        } else if (atomic_exchange(&s_refresh, false) && muse_wifi_connected()) {
            refresh_targets();
        }
    }
}
void maestro_init(void)
{
    s_lock = xSemaphoreCreateMutex();
    s_jobs = psram_queue(2, sizeof(job_t));
    s_events = psram_queue(12, sizeof(event_t));
    s_audio = psram_queue(24, sizeof(audio_t));
    configASSERT(s_lock && s_jobs && s_events && s_audio);
    s_targets[0] = (target_t){.id = "muse", .name = "Muse", .detail = "Your daily assistant", .available = true};
    s_selected = s_targets[0]; s_count = 1;
    if (!esp_sntp_enabled()) {
        esp_sntp_setoperatingmode(SNTP_OPMODE_POLL);
        esp_sntp_setservername(0, "pool.ntp.org");
        esp_sntp_init();
    }
    atomic_store(&s_refresh, true);
    BaseType_t ok = xTaskCreateWithCaps(worker, "maestro", 12288, NULL, 4, NULL, MUSE_BIG_CAPS);
    configASSERT(ok == pdPASS);
}
bool maestro_ready(void)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    bool native = !strcmp(s_selected.id, "muse");
    bool available = s_selected.available;
    xSemaphoreGive(s_lock);
    return native ? muse_hatch_ready() : available && MAESTRO_URL[0] && muse_wifi_connected();
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
        maestro_cancel();
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

static void choose(lv_event_t *event)
{
    float secs;
    muse_mode_t mode = muse_state_mode(&secs);
    if (mode == MUSE_MODE_LISTENING) return;
    const target_t *target = lv_event_get_user_data(event);
    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (target->available) {
        s_selected = *target;
        lv_label_set_text(s_label, s_selected.name);
        if (mode == MUSE_MODE_THINKING || mode == MUSE_MODE_SPEAKING) atomic_store(&s_switch, true);
        lv_obj_add_flag(s_panel, LV_OBJ_FLAG_HIDDEN);
    }
    xSemaphoreGive(s_lock);
    muse_state_poke();
}
static void row_deleted(lv_event_t *event) { free(lv_event_get_user_data(event)); }
static void list_render(void)
{
    lv_obj_clean(s_rows);
    xSemaphoreTake(s_lock, portMAX_DELAY);
    for (size_t i = 0; i < s_count; i++) {
        // The row owns its target, so a background refresh cannot change a tap's recipient.
        target_t *target = heap_caps_malloc(sizeof(*target), MUSE_BIG_CAPS);
        if (!target) continue;
        *target = s_targets[i];
        lv_obj_t *button = lv_button_create(s_rows);
        lv_obj_set_size(button, lv_pct(100), 48);
        lv_obj_set_style_bg_color(button, lv_color_hex(!strcmp(s_targets[i].id, s_selected.id) ? 0x28443a : 0x171b1e), 0);
        lv_obj_set_style_radius(button, 10, 0);
        if (!s_targets[i].available) lv_obj_add_state(button, LV_STATE_DISABLED);
        lv_obj_t *label = lv_label_create(button);
        lv_obj_set_width(label, 236);
        lv_label_set_long_mode(label, LV_LABEL_LONG_MODE_DOTS);
        lv_label_set_text(label, s_targets[i].name);
        lv_obj_center(label);
        lv_obj_add_event_cb(button, choose, LV_EVENT_CLICKED, target);
        lv_obj_add_event_cb(button, row_deleted, LV_EVENT_DELETE, target);
    }
    s_shown_version = atomic_load(&s_list_version);
    xSemaphoreGive(s_lock);
}
static void open_list(lv_event_t *event)
{
    (void)event;
    float secs;
    if (muse_state_mode(&secs) == MUSE_MODE_LISTENING) return;
    if (!lv_obj_has_flag(s_panel, LV_OBJ_FLAG_HIDDEN)) { lv_obj_add_flag(s_panel, LV_OBJ_FLAG_HIDDEN); return; }
    list_render();
    lv_obj_remove_flag(s_panel, LV_OBJ_FLAG_HIDDEN);
    lv_obj_move_foreground(s_panel);
    atomic_store(&s_refresh, true);
    muse_state_poke();
}
static void ui_tick(lv_timer_t *timer)
{
    (void)timer;
    if (atomic_exchange(&s_show_agents, false)) open_list(NULL);
    if (atomic_exchange(&s_selection_changed, false)) {
        xSemaphoreTake(s_lock, portMAX_DELAY);
        lv_label_set_text(s_label, s_selected.name);
        xSemaphoreGive(s_lock);
    }
    if (!lv_obj_has_flag(s_panel, LV_OBJ_FLAG_HIDDEN) && s_shown_version != atomic_load(&s_list_version)) list_render();
}
void maestro_show_agents(void) { atomic_store(&s_show_agents, true); }
void maestro_ui_build(lv_obj_t *parent)
{
    lv_obj_t *button = lv_button_create(parent);
    lv_obj_set_size(button, 260, 42);
    lv_obj_align(button, LV_ALIGN_TOP_MID, 0, 84);
    lv_obj_set_style_bg_color(button, lv_color_hex(0x172320), 0);
    lv_obj_set_style_radius(button, 21, 0);
    lv_obj_set_style_text_font(button, &lv_font_montserrat_20, 0);
    s_label = lv_label_create(button);
    lv_obj_set_width(s_label, 236);
    lv_obj_set_style_text_align(s_label, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_long_mode(s_label, LV_LABEL_LONG_MODE_DOTS);
    lv_label_set_text(s_label, "Muse");
    lv_obj_center(s_label);
    lv_obj_add_event_cb(button, open_list, LV_EVENT_CLICKED, NULL);
    s_panel = lv_obj_create(lv_screen_active());
    lv_obj_set_size(s_panel, 312, 336);
    lv_obj_center(s_panel);
    lv_obj_set_style_bg_color(s_panel, lv_color_hex(0x090c0d), 0);
    lv_obj_set_style_border_color(s_panel, lv_color_hex(0x31483e), 0);
    lv_obj_set_style_radius(s_panel, 24, 0);
    lv_obj_set_style_text_font(s_panel, &lv_font_montserrat_20, 0);
    lv_obj_remove_flag(s_panel, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_t *close = lv_button_create(s_panel);
    lv_obj_set_size(close, 270, 40); lv_obj_align(close, LV_ALIGN_TOP_MID, 0, 0);
    lv_obj_t *title = lv_label_create(close); lv_label_set_text(title, "Choose agent   " LV_SYMBOL_CLOSE); lv_obj_center(title);
    lv_obj_add_event_cb(close, open_list, LV_EVENT_CLICKED, NULL);
    s_rows = lv_obj_create(s_panel);
    lv_obj_set_size(s_rows, 282, 252); lv_obj_align(s_rows, LV_ALIGN_BOTTOM_MID, 0, 0);
    lv_obj_set_style_pad_all(s_rows, 0, 0); lv_obj_set_style_border_width(s_rows, 0, 0);
    lv_obj_set_style_bg_opa(s_rows, LV_OPA_TRANSP, 0);
    lv_obj_set_flex_flow(s_rows, LV_FLEX_FLOW_COLUMN);
    lv_obj_add_flag(s_panel, LV_OBJ_FLAG_HIDDEN);
    lv_timer_create(ui_tick, 500, NULL);
}
