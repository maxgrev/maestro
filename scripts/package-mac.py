#!/usr/bin/env python3
"""Build a self-contained Apple Silicon app from pinned tools; include no user data."""
import hashlib
import json
import os
import plistlib
import shutil
import subprocess
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "dist/Maestro.app"
RES = APP / "Contents/Resources"


def run(*args):
    subprocess.run(args, cwd=ROOT, check=True)


def download(url, name, checksum):
    dest = ROOT / ".cache" / name
    if not dest.exists():
        partial = dest.with_suffix(".part")
        urllib.request.urlretrieve(url, partial)
        partial.rename(dest)
    if hashlib.sha256(dest.read_bytes()).hexdigest() != checksum:
        raise SystemExit("Download checksum failed: " + name)
    return dest


def copytree(src, dst):
    shutil.copytree(src, dst, dirs_exist_ok=True, symlinks=True, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store"))


def main():
    if os.uname().machine != "arm64" or os.uname().sysname != "Darwin":
        raise SystemExit("This package targets Apple Silicon Macs.")
    run("npm", "run", "check")
    run("python3", "scripts/firmware-manifest.py")
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
    shutil.copy2(ROOT / ".tools/herdr", tools / "herdr")
    copytree(ROOT / ".tools/whisper", tools / "whisper")
    shutil.copy2("/opt/homebrew/opt/lame/bin/lame", tools / "lame")
    copytree(ROOT / "bridge/public", RES / "bridge/public")
    (RES / "scripts").mkdir()
    for name in ["device.py", "grok-reply.py"]: shutil.copy2(ROOT / "scripts" / name, RES / "scripts" / name)
    for name in ["package.json", "package-lock.json"]: shutil.copy2(ROOT / name, RES / name)
    run("npm", "ci", "--omit=dev", "--ignore-scripts", "--prefix", str(RES), "--cache", str(ROOT / ".cache/npm"))
    run(str(ROOT / "node_modules/.bin/tsc"), "--noEmit", "false", "--rootDir", "bridge", "--outDir", str(RES / "bridge"))
    shutil.rmtree(RES / "bridge/test", ignore_errors=True)
    build = ROOT / "firmware/build/sdk/esp32/build-maestro"
    manifest = json.loads((build / "maestro-manifest.json").read_text())
    for name in ["maestro-manifest.json", *[f["file"] for f in manifest["files"]]]:
        path = RES / "firmware" / name; path.parent.mkdir(exist_ok=True, parents=True); shutil.copy2(build / name, path)
    notices = RES / "Notices"; notices.mkdir()
    shutil.copy2(ROOT / ".cache/muse-gadget-sdk/LICENSE", notices / "Muse-SDK.txt")
    shutil.copy2(ROOT / ".cache/whisper.cpp/LICENSE", notices / "whisper.txt")
    for file in Path('/opt/homebrew/opt/lame').glob('COPYING*'): shutil.copy2(file, notices / ("LAME-" + file.name))
    (notices / "README.txt").write_text("Maestro includes Herdr 0.9.3, Muse Gadget SDK (Apache-2.0), whisper.cpp (MIT), Node.js and dependencies, Python and esptool, and LAME (LGPL). Node and Python retain their bundled license files. JavaScript and Python packages retain their package metadata and licenses. Source and build instructions: https://github.com/maxgrev/maestro (private development repository).\n")
    info = {"CFBundleIdentifier": "dev.maestro.stopwatch", "CFBundleName": "Maestro", "CFBundleExecutable": "Maestro", "CFBundlePackageType": "APPL", "CFBundleShortVersionString": "0.2.0", "CFBundleVersion": "2", "LSMinimumSystemVersion": "14.0", "NSHighResolutionCapable": True, "NSLocalNetworkUsageDescription": "Maestro connects your StopWatch to agents on this Mac.", "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True}}
    (APP / "Contents/Info.plist").write_bytes(plistlib.dumps(info))
    run("swiftc", "-parse-as-library", "-target", "arm64-apple-macos14.0", "-module-cache-path", str(ROOT / ".cache/swift"), "-O", "-framework", "AppKit", "-framework", "WebKit", str(ROOT / "desktop/Maestro.swift"), "-o", str(APP / "Contents/MacOS/Maestro"))
    # Local development signature. A public release needs Developer ID + notarization.
    run("codesign", "--force", "--deep", "--sign", "-", str(APP))
    run("codesign", "--verify", "--deep", "--strict", str(APP))
    run("ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(APP), str(ROOT / "dist/Maestro-apple-silicon.zip"))
    print("Built " + str(APP))


if __name__ == "__main__": main()
