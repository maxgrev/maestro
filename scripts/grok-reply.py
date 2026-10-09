#!/usr/bin/env python3
"""Return a Grok routine result to Maestro, locally or through a fixed HTTPS URL."""
import argparse
import base64
import binascii
import json
import os
import sys
import uuid
from pathlib import Path
from urllib.request import Request, build_opener, HTTPRedirectHandler, ProxyHandler
from urllib.error import HTTPError, URLError

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("request_id", type=uuid.UUID)
source = parser.add_mutually_exclusive_group(required=True)
source.add_argument("--file", type=Path, help="UTF-8 file containing the final answer")
source.add_argument("--text-base64", help="Base64-encoded UTF-8 answer, safe to pass as one shell argument")
parser.add_argument("--local", action="store_true", help="Use this Mac's private configuration and loopback callback")
parser.add_argument("--needs-attention", action="store_true")
args = parser.parse_args()
try:
    if args.text_base64 is not None:
        if len(args.text_base64) > 86000:
            sys.exit("Encoded reply is too long.")
        text = base64.b64decode(args.text_base64, validate=True).decode("utf-8").strip()
    else:
        text = args.file.read_text(encoding="utf-8").strip()
except (binascii.Error, UnicodeError, OSError):
    sys.exit("The answer must be a UTF-8 file or valid base64-encoded UTF-8 text.")
if not text or len(text) > 16000:
    sys.exit("Reply must contain 1–16000 characters.")
if args.local:
    # Fixed destination and config path: no credential or URL is passed through Bot chat.
    config_file = Path(os.environ.get("MAESTRO_DATA", Path(__file__).resolve().parent.parent / ".local")) / "config.json"
    try:
        config = json.loads(config_file.read_text())
        port = config["localPort"]
        key = config["grok"]["replyKey"]
        if type(port) is not int or not 1024 <= port <= 65535 or not isinstance(key, str) or len(key) < 32:
            raise ValueError
    except (OSError, KeyError, ValueError, TypeError):
        sys.exit("Configure Grok Bot in this Mac's .local/config.json first.")
    url = f"http://127.0.0.1:{port}/api/grok/reply"
else:
    url = os.environ.get("MAESTRO_REPLY_URL", "")
    key = os.environ.get("MAESTRO_REPLY_KEY", "")
    if not url.startswith("https://") or not key:
        sys.exit("Set MAESTRO_REPLY_URL to the fixed HTTPS callback and MAESTRO_REPLY_KEY to its secret.")
body = json.dumps({"request_id": str(args.request_id), "text": text, "needs_attention": args.needs_attention}).encode()
request = Request(url, data=body, method="POST", headers={
    "Authorization": "Bearer " + key, "Content-Type": "application/json",
})
class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


try:
    handlers = [NoRedirect()]
    if args.local:
        handlers.append(ProxyHandler({}))  # Never send the loopback credential through an HTTP proxy.
    with build_opener(*handlers).open(request, timeout=20) as response:
        if response.status != 200:
            sys.exit("The bridge did not accept this reply.")
except HTTPError as error:
    sys.exit(f"Reply rejected (HTTP {error.code}). Check configuration; do not change the request ID.")
except URLError:
    sys.exit("Delivery unclear. Retry this same reply with the same request ID; the bridge deduplicates it.")
print("Reply delivered.")
