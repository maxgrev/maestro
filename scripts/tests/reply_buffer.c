#include "maestro_reply.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

int main(void)
{
    char storage[64001];
    maestro_reply_t r = {.text = storage, .capacity = sizeof(storage)};
    maestro_reply_clear(&r);
    maestro_reply_update(&r, 0, "First par", false);
    maestro_reply_update(&r, 1, "Second message", false);
    maestro_reply_update(&r, 0, "agraph", false);
    assert(!strcmp(r.text, "First paragraph\n\nSecond message"));
    maestro_reply_update(&r, 0, "FIRST paragraph", true); // Equal-length correction.
    maestro_reply_update(&r, 1, "", true); // Done without a full-text payload.
    assert(!strcmp(r.text, "FIRST paragraph\n\nSecond message"));
    maestro_reply_update(&r, 0, "duplicate", false);
    maestro_reply_update(&r, 0, "duplicate final", true);
    assert(!strcmp(r.text, "FIRST paragraph\n\nSecond message"));

    maestro_reply_clear(&r);
    maestro_reply_update(&r, 2, "third", true);
    maestro_reply_update(&r, 0, "first", true);
    maestro_reply_update(&r, 1, "middle", true);
    assert(!strcmp(r.text, "first\n\nmiddle\n\nthird"));
    assert(r.length == strlen(r.text));

    // The old native Muse buffer held only 1023 bytes. Keep a long multi-part
    // reply and its final line, without stealing space from another message.
    char long_text[18001]; memset(long_text, 'a', 18000); long_text[18000] = 0;
    maestro_reply_clear(&r);
    maestro_reply_update(&r, 0, long_text, true);
    maestro_reply_update(&r, 1, long_text, true);
    maestro_reply_update(&r, 2, long_text, true);
    maestro_reply_update(&r, 3, "Last line: caf\xc3\xa9.", true);
    assert(r.length > 54000 && !r.truncated);
    assert(!strcmp(r.text + 54006, "Last line: caf\xc3\xa9."));

    // Bounds and UTF-8: room for part of an emoji must never split it.
    struct { char before[8], text[14], after[8]; } guarded;
    memset(&guarded, 0xa5, sizeof(guarded));
    r = (maestro_reply_t){.text = guarded.text, .capacity = sizeof(guarded.text)};
    maestro_reply_clear(&r);
    maestro_reply_update(&r, 0, "12345678901\xf0\x9f\x98\x80!", true);
    assert(!strcmp(r.text, "12345678901") && r.truncated);
    for (unsigned i = 0; i < 8; i++) {
        assert((unsigned char)guarded.before[i] == 0xa5);
        assert((unsigned char)guarded.after[i] == 0xa5);
    }
    maestro_reply_clear(&r);
    assert(!r.text[0] && !r.length && !r.truncated);
    maestro_reply_update(&r, 0, "old content", false);
    maestro_reply_update(&r, 0, "new", true);
    assert(!strcmp(r.text, "new"));
    puts("Reply ordering, corrections, long text, UTF-8, duplicates and bounds passed");
}
