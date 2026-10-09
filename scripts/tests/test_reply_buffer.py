"""Exercise the firmware's reply store with real streaming failure cases."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class ReplyBufferTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("cc"), "Requires a host C compiler")
    def test_streamed_and_complete_replies(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "reply-buffer"
            subprocess.run([
                "cc", "-std=c11", "-g", "-fsanitize=address,undefined",
                "-I", str(ROOT / "firmware/src"),
                str(ROOT / "firmware/src/maestro_reply.c"),
                str(ROOT / "scripts/tests/reply_buffer.c"), "-o", str(executable),
            ], check=True, capture_output=True, text=True)
            result = subprocess.run([str(executable)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
