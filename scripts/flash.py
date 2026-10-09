#!/usr/bin/env python3
"""Back up and flash a StopWatch, or restore its saved image. Never writes eFuses."""
import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("port", help="For example /dev/cu.usbmodem101")
parser.add_argument("--restore", action="store_true", help="Restore the original full flash backup")
args = parser.parse_args()
os.umask(0o077)
backups = ROOT / ".local/backups"
backups.mkdir(parents=True, exist_ok=True)
image = backups / "stopwatch-original.bin"
digest = backups / "stopwatch-original.sha256"
tool = [str(ROOT / ".tools/python/bin/python"), "-m", "esptool", "--chip", "esp32s3", "--port", args.port, "--baud", "460800"]

if not image.exists():
    if args.restore:
        sys.exit("No original flash backup exists.")
    # Read before any write; keep partial reads separate from the recovery image.
    partial = image.with_suffix(".partial")
    subprocess.run(tool + ["read-flash", "0", "0x1000000", str(partial)], check=True)
    if partial.stat().st_size != 16 * 1024 * 1024:
        sys.exit("Incomplete backup; firmware was not written.")
    partial.rename(image)
    digest.write_text(hashlib.sha256(image.read_bytes()).hexdigest() + "  .local/backups/stopwatch-original.bin\n")
if not digest.exists() or hashlib.sha256(image.read_bytes()).hexdigest() != digest.read_text().split()[0]:
    sys.exit("Backup checksum is missing or wrong; firmware was not written.")
if args.restore:
    subprocess.run(tool + ["write-flash", "0", str(image)], check=True)
else:
    build = ROOT / "firmware/build/sdk/esp32/build-maestro"
    settings = (build / "sdkconfig").read_text()
    for name in ("SECURE_BOOT", "SECURE_FLASH_ENC_ENABLED", "HOMEHUB_NVS_ENCRYPTION", "HOMEHUB_PAIRING_EFUSE_AUTH"):
        if f"CONFIG_{name}=y" in settings:
            sys.exit(f"This recovery-oriented flasher does not accept CONFIG_{name}=y.")
    # Use IDF's generated addresses instead of maintaining a second partition map.
    manifest = json.loads((build / "flasher_args.json").read_text())
    files = [part for address, filename in manifest["flash_files"].items() for part in (address, str(build / filename))]
    subprocess.run(tool + ["write-flash", *manifest["write_flash_args"], *files], check=True)
