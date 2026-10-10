#include "maestro_markdown.h"
#include "vendor/md4c/md4c.h"
#include <stdio.h>
#include <string.h>

typedef struct {
    char *out;
    size_t used, cap;
    unsigned trailing, lists, cell;
    bool failed;
    unsigned numbers[16];
} render_t;

static int raw(render_t *r, const char *s, size_t n)
{
    if (n >= r->cap - r->used) { r->failed = true; return -1; }
    memcpy(r->out + r->used, s, n); r->used += n; r->out[r->used] = 0;
    return 0;
}
static int text(render_t *r, const char *s, size_t n)
{
    for (size_t i = 0; i < n; i++) {
        if (raw(r, s + i, 1)) return 1;
        r->trailing = s[i] == '\n' ? r->trailing + 1 : 0;
    }
    return 0;
}
static int gap(render_t *r, unsigned lines)
{
    if (!r->used) return 0;
    while (r->trailing < lines) if (text(r, "\n", 1)) return 1;
    return 0;
}
static int enter_block(MD_BLOCKTYPE type, void *detail, void *data)
{
    render_t *r = data;
    switch (type) {
    case MD_BLOCK_H: case MD_BLOCK_CODE: return gap(r, 2);
    case MD_BLOCK_QUOTE: return gap(r, 1) || text(r, "> ", 2);
    case MD_BLOCK_UL: case MD_BLOCK_OL:
        if (r->lists == 16) { r->failed = true; return -1; }
        r->numbers[r->lists++] = type == MD_BLOCK_OL ? ((MD_BLOCK_OL_DETAIL *)detail)->start : 0;
        return gap(r, 1);
    case MD_BLOCK_LI: {
        if (gap(r, 1)) return 1;
        for (unsigned i = 1; i < r->lists; i++) if (text(r, "  ", 2)) return 1;
        MD_BLOCK_LI_DETAIL *li = detail;
        if (li->is_task) return text(r, li->task_mark == ' ' ? "[ ] " : "[x] ", 4);
        unsigned *number = r->lists ? &r->numbers[r->lists-1] : NULL;
        if (number && *number) {
            char prefix[24]; int n = snprintf(prefix, sizeof(prefix), "%u. ", (*number)++);
            return text(r, prefix, n);
        }
        return text(r, "- ", 2);
    }
    case MD_BLOCK_HR: return gap(r, 2) || text(r, "--------\n", 9);
    case MD_BLOCK_TR: r->cell = 0; return gap(r, 1);
    case MD_BLOCK_TH: case MD_BLOCK_TD:
        return r->cell++ ? text(r, " | ", 3) : 0;
    default: return 0;
    }
}
static int leave_block(MD_BLOCKTYPE type, void *detail, void *data)
{
    (void)detail; render_t *r = data;
    switch (type) {
    case MD_BLOCK_H: case MD_BLOCK_CODE: return gap(r, 2);
    case MD_BLOCK_UL: case MD_BLOCK_OL: if (r->lists) --r->lists; return gap(r, 2);
    case MD_BLOCK_P: return gap(r, r->lists ? 1 : 2);
    case MD_BLOCK_QUOTE: case MD_BLOCK_TABLE: return gap(r, 2);
    case MD_BLOCK_LI: case MD_BLOCK_TR: return gap(r, 1);
    default: return 0;
    }
}
static int enter_span(MD_SPANTYPE type, void *detail, void *data)
{
    (void)detail; render_t *r = data;
    if (type == MD_SPAN_IMG) return text(r, "[", 1);
    return 0;
}
static int leave_span(MD_SPANTYPE type, void *detail, void *data)
{
    render_t *r = data;
    if (type == MD_SPAN_IMG) return text(r, "]", 1);
    if (type == MD_SPAN_A) {
        MD_SPAN_A_DETAIL *a = detail;
        return text(r, " (", 2) || text(r, a->href.text, a->href.size) || text(r, ")", 1);
    }
    return 0;
}
static int content(MD_TEXTTYPE type, const MD_CHAR *s, MD_SIZE size, void *data)
{
    render_t *r = data;
    if (type == MD_TEXT_BR) return text(r, "\n", 1);
    if (type == MD_TEXT_SOFTBR) return text(r, " ", 1);
    if (type == MD_TEXT_NULLCHAR) return text(r, "?", 1);
    if (type == MD_TEXT_ENTITY) {
        const char *entities[] = {"&amp;", "&lt;", "&gt;", "&quot;", "&apos;", "&nbsp;"};
        const char *values[] = {"&", "<", ">", "\"", "'", " "};
        for (unsigned i = 0; i < 6; i++) if (strlen(entities[i]) == size && !memcmp(s, entities[i], size))
            return text(r, values[i], 1);
    }
    return text(r, s, size);
}
bool maestro_markdown(const char *source, char *output, size_t capacity)
{
    if (!capacity) return false;
    render_t r = {.out = output, .cap = capacity}; output[0] = 0;
    MD_PARSER parser = {.flags = MD_FLAG_TABLES | MD_FLAG_TASKLISTS | MD_FLAG_STRIKETHROUGH | MD_FLAG_NOHTML,
        .enter_block = enter_block, .leave_block = leave_block, .enter_span = enter_span,
        .leave_span = leave_span, .text = content};
    if (md_parse(source, strlen(source), &parser, &r) || r.failed) return false;
    while (r.used && output[r.used-1] == '\n') output[--r.used] = 0;
    return true;
}
