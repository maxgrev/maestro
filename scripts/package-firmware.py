#!/usr/bin/env python3
"""Package only the verified generic firmware files used by the USB installer."""
import json
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    subprocess.run([sys.executable, str(ROOT / "scripts/firmware-manifest.py")], check=True)
    build = ROOT / "firmware/build/sdk/esp32/build-maestro"
    manifest = json.loads((build / "maestro-manifest.json").read_text())
    version = json.loads((ROOT / "package.json").read_text())["version"]
    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    archive = dist / f"Maestro-{version}-firmware.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as out:
        for name in ["maestro-manifest.json", "sdkconfig", "flasher_args.json", *[item["file"] for item in manifest["files"]]]:
            out.write(build / name, name)
        out.write(ROOT / "LICENSE", "LICENSE")
        out.write(ROOT / "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md")
        for name in ["firmware/src/vendor/md4c/LICENSE.md", "firmware/src/avatars/Clawd-LICENSE.txt", "docs/licenses/Pixel-font.txt"]:
            out.write(ROOT / name, "Notices/" + name)
        for label, directory in [("Muse-SDK", ROOT / ".cache/muse-gadget-sdk"),
                                 ("ESP-IDF", ROOT / ".cache/esp-idf"),
                                 ("components", build.parent / "managed_components")]:
            for path in sorted(directory.rglob("*")):
                if path.is_file() and path.name.upper().startswith(("LICENSE", "COPYING", "NOTICE")) and ".git" not in path.parts:
                    out.write(path, str(Path("Notices") / label / path.relative_to(directory)))
    print(f"Packaged StopWatch firmware: {archive}")


if __name__ == "__main__":
    main()
