"""Exercise the local reply helper's network and credential boundary."""
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer


class LocalReplyTests(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.status = 200
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                owner.requests.append((self.path, self.headers.get("Authorization"),
                                       json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
                self.send_response(owner.status)
                if owner.status == 307:
                    self.send_header("Location", "/should-never-receive-the-key")
                self.end_headers()

            def log_message(self, *_args):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        (root / "scripts").mkdir()
        (root / ".local").mkdir()
        self.script = root / "scripts/grok-reply.py"
        shutil.copy2(Path(__file__).resolve().parents[1] / "grok-reply.py", self.script)
        (root / ".local/config.json").write_text(json.dumps({
            "localPort": self.server.server_port, "grok": {"replyKey": "test-key-" * 8},
        }))

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def run_helper(self, encoded, request_id="e1d4720a-6ca8-4c8c-a73a-e1a2f9c30b22", flags=()):
        return subprocess.run([sys.executable, str(self.script), request_id, "--local", "--text-base64", encoded, *flags],
                              env={**os.environ, "HTTP_PROXY": "http://127.0.0.1:1", "NO_PROXY": ""},
                              capture_output=True, text=True, timeout=5)

    def test_local_reply_uses_fixed_destination_and_keeps_key_out_of_output(self):
        text = "Hello, 世界. $(this stays text)"
        result = self.run_helper(base64.b64encode(text.encode()).decode())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.requests), 1)
        path, authorization, body = self.requests[0]
        self.assertEqual(path, "/api/grok/reply")
        self.assertEqual(authorization, "Bearer " + "test-key-" * 8)
        self.assertEqual(body["text"], text)
        self.assertNotIn("test-key-", result.stdout + result.stderr)

    def test_external_receipt_uses_the_inbox_route_with_the_same_credential(self):
        result = self.run_helper("RXh0ZXJuYWwgcmVwbHk=", flags=("--notify", "--needs-attention"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.requests[0][0], "/api/grok/inbox")
        self.assertEqual(self.requests[0][2]["text"], "External reply")
        self.assertTrue(self.requests[0][2]["needs_attention"])
        self.assertNotIn("test-key-", result.stdout + result.stderr)

    def test_invalid_payload_never_reaches_the_bridge(self):
        for encoded, request_id in [("not base64!", "e1d4720a-6ca8-4c8c-a73a-e1a2f9c30b22"),
                                    ("aGVsbG8=", "not-a-uuid")]:
            self.assertNotEqual(self.run_helper(encoded, request_id).returncode, 0)
        self.assertEqual(self.requests, [])

    def test_redirect_does_not_forward_the_key_to_another_route(self):
        self.status = 307
        result = self.run_helper("aGVsbG8=")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(self.requests), 1)
        self.assertIn("HTTP 307", result.stderr)


if __name__ == "__main__":
    unittest.main()
