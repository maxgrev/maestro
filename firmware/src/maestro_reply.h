#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// One turn, with up to eight Muse messages. The caller owns storage and locking.
typedef struct {
    char *text;
    size_t capacity, length, lengths[8];
    unsigned count;
    uint32_t version;
    bool final[8], truncated;
} maestro_reply_t;
void maestro_reply_clear(maestro_reply_t *reply);
void maestro_reply_update(maestro_reply_t *reply, unsigned message, const char *text, bool final);
