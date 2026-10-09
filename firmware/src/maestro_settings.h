#pragma once
#include <stdbool.h>
void maestro_settings_load(void);
const char *maestro_url(void);
const char *maestro_token(void);
const char *maestro_ca(void);
const char *maestro_muse_token(void);
bool maestro_settings_save(const char *json);
