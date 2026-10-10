#include "maestro_settings.h"
#include "nvs.h"
#include "cJSON.h"
#include <string.h>
#include <stdlib.h>

// Read once, then immutable until reboot: HTTP and pairing retain these pointers.
static char s_url[256], s_token[129], s_ca[4096], s_muse[512];
static bool s_loaded, s_public_ca;
static const char *value(cJSON *json, const char *key, size_t max)
{
    cJSON *v = cJSON_GetObjectItemCaseSensitive(json, key);
    return cJSON_IsString(v) && strlen(v->valuestring) < max ? v->valuestring : NULL;
}
static bool parse(const char *text, bool apply)
{
    cJSON *json = cJSON_Parse(text);
    const char *url = value(json, "url", sizeof(s_url));
    const char *token = value(json, "token", sizeof(s_token));
    const char *ca = value(json, "ca", sizeof(s_ca));
    const char *muse = value(json, "muse", sizeof(s_muse));
    const cJSON *trust = cJSON_GetObjectItemCaseSensitive(json, "trust");
    bool public_ca = cJSON_IsString(trust) && !strcmp(trust->valuestring, "public");
    bool trust_ok = !trust || public_ca;
    bool ok = url && !strncmp(url, "https://", 8) && strlen(url) > 8
        && !strpbrk(url, "\r\n ?#@") && token && strlen(token) >= 32
        && !strpbrk(token, "\r\n ") && trust_ok && ca
        && (public_ca ? !ca[0] : strstr(ca, "-----BEGIN CERTIFICATE-----") != NULL)
        && muse && (!muse[0] || (!strncmp(muse, "mgst_", 5) && !strpbrk(muse, " \r\n\t")));
    if (ok && apply) {
        strcpy(s_url, url); strcpy(s_token, token); strcpy(s_ca, ca); strcpy(s_muse, muse);
        s_public_ca = public_ca;
    }
    cJSON_Delete(json);
    return ok;
}
void maestro_settings_load(void)
{
    if (s_loaded) return;
    s_loaded = true;
    nvs_handle_t handle;
    if (nvs_open("maestro", NVS_READONLY, &handle) != ESP_OK) return;
    size_t size = 0;
    if (nvs_get_str(handle, "setup", NULL, &size) == ESP_OK && size <= 7000) {
        char *text = malloc(size);
        if (text && nvs_get_str(handle, "setup", text, &size) == ESP_OK) parse(text, true);
        free(text);
    }
    nvs_close(handle);
}
bool maestro_settings_save(const char *text)
{
    if (strlen(text) >= 7000 || !parse(text, false)) return false;
    nvs_handle_t handle;
    if (nvs_open("maestro", NVS_READWRITE, &handle) != ESP_OK) return false;
    esp_err_t err = nvs_set_str(handle, "setup", text);
    if (err == ESP_OK) err = nvs_commit(handle);
    nvs_close(handle);
    return err == ESP_OK;
}
const char *maestro_url(void) { return s_url; }
const char *maestro_token(void) { return s_token; }
const char *maestro_ca(void) { return s_ca; }
bool maestro_public_ca(void) { return s_public_ca; }
const char *maestro_muse_token(void) { maestro_settings_load(); return s_muse[0] ? s_muse : NULL; }
