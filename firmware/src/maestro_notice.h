#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef struct { int64_t pending_at, quiet_at; uint64_t newest, alerted; } maestro_notice_t;
// Coalesce a burst, then wait for a quiet gap. The caller acknowledges only the
// IDs present in that burst; new arrivals cannot be cleared by an older alert.
static inline bool maestro_notice_due(maestro_notice_t *s, int64_t now, bool quiet, uint64_t newest)
{
    if (newest > s->newest) { s->newest = newest; s->pending_at = now; }
    if (!quiet) s->quiet_at = 0;
    else if (!s->quiet_at) s->quiet_at = now;
    return newest > s->alerted && quiet && now - s->quiet_at >= 1500 && now - s->pending_at >= 2000;
}
