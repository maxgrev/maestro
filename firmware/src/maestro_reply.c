#include "maestro_reply.h"
#include <string.h>

void maestro_reply_clear(maestro_reply_t *r)
{
    r->length = r->count = 0;
    r->truncated = false;
    memset(r->lengths, 0, sizeof(r->lengths));
    memset(r->final, 0, sizeof(r->final));
    r->text[0] = 0;
    r->version++;
}

void maestro_reply_update(maestro_reply_t *r, unsigned message, const char *text, bool final)
{
    if (message >= 8 || !text || r->final[message]) return;
    while (r->count <= message) {
        if (r->count) {
            if (r->length + 2 >= r->capacity) { r->truncated = true; r->version++; return; }
            memcpy(r->text + r->length, "\n\n", 3);
            r->length += 2;
        }
        r->count++;
    }
    size_t at = 0;
    for (unsigned i = 0; i < message; i++) at += r->lengths[i] + 2;
    // A complete message replaces its deltas, including corrections of equal length.
    size_t remove = final && text[0] ? r->lengths[message] : 0;
    if (!remove) at += r->lengths[message];
    size_t add = strlen(text), room = r->capacity - 1 - r->length + remove;
    if (add > room) {
        add = room;
        while (add && ((unsigned char)text[add] & 0xc0) == 0x80) add--;
        r->truncated = true;
    }
    memmove(r->text + at + add, r->text + at + remove, r->length - at - remove + 1);
    memcpy(r->text + at, text, add);
    r->length += add - remove;
    r->lengths[message] += add - remove;
    r->final[message] = final;
    r->version++;
}
