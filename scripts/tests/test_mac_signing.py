"""A Mac signature must not depend on disposable Python cache files."""
import importlib.util
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("prepare_mac_signing", Path(__file__).resolve().parents[1] / "prepare-mac-signing.py")
signing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(signing)


class SigningTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.app = self.root / "Maestro.app"
        self.python = self.app / "Contents/Resources/.tools/python"
        self.python.mkdir(parents=True)
        (self.app / "Contents/Info.plist").write_bytes(plistlib.dumps({
            "CFBundleExecutable": "Maestro", "CFBundleIdentifier": "dev.maestro.signing-test",
            "CFBundlePackageType": "APPL",
        }))
        (self.python / "helper.py").write_text("print('ready')\n")
        (self.python / "__pycache__").mkdir()
        self.cache = self.python / "__pycache__/helper.cpython-313.pyc"
        self.cache.write_bytes(b"disposable cache")

    def test_preparation_preserves_source_and_external_data(self):
        private = self.root / "private"
        private.mkdir()
        (private / "saved.pyc").write_bytes(b"private data")
        (self.python / "external").symlink_to(private, target_is_directory=True)
        (self.python / "compiled_only.pyc").write_bytes(b"runtime module without source")
        self.assertEqual(signing.prepare(self.app), 1)
        self.assertEqual((self.python / "helper.py").read_text(), "print('ready')\n")
        self.assertEqual((private / "saved.pyc").read_bytes(), b"private data")
        self.assertEqual((self.python / "compiled_only.pyc").read_bytes(), b"runtime module without source")
        self.assertFalse((self.python / "__pycache__").exists())
        self.assertEqual(signing.prepare(self.app), 0)

    def test_runtime_symlink_is_rejected_before_deletion(self):
        moved = self.root / "python-outside-app"
        self.python.rename(moved)
        self.python.symlink_to(moved, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlink"):
            signing.prepare(self.app)
        self.assertEqual((moved / "__pycache__/helper.cpython-313.pyc").read_bytes(), b"disposable cache")

    @unittest.skipUnless(sys.platform == "darwin" and shutil.which("codesign"), "Requires macOS codesign")
    def test_real_signature_survives_cache_cleanup_after_preparation(self):
        executable = self.app / "Contents/MacOS/Maestro"
        executable.parent.mkdir()
        shutil.copyfile("/usr/bin/true", executable)
        executable.chmod(0o755)

        def sign():
            subprocess.run(["codesign", "--force", "--sign", "-", str(self.app)], check=True, capture_output=True)

        def verify():
            return subprocess.run(["codesign", "--verify", "--deep", "--strict", str(self.app)], capture_output=True)

        sign()
        self.assertEqual(verify().returncode, 0)
        self.cache.unlink()
        self.assertNotEqual(verify().returncode, 0, "The unprepared signature should fail when a sealed cache is deleted")
        self.cache.write_bytes(b"disposable cache")
        signing.prepare(self.app)
        sign()
        shutil.rmtree(self.python / "__pycache__", ignore_errors=True)
        self.assertEqual(verify().returncode, 0, "Signing without disposable caches must survive cache cleanup")


if __name__ == "__main__":
    unittest.main()
