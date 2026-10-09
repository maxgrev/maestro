#!/usr/bin/env python3
"""Fetch the pinned, offline Kokoro model; no user data leaves the Mac."""
import hashlib
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = [
    ("kokoro-v1.0.int8.onnx", "model.onnx", "6e742170d309016e5891a994e1ce1559c702a2ccd0075e67ef7157974f6406cb"),
    ("voices-v1.0.bin", "voices.bin", "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d"),
]


def checksum(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def main():
    directory = ROOT / ".tools/kokoro"
    directory.mkdir(exist_ok=True, parents=True)
    for source, name, sha in FILES:
        dest = directory / name
        if not dest.exists():
            part = dest.with_suffix(".part")
            urllib.request.urlretrieve("https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/" + source, part)
            if checksum(part) != sha:
                raise SystemExit("Voice download checksum failed: " + source)
            part.rename(dest)
        if checksum(dest) != sha:
            raise SystemExit("Voice checksum failed: " + name)


if __name__ == "__main__":
    main()
