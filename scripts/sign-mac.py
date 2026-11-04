#!/usr/bin/env python3
"""Sign, notarize, and verify a built Maestro app before publishing its ZIP."""
import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "dist/Maestro.app"
MACHO = {bytes.fromhex(magic) for magic in ["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]}


def run(*args):
    subprocess.run(args, cwd=ROOT, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--identity", required=True, help="Developer ID Application certificate name")
    parser.add_argument("--notary-profile", required=True, help="Existing notarytool keychain profile")
    args = parser.parse_args()
    if not args.identity.startswith("Developer ID Application:"):
        parser.error("Use a Developer ID Application identity for a public download.")
    if not APP.is_dir():
        parser.error("Build the app with npm run app:build first.")
    for path in sorted(APP.rglob("*"), key=lambda p: len(p.parts), reverse=True):
        if path.is_symlink() or not path.is_file():
            continue
        with path.open("rb") as file:
            if file.read(4) not in MACHO:
                continue
        entitlements = [] if path.suffix in {".so", ".dylib"} else ["--entitlements", str(ROOT / "desktop/entitlements.plist")]
        run("codesign", "--force", "--timestamp", "--options", "runtime", "--sign", args.identity, *entitlements, str(path))
    run("codesign", "--force", "--timestamp", "--options", "runtime", "--sign", args.identity, str(APP))
    run("codesign", "--verify", "--deep", "--strict", str(APP))
    with tempfile.TemporaryDirectory(prefix="maestro-notary-", dir=ROOT / ".cache") as directory:
        archive = Path(directory) / "Maestro.zip"
        run("ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(APP), str(archive))
        run("xcrun", "notarytool", "submit", str(archive), "--keychain-profile", args.notary_profile, "--wait")
        run("xcrun", "stapler", "staple", str(APP))
        run("xcrun", "stapler", "validate", str(APP))
        run("spctl", "--assess", "--type", "execute", "--verbose", str(APP))
        run("ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(APP), str(archive))
        archive.replace(ROOT / "dist/Maestro-apple-silicon.zip")
    run(sys.executable, "scripts/package-source.py")
    print("Developer ID signature, notarization, staple, and Gatekeeper checks passed.")


if __name__ == "__main__":
    main()
