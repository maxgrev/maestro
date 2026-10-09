"""Run the real C renderers and SDK damage tracker against a memory display.

Build firmware first. This catches stale pixels that a fresh USB snapshot hides.
Only the allocator and LVGL display calls are replaced for this host-side check.
"""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SDK = ROOT / "firmware/build/sdk/esp32"
MUSE = SDK / "components/muse"


class CharacterTests(unittest.TestCase):
    @unittest.skipUnless((MUSE / "muse_ui.c").exists() and shutil.which("cc"),
                         "Requires a prepared firmware SDK and host C compiler")
    def test_animation_damage_matches_fresh_frames(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            for name in ["muse_pixel.h", "muse_state.h"]:
                shutil.copy2(MUSE / name, work / name)
            shutil.copy2(ROOT / "firmware/src/maestro_avatar.c", work / "maestro_avatar.c")
            (work / "maestro.h").write_text("int maestro_character(void);\n")
            (work / "muse_mem.h").write_text(
                "#include <stdlib.h>\n#define MUSE_BIG_CAPS 0\n"
                "#define heap_caps_calloc(n, size, caps) calloc(n, size)\n")
            ui = (MUSE / "muse_ui.c").read_text()
            damage = ui[ui.index("static int32_t cell_px("):ui.index("static lv_obj_t *make_label(")]
            (work / "damage.c").write_text(damage)
            executable = work / "characters"
            subprocess.run([
                "cc", "-std=c11", "-O1", "-g", "-fsanitize=address,undefined",
                "-I", str(work), "-I", str(ROOT / "firmware/src"),
                str(ROOT / "scripts/tests/character_render.c"),
                str(work / "maestro_avatar.c"), str(SDK / "avatar/muse_pixel.c"),
                "-lm", "-o", str(executable),
            ], check=True, capture_output=True, text=True)
            result = subprocess.run([str(executable)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
