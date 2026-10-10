// The inbox task owns this client. ESP-IDF drains each response and reuses the
// authenticated TLS connection; audio keeps its separate streaming client.
typedef struct { char *data; size_t used; bool overflow; } inbox_response_t;
static esp_err_t inbox_http_event(esp_http_client_event_t *event)
{
    inbox_response_t *response = event->user_data;
    if (event->event_id == HTTP_EVENT_ON_DATA && response && response->data) {
        if (event->data_len < 0 || (size_t)event->data_len >= JSON_MAX - response->used) response->overflow = true;
        if (!response->overflow) {
            memcpy(response->data + response->used, event->data, event->data_len);
            response->used += event->data_len;
        }
    }
    return ESP_OK;
}
static cJSON *inbox_http(const char *path, const char *body)
{
    static esp_http_client_handle_t client;
    static inbox_response_t response;
    if (!maestro_inbox_enabled() || !muse_wifi_connected()) return NULL;
    char url[1100], auth[160];
    if (snprintf(url, sizeof(url), "%s%s", maestro_url(), path) >= sizeof(url)) return NULL;
    response = (inbox_response_t){.data = heap_caps_malloc(JSON_MAX, MUSE_BIG_CAPS)};
    if (!response.data) return NULL;
    cJSON *json = NULL;
    // Only reads retry immediately on a stale keep-alive socket. Inbox writes
    // retain their existing ID-based retry policy; prompts never use this client.
    for (int attempt = 0; attempt < (body ? 1 : 2); attempt++) {
        if (!client) {
            esp_http_client_config_t config = {
                .url = url, .cert_pem = maestro_public_ca() ? NULL : maestro_ca(),
                .crt_bundle_attach = maestro_public_ca() ? esp_crt_bundle_attach : NULL,
                .timeout_ms = 4000, .disable_auto_redirect = true, .max_authorization_retries = -1,
                .buffer_size = 4096, .keep_alive_enable = true,
                .event_handler = inbox_http_event, .user_data = &response,
            };
            client = esp_http_client_init(&config);
            if (!client) break;
        }
        response.used = 0; response.overflow = false;
        snprintf(auth, sizeof(auth), "Bearer %s", maestro_token());
        esp_http_client_set_url(client, url);
        esp_http_client_set_header(client, "Authorization", auth);
        esp_http_client_set_method(client, body ? HTTP_METHOD_POST : HTTP_METHOD_GET);
        esp_http_client_set_post_field(client, body, body ? strlen(body) : 0);
        if (body) esp_http_client_set_header(client, "Content-Type", "application/json");
        else esp_http_client_delete_header(client, "Content-Type");
        esp_err_t error = esp_http_client_perform(client);
        int status = esp_http_client_get_status_code(client);
        if (error == ESP_OK && !response.overflow && esp_http_client_is_complete_data_received(client)) {
            response.data[response.used] = 0;
            if (status >= 200 && status < 300) json = cJSON_Parse(response.data);
            else ESP_LOGW(TAG, "inbox HTTP %d", status);
            break;
        }
        esp_http_client_cleanup(client); client = NULL;
    }
    free(response.data); response.data = NULL;
    return json;
}
