#!/usr/bin/env python3
"""Seal the generic firmware files used by the guided installer."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent
build = root / "firmware/build/sdk/esp32/build-maestro"
settings = (build / "sdkconfig").read_text()
for flag in ("SECURE_BOOT", "SECURE_FLASH_ENC_ENABLED", "HOMEHUB_NVS_ENCRYPTION", "HOMEHUB_PAIRING_EFUSE_AUTH"):
    if f"CONFIG_{flag}=y" in settings:
        raise SystemExit("Unsafe firmware setting: " + flag)
if 'CONFIG_GADGET_SDK_TOKEN=""' not in settings:
    raise SystemExit("Refusing to distribute a build with a private Muse token")
manifest = json.loads((build / "flasher_args.json").read_text())
files = [{"address": address, "file": filename, "sha256": hashlib.sha256((build / filename).read_bytes()).hexdigest()}
         for address, filename in manifest["flash_files"].items()]
(build / "maestro-manifest.json").write_text(json.dumps({"board": "m5stack-stopwatch", "version": 2, "generic": True,
                                                        "args": manifest["write_flash_args"], "files": files}, indent=2))
print("Generic firmware manifest saved.")
