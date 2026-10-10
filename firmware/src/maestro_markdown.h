#pragma once
#include <stdbool.h>
#include <stddef.h>
// Readable Markdown in the watch's fixed bitmap font; no HTML or label commands.
// Returns false on a size/depth limit; the caller then shows the original text.
bool maestro_markdown(const char *source, char *output, size_t capacity);
