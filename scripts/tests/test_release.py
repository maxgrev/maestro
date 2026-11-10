"""Source snapshots preserve artwork and exclude the developer's private state."""
import importlib.util
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("package_source", ROOT / "scripts/package-source.py")
source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source)


class ReleaseTests(unittest.TestCase):
    def test_source_export_preserves_artwork_and_excludes_private_data_history_and_caches(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in source.PATHS:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                if name in {"bridge", "desktop", "docs", "firmware/src", "scripts", ".github"}:
                    path.mkdir(exist_ok=True)
                else:
                    path.write_text("release source")
            for name in [".local/config.json", ".git/config", ".tools/key.pem",
                         "firmware/build/recovery.bin", "scripts/__pycache__/private.pyc"]:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("must not be exported")
            for name in ["bridge/public/characters/codex.webp", "firmware/src/avatars/codex.h"]:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("original artwork")
            (root / "scripts/helper.py").write_text("public helper")
            (root / ".github/workflow.yml").write_text("public CI")
            files = {str(path.relative_to(root)) for path in source.source_files(root)}
            self.assertIn("scripts/helper.py", files)
            self.assertIn(".github/workflow.yml", files)
            self.assertIn("LICENSE", files)
            self.assertIn("NOTICE", files)
            self.assertIn("bridge/public/characters/codex.webp", files)
            self.assertIn("firmware/src/avatars/codex.h", files)
            self.assertFalse(any("must not be exported" in (root / name).read_text() for name in files))

    def test_export_rejects_a_symlink_to_a_file_outside_the_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in source.PATHS:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                if name in {"bridge", "desktop", "docs", "firmware/src", "scripts", ".github"}:
                    path.mkdir(exist_ok=True)
                else:
                    path.write_text("release source")
            (root / "scripts/secret-link").symlink_to(ROOT / ".gitignore")
            with self.assertRaisesRegex(ValueError, "symlinks"):
                list(source.source_files(root))


if __name__ == "__main__":
    unittest.main()
