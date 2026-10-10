"""Exercise the watch's real Markdown parser with bounded buffers."""
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class MarkdownTests(unittest.TestCase):
    def test_readable_content_and_overflow(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            (work / "test.c").write_text(r'''
#include "maestro_markdown.h"
#include <assert.h>
#include <string.h>
int main(void) {
    char out[2048];
    assert(maestro_markdown("# Result\n\n**Done** and _ready_.\n\n- One\n- Two\n\n3. Third\n4. Fourth\n\n```c\n#define N 3\n```\n\n[Docs](https://example.com/#part)\n\n&amp;", out, sizeof(out)));
    assert(strstr(out, "Result\n\nDone and ready."));
    assert(strstr(out, "- One\n- Two"));
    assert(strstr(out, "3. Third\n4. Fourth"));
    assert(strstr(out, "#define N 3"));
    assert(strstr(out, "Docs (https://example.com/#part)"));
    assert(strstr(out, "&"));
    assert(maestro_markdown("- [x] done\n- [ ] todo\n\n![portrait](https://example.com/image)\n\n<script>unsafe</script>\n\n`#ff0000 literal#`", out, sizeof(out)));
    assert(strstr(out, "[x] done\n[ ] todo"));
    assert(strstr(out, "[portrait]"));
    assert(!strstr(out, "/image"));
    assert(strstr(out, "<script>unsafe</script>"));
    assert(strstr(out, "#ff0000 literal#"));
    assert(maestro_markdown("Hello 世界", out, sizeof(out)));
    assert(!strcmp(out, "Hello 世界"));
    char tiny[4];
    assert(!maestro_markdown("Long answer", tiny, sizeof(tiny)));
    assert(tiny[3] == 0);
    assert(!maestro_markdown("x", tiny, 0));
    return 0;
}
''')
            binary = work / "test"
            subprocess.run(["cc", "-std=c11", "-g", "-fsanitize=address,undefined",
                            "-I", str(ROOT / "firmware/src"), str(work / "test.c"),
                            str(ROOT / "firmware/src/maestro_markdown.c"),
                            str(ROOT / "firmware/src/vendor/md4c/md4c.c"), "-o", str(binary)], check=True)
            subprocess.run([str(binary)], check=True)
