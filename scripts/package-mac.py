#!/usr/bin/env python3
"""Build a self-contained Apple Silicon app from pinned tools; include no user data."""
import hashlib
import json
import os
import plistlib
import shutil
import subprocess
import sys
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "dist/Maestro.app"
RES = APP / "Contents/Resources"
LAME_VERSION = "3.100"
LAME_SHA256 = "ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e"


def run(*args):
    subprocess.run(args, cwd=ROOT, check=True)


def download(url, name, checksum):
    dest = ROOT / ".cache" / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not dest.exists():
        partial = dest.with_suffix(".part")
        urllib.request.urlretrieve(url, partial)
        partial.rename(dest)
    if hashlib.sha256(dest.read_bytes()).hexdigest() != checksum:
        raise SystemExit("Download checksum failed: " + name)
    return dest


def copytree(src, dst):
    shutil.copytree(src, dst, dirs_exist_ok=True, symlinks=True, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store"))


def build_lame():
    # Homebrew's encoder can link to libraries outside the app. Build the
    # pinned encoder without its optional decoder so the app is relocatable.
    archive = download(
        f"https://downloads.sourceforge.net/project/lame/lame/{LAME_VERSION}/lame-{LAME_VERSION}.tar.gz",
        f"third-party/lame-{LAME_VERSION}.tar.gz", LAME_SHA256)
    source = ROOT / ".cache" / f"lame-{LAME_VERSION}"
    if not source.exists():
        with tarfile.open(archive) as tar:
            tar.extractall(ROOT / ".cache", filter="data")
    build = ROOT / ".cache" / f"lame-{LAME_VERSION}-build"
    build.mkdir(exist_ok=True)
    env = {**os.environ, "MACOSX_DEPLOYMENT_TARGET": "14.0"}
    subprocess.run([str(source / "configure"), "--disable-shared", "--enable-static",
                    "--disable-decoder", "--without-libiconv-prefix"],
                   cwd=build, env=env, check=True)
    subprocess.run(["make", "-j4"], cwd=build, env=env, check=True)
    return build / "frontend/lame"


def main():
    if os.uname().machine != "arm64" or os.uname().sysname != "Darwin":
        raise SystemExit("This package targets Apple Silicon Macs.")
    run("npm", "run", "check")
    run(sys.executable, "scripts/fetch-voices.py")
    run(sys.executable, "scripts/firmware-manifest.py")
    version = json.loads((ROOT / "package.json").read_text())["version"]
    lame = build_lame()
    node = download("https://nodejs.org/dist/v26.7.0/node-v26.7.0-darwin-arm64.tar.gz", "node-portable.tar.gz", "7ee659a7768e641bbfd5360940660b8e8fd0052f77488f365562bac522fc15d4")
    python = download("https://github.com/astral-sh/python-build-standalone/releases/download/20261009/cpython-3.13.16%2B20261009-aarch64-apple-darwin-install_only_stripped.tar.gz", "python-portable.tar.gz", "11785155d0f70e634178219c20925d8f20be00a3da4684fc4f5019dd15602ef7")
    # Only replace generated output, never the running app's data directory.
    if APP.exists(): shutil.rmtree(APP)
    RES.mkdir(parents=True)
    (APP / "Contents/MacOS").mkdir()
    tools = RES / ".tools"; tools.mkdir()
    for archive, folder, unpacked in [(node, "node", "node-v26.7.0-darwin-arm64"), (python, "python", "python")]:
        with tarfile.open(archive) as tar: tar.extractall(tools, filter="data")
        if unpacked != folder: (tools / unpacked).rename(tools / folder)
    # Keep pip and runtime wheels local to the bundle. No user Python needed.
    run(str(tools / "python/bin/python3"), "-m", "pip", "install", "--disable-pip-version-check", "-r", str(ROOT / "desktop/requirements-usb.txt"))
    run(str(tools / "python/bin/python3"), "-m", "pip", "install", "--disable-pip-version-check", "-r", str(ROOT / "desktop/requirements-speech.txt"))
    shutil.copy2(ROOT / ".tools/herdr", tools / "herdr")
    copytree(ROOT / ".tools/whisper", tools / "whisper")
    copytree(ROOT / ".tools/kokoro", tools / "kokoro")
    shutil.copy2(lame, tools / "lame")
    copytree(ROOT / "bridge/public", RES / "bridge/public")
    shutil.copy2(ROOT / "desktop/assets/AppIcon.icns", RES / "AppIcon.icns")
    (RES / "scripts").mkdir()
    for name in ["device.py", "grok-reply.py", "speech.py"]: shutil.copy2(ROOT / "scripts" / name, RES / "scripts" / name)
    for name in ["package.json", "package-lock.json"]: shutil.copy2(ROOT / name, RES / name)
    run("npm", "ci", "--omit=dev", "--ignore-scripts", "--prefix", str(RES), "--cache", str(ROOT / ".cache/npm"))
    run(str(ROOT / "node_modules/.bin/tsc"), "--noEmit", "false", "--rootDir", "bridge", "--outDir", str(RES / "bridge"))
    shutil.rmtree(RES / "bridge/test", ignore_errors=True)
    build = ROOT / "firmware/build/sdk/esp32/build-maestro"
    manifest = json.loads((build / "maestro-manifest.json").read_text())
    for name in ["maestro-manifest.json", *[f["file"] for f in manifest["files"]]]:
        path = RES / "firmware" / name; path.parent.mkdir(exist_ok=True, parents=True); shutil.copy2(build / name, path)
    notices = RES / "Notices"; notices.mkdir()
    shutil.copy2(ROOT / "LICENSE", notices / "Maestro-MIT.txt")
    shutil.copy2(ROOT / "THIRD_PARTY_NOTICES.md", notices / "THIRD_PARTY_NOTICES.md")
    shutil.copy2(ROOT / ".cache/muse-gadget-sdk/LICENSE", notices / "Muse-SDK.txt")
    shutil.copy2(ROOT / ".cache/whisper.cpp/LICENSE", notices / "whisper.txt")
    copytree(ROOT / "docs/licenses", notices / "Speech")
    shutil.copy2(ROOT / "docs/licenses/Pixel-font.txt", notices / "Pixel-font.txt")
    shutil.copy2(ROOT / "firmware/src/vendor/md4c/LICENSE.md", notices / "MD4C.txt")
    shutil.copy2(ROOT / "firmware/src/avatars/Clawd-LICENSE.txt", notices / "Clawd-LICENSE.txt")
    shutil.copy2(ROOT / "firmware/src/avatars/SOURCES.md", notices / "Character-sources.md")
    if (build / "Notices").is_dir():
        copytree(build / "Notices", notices / "Firmware")
    for label, directory in [("Muse-SDK", ROOT / ".cache/muse-gadget-sdk"),
                             ("ESP-IDF", ROOT / ".cache/esp-idf"),
                             ("components", build.parent / "managed_components")]:
        for path in directory.rglob("*"):
            if path.is_file() and path.name.upper().startswith(("LICENSE", "COPYING", "NOTICE")) and ".git" not in path.parts:
                target = notices / "Firmware" / label / path.relative_to(directory)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, target)
    run(sys.executable, "scripts/fetch-licenses.py")
    (notices / "README.txt").write_text("Maestro's own source: MIT. The existing Codex companion and native Muse artwork retain their own rights; confirm redistribution terms before publishing. See THIRD_PARTY_NOTICES.md and Character-sources.md for dependencies and art. Speech tools retain their GPL/LGPL terms; SOURCES.txt explains how to rebuild or replace them. Publish the matching Maestro source and third-party source archives beside this app. Node, Python, JavaScript and Python packages retain their own license files. Source: https://github.com/maxgrev/maestro\n")
    info = {"CFBundleIdentifier": "dev.maestro.stopwatch", "CFBundleName": "Maestro", "CFBundleExecutable": "Maestro", "CFBundleIconFile": "AppIcon", "CFBundlePackageType": "APPL", "CFBundleShortVersionString": version, "CFBundleVersion": version, "LSMinimumSystemVersion": "14.0", "NSHighResolutionCapable": True, "NSLocalNetworkUsageDescription": "Maestro connects your StopWatch to agents on this Mac.", "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True}}
    (APP / "Contents/Info.plist").write_bytes(plistlib.dumps(info))
    run("swiftc", "-parse-as-library", "-target", "arm64-apple-macos14.0", "-module-cache-path", str(ROOT / ".cache/swift"), "-O", "-framework", "AppKit", "-framework", "WebKit", str(ROOT / "desktop/Maestro.swift"), "-o", str(APP / "Contents/MacOS/Maestro"))
    # Local development signature. A public release needs Developer ID + notarization.
    run("codesign", "--force", "--deep", "--sign", "-", str(APP))
    run("codesign", "--verify", "--deep", "--strict", str(APP))
    run("ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(APP), str(ROOT / "dist/Maestro-apple-silicon.zip"))
    run(sys.executable, "scripts/package-source.py")
    print("Built " + str(APP))


if __name__ == "__main__": main()
