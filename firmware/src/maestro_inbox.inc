// Network work runs on Maestro's existing worker. UI results cross one mutex;
// view tickets prevent a late HTTP response from opening a page the user left.
#include "maestro_notice.h"
#define INBOX_ROWS 22
typedef struct { int kind; uint32_t gen, ticket; uint64_t id; char target[200]; char *body; } inbox_job_t;
typedef struct { char target[200]; unsigned unread; bool attention; } inbox_count_t;
static QueueHandle_t s_inbox_jobs;
static inbox_count_t *s_counts;
static size_t s_counts_len;
static uint64_t s_alerts[64];
static size_t s_alert_len;
static unsigned s_unread;
static cJSON *s_inbox_result;
static inbox_job_t s_inbox_result_job;
static atomic_uint s_inbox_ticket;
static maestro_notice_t s_notice;
static uint32_t s_alert_groups;
static char s_read_turn[37];
static uint32_t s_read_turn_gen;
static int64_t s_inbox_polled;
enum { INBOX_PAGE = 1, INBOX_DETAIL, INBOX_RESTORE, INBOX_ACK, INBOX_MUSE, INBOX_READ_TURN };

bool maestro_inbox_enabled(void) { return maestro_url()[0] && maestro_token()[0]; }

static bool inbox_queue(inbox_job_t job)
{
    if (s_inbox_jobs && xQueueSend(s_inbox_jobs, &job, 0) == pdTRUE) return true;
    free(job.body); return false;
}
static bool inbox_post(int kind, cJSON *body)
{
    char *text = cJSON_PrintUnformatted(body); cJSON_Delete(body);
    return text && inbox_queue((inbox_job_t){.kind = kind, .body = text});
}
static bool inbox_ack(const uint64_t *ids, size_t count, bool read)
{
    cJSON *body = cJSON_CreateObject(), *array = cJSON_AddArrayToObject(body, "ids");
    for (size_t i = 0; i < count; i++) cJSON_AddItemToArray(array, cJSON_CreateNumber(ids[i]));
    cJSON_AddStringToObject(body, "kind", read ? "read" : "alert");
    return inbox_post(INBOX_ACK, body);
}
void maestro_muse_inbox(const char *id, const char *text, bool foreground)
{
    if (!id || !id[0] || !text || !text[0]) return;
    cJSON *body = cJSON_CreateObject();
    cJSON_AddStringToObject(body, "id", id);
    cJSON_AddStringToObject(body, "text", text);
    cJSON_AddBoolToObject(body, "read", foreground);
    if (!inbox_post(INBOX_MUSE, body)) ESP_LOGW(TAG, "Muse inbox queue full");
}
static void inbox_sync(void)
{
    if (esp_timer_get_time() - s_inbox_polled < 3000000 || !muse_wifi_connected()) return;
    s_inbox_polled = esp_timer_get_time();
    cJSON *json = json_http("/api/inbox/status", NULL, NULL, 0);
    if (!json) return;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_counts_len = s_alert_len = s_unread = 0;
    cJSON *item;
    cJSON_ArrayForEach(item, cJSON_GetObjectItem(json, "counts")) {
        if (s_counts_len == 64) break;
        inbox_count_t *count = &s_counts[s_counts_len++];
        text_copy(count->target, field(item, "target"), sizeof(count->target));
        count->unread = (unsigned)cJSON_GetNumberValue(cJSON_GetObjectItem(item, "unread"));
        count->attention = cJSON_GetNumberValue(cJSON_GetObjectItem(item, "attention")) > 0;
        s_unread += count->unread;
    }
    cJSON_ArrayForEach(item, cJSON_GetObjectItem(json, "alerts")) {
        uint64_t id = (uint64_t)cJSON_GetNumberValue(cJSON_GetObjectItem(item, "id"));
        if (s_alert_len < 64 && id > s_notice.alerted) s_alerts[s_alert_len++] = id;
    }
    xSemaphoreGive(s_lock);
    cJSON_Delete(json);
}
static void escape_target(char *out, size_t cap, const char *target)
{
    size_t n = 0;
    for (const unsigned char *p = (const unsigned char *)target; *p && n + 3 < cap; p++)
        n += snprintf(out + n, cap - n, "%%%02X", *p);
    out[n] = 0;
}
static void inbox_work(void)
{
    static inbox_job_t pending;
    static int64_t retry_at;
    if (!pending.kind && xQueueReceive(s_inbox_jobs, &pending, 0) != pdTRUE) return;
    if (!muse_wifi_connected() || esp_timer_get_time() < retry_at) return;
    bool post = pending.kind >= INBOX_ACK;
    if (!post && pending.ticket != atomic_load(&s_inbox_ticket)) { pending.kind = 0; return; }
    char path[850], escaped[601];
    if (pending.kind == INBOX_DETAIL) snprintf(path, sizeof(path), "/api/inbox/%llu?maxBytes=64000", pending.id);
    else if (!post) {
        escape_target(escaped, sizeof(escaped), pending.target);
        snprintf(path, sizeof(path), "/api/inbox?before=%llu&target=%s", pending.id ? pending.id : 9007199254740991ULL, escaped);
    } else strlcpy(path, pending.kind == INBOX_ACK ? "/api/inbox/ack" : pending.kind == INBOX_MUSE ? "/api/inbox/muse" : "/api/inbox/read-turn", sizeof(path));
    cJSON *json = json_http(path, post ? "application/json" : NULL, pending.body, pending.body ? strlen(pending.body) : 0);
    if (!json) { retry_at = esp_timer_get_time() + 3000000; return; }
    if (pending.kind == INBOX_RESTORE) {
        cJSON *item = cJSON_GetArrayItem(cJSON_GetObjectItem(json, "items"), 0);
        cJSON *number = cJSON_GetObjectItem(item, "id");
        uint64_t id = cJSON_IsNumber(number) ? (uint64_t)number->valuedouble : 0;
        cJSON_Delete(json); json = NULL;
        if (id) {
            snprintf(path, sizeof(path), "/api/inbox/%llu?maxBytes=64000", id);
            json = json_http(path, NULL, NULL, 0);
            if (!json) { retry_at = esp_timer_get_time() + 3000000; return; }
        }
    }
    if (!post) {
        xSemaphoreTake(s_lock, portMAX_DELAY);
        if (pending.ticket == atomic_load(&s_inbox_ticket)) {
            cJSON_Delete(s_inbox_result);
            s_inbox_result = json; json = NULL;
            s_inbox_result_job = pending;
        }
        xSemaphoreGive(s_lock);
    }
    cJSON_Delete(json); free(pending.body); pending = (inbox_job_t){0}; retry_at = 0;
    s_inbox_polled = 0;
}
