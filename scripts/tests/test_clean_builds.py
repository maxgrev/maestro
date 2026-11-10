"""Cleanup must preserve private data, runnable tools, and USB firmware."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("clean_builds", Path(__file__).resolve().parents[1] / "clean-builds.py")
cleaner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleaner)


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.put("package.json", "source")
        for name in [".local/config.json", ".local/maestro.sqlite", ".local/backups/watch/original.bin",
                     ".local/agents/bin/claude", "dist/Maestro.app/Contents/MacOS/Maestro",
                     ".tools/python/bin/python", ".tools/herdr", ".tools/kokoro/model.onnx",
                     "node_modules/tsx/package.json", ".git/config", "firmware/src/maestro.c"]:
            self.put(name, "keep")
        self.put(".local/config.json", json.dumps({"speech": {}}))
        self.put(".tools/espressif/tools/compiler", "compiler")
        self.put(".cache/esp-idf/components/example/LICENSE", "SDK license")
        self.put(cleaner.SDK / "managed_components/example/COPYING", "component license")
        self.put(cleaner.SDK / "components/muse/muse_ui.c", "prepared source")
        self.put(cleaner.BUILD / "esp-idf/example.o", "object code")
        self.put(cleaner.BUILD / "bootloader/bootloader.bin", "bootloader")
        self.put(cleaner.BUILD / "muse-gadget.bin", "firmware")
        self.put(cleaner.BUILD / "sdkconfig", "generic config")
        self.put(cleaner.BUILD / "flasher_args.json", "flash args")
        self.put(cleaner.BUILD / "maestro-manifest.json", json.dumps({
            "board": "m5stack-stopwatch", "generic": True,
            "files": [{"file": name, "sha256": hashlib.sha256(data.encode()).hexdigest()}
                      for name, data in [("muse-gadget.bin", "firmware"), ("bootloader/bootloader.bin", "bootloader")]],
        }))
        self.put("dist/Maestro-apple-silicon.zip", "release ZIP")
        self.put("dist/Maestro-0.2.0-source.tar.gz", "source archive")
        self.put("dist/SHA256SUMS", "abc  Maestro-apple-silicon.zip\ndef  Maestro-0.2.0-source.tar.gz\n\n")

    def put(self, name, data):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(data)
        return path

    def snapshot(self):
        return {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}

    def clean(self, apply=True):
        with contextlib.redirect_stdout(io.StringIO()):
            return cleaner.clean(self.root, apply)

    def test_preview_changes_nothing(self):
        before = self.snapshot()
        self.assertGreater(self.clean(apply=False), 0)
        self.assertEqual(before, self.snapshot())

    def test_apply_keeps_data_app_runtime_images_and_notices_and_can_repeat(self):
        before = self.snapshot()
        self.assertGreater(self.clean(), 0)
        after = self.snapshot()
        for name, data in before.items():
            if name == "dist/SHA256SUMS" or any(Path(name).is_relative_to(p) for p in cleaner.REMOVABLE):
                continue
            self.assertEqual(after[name], data, name)
        self.assertFalse((self.root / ".tools/espressif").exists())
        self.assertFalse((self.root / cleaner.BUILD / "esp-idf").exists())
        self.assertEqual((self.root / cleaner.BUILD / "Notices/ESP-IDF/components/example/LICENSE").read_text(), "SDK license")
        self.assertEqual((self.root / cleaner.BUILD / "Notices/components/example/COPYING").read_text(), "component license")
        self.assertEqual(after["dist/SHA256SUMS"], b"def  Maestro-0.2.0-source.tar.gz\n\n")
        self.assertEqual(self.clean(), 0)
        self.assertEqual(after, self.snapshot())

    def test_bad_firmware_blocks_all_deletion(self):
        self.put(cleaner.BUILD / "muse-gadget.bin", "corrupt")
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "checksum"):
            self.clean()
        self.assertEqual(before, self.snapshot())

    def test_symlink_target_and_parent_are_rejected_before_deletion(self):
        for name in [".cache/whisper-build", ".cache/lame-3.100-build"]:
            path = self.root / name
            path.symlink_to(self.root / ".local", target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "symlink"):
                self.clean()
            path.unlink()
        (self.root / ".tools/espressif/tools/compiler").unlink()
        (self.root / ".tools/espressif/tools").rmdir()
        (self.root / ".tools/espressif").rmdir()
        tools = self.root / ".tools"
        tools.rename(self.root / "saved-tools")
        tools.symlink_to(self.root / "saved-tools", target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.clean()
        self.assertEqual((self.root / ".local/maestro.sqlite").read_text(), "keep")
        self.assertTrue((self.root / ".cache/esp-idf").exists())

    def test_notice_conflict_blocks_all_deletion(self):
        self.put(cleaner.BUILD / "Notices/ESP-IDF/components/example/LICENSE", "other license")
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "notice differs"):
            self.clean()
        self.assertEqual(before, self.snapshot())

    def test_manifest_cannot_name_a_removed_file_or_escape_the_build(self):
        manifest_path = self.root / cleaner.BUILD / "maestro-manifest.json"
        manifest = json.loads(manifest_path.read_text())
        for name in ["../private.bin", "esp-idf/example.o"]:
            manifest["files"] = [{"file": name, "sha256": hashlib.sha256(b"object code").hexdigest()}]
            manifest_path.write_text(json.dumps(manifest))
            before = self.snapshot()
            with self.assertRaises(ValueError):
                self.clean()
            self.assertEqual(before, self.snapshot())

    def test_checkout_without_firmware_can_remove_caches(self):
        import shutil
        shutil.rmtree(self.root / "firmware/build")
        self.clean()
        self.assertFalse((self.root / "firmware/build").exists())
        self.assertEqual((self.root / ".local/maestro.sqlite").read_text(), "keep")

    def test_custom_data_blocks_cleanup(self):
        before = self.snapshot()
        with patch.dict(os.environ, {"MAESTRO_DATA": str(self.root / ".cache/esp-idf/private")}):
            with self.assertRaisesRegex(ValueError, "configured data"):
                self.clean()
        self.assertEqual(before, self.snapshot())

    def test_configured_runtime_dependency_blocks_cleanup(self):
        self.put(".local/config.json", json.dumps({"speech": {
            "lame": str(self.root / ".cache/lame-3.100-build/frontend/lame"),
        }}))
        self.put(".cache/lame-3.100-build/frontend/lame", "encoder in use")
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "runtime dependency"):
            self.clean()
        self.assertEqual(before, self.snapshot())

    def test_default_data_symlink_is_protected_with_another_active_data_folder(self):
        target = self.root / ".cache/esp-idf/private"
        (self.root / ".local").rename(target)
        (self.root / ".local").symlink_to(target, target_is_directory=True)
        before = self.snapshot()
        with patch.dict(os.environ, {"MAESTRO_DATA": str(self.root / "other-data")}):
            with self.assertRaisesRegex(ValueError, "configured data"):
                self.clean()
        self.assertEqual(before, self.snapshot())


if __name__ == "__main__":
    unittest.main()
