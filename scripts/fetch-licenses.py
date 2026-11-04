#!/usr/bin/env python3
"""Collect speech-tool source and notices beside a distributable Mac app."""
import hashlib
import json
import re
import subprocess
import tarfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache/third-party"


def download(url, name, checksum=None):
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / name
    if not path.exists():
        partial = path.with_suffix(".part")
        urllib.request.urlretrieve(url, partial)
        partial.rename(path)
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if checksum and actual != checksum:
        raise ValueError(f"Source checksum failed: {name}")
    return path, {"file": name, "url": url, "sha256": actual}


def main():
    version = json.loads((ROOT / "package.json").read_text())["version"]
    notices = ROOT / "dist/Maestro.app/Contents/Resources/Notices"
    notices.mkdir(parents=True, exist_ok=True)
    sources = []
    sources.append(download(
        "https://codeload.github.com/espeak-ng/espeak-ng/tar.gz/refs/tags/1.52.0",
        "espeak-ng-1.52.0.tar.gz", "bb4338102ff3b49a81423da8a1a158b420124b055b60fa76cfb4b18677130a23"))
    lame = subprocess.check_output(["lame", "--version"], text=True)
    match = re.search(r"version\s+(\d+\.\d+(?:\.\d+)?)", lame)
    checksums = {
        "3.100": "ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e",
        "4.0": "3df5124d5ad3a98312ffd7ba6a9b36230e4f8a3e66d3ce0f425e336c32d216eb",
    }
    if not match or match[1] not in checksums:
        raise ValueError("LAME source pin needs updating for this installed encoder.")
    lame_version = match[1]
    sources.append(download(
        f"https://downloads.sourceforge.net/project/lame/lame/{lame_version}/lame-{lame_version}.tar.gz",
        f"lame-{lame_version}.tar.gz", checksums[lame_version]))
    # The loader publishes wheels only. This source revision declares 0.2.4
    # and includes its MIT license; eSpeak itself is supplied separately above.
    sources.append(download(
        "https://codeload.github.com/thewh1teagle/espeakng-loader/tar.gz/0ddc87adf77e5850d7eeb542ac8a87d421b64daa",
        "espeakng-loader-0.2.4.tar.gz", "c52fde6a08f790dc9f150b68205a35d3ce0aa95dbd5fa8be7b22989b26d1ba09"))
    for name, package_version in [("phonemizer", "3.4.0"), ("soxr", "1.0.0")]:
        with urllib.request.urlopen(f"https://pypi.org/pypi/{name}/{package_version}/json", timeout=30) as response:
            metadata = json.load(response)
        source = next(item for item in metadata["urls"] if item["packagetype"] == "sdist")
        sources.append(download(source["url"], source["filename"], source["digests"]["sha256"]))
    # Include license texts that some binary Python wheels omit.
    for path, _ in sources:
        with tarfile.open(path) as tar:
            for member in tar.getmembers():
                if member.isfile() and member.name.count("/") <= 2 and Path(member.name).name.upper() in {"LICENSE", "COPYING", "COPYING.LGPL"}:
                    data = tar.extractfile(member)
                    if data:
                        (notices / (path.name.split(".tar")[0] + "-" + Path(member.name).name + ".txt")).write_bytes(data.read())
    for name, url in {
        "Herdr.txt": "https://raw.githubusercontent.com/herdrdev/herdr/v0.9.3/LICENSE",
        "Whisper-model.txt": "https://raw.githubusercontent.com/openai/whisper/main/LICENSE",
    }.items():
        path, _ = download(url, name)
        (notices / name).write_bytes(path.read_bytes())
    recipe = (
        "These archives contain source for the bundled GPL/LGPL speech tools.\n"
        "eSpeak NG 1.52.0: cmake -S . -B build -DBUILD_SHARED_LIBS=ON -DENABLE_TESTS=OFF "
        "-DCOMPILE_INTONATIONS=OFF -DCMAKE_BUILD_TYPE=Release; cmake --build build; cmake --install build.\n"
        "espeakng-loader supplies this library and data to Phonemizer. Its source archive includes its packaging code.\n"
        "Phonemizer and python-soxr: unpack their source archives, then python3.13 -m pip install .\n"
        f"LAME {lame_version}: ./configure --disable-shared --enable-static; make; make install. "
        "The packaged command links only macOS system libraries.\n"
        "Maestro's scripts/speech.py and desktop/requirements-speech.txt are in the matching Maestro source archive.\n"
        "To use a modified library, replace it in the app's Python site-packages, then apply a local ad hoc signature "
        "with codesign --force --deep --sign - Maestro.app, or rebuild the app from source.\n"
        "Publish this archive beside the matching Mac app, with the Maestro source archive.\n"
    )
    (notices / "SOURCES.txt").write_text(recipe)
    manifest = json.dumps([record for _, record in sources], indent=2) + "\n"
    (notices / "speech-sources.json").write_text(manifest)
    output = ROOT / f"dist/Maestro-{version}-third-party-sources.zip"
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as out:
        for path, _ in sources:
            out.write(path, path.name)
        out.writestr("BUILD.txt", recipe)
        out.writestr("sources.json", manifest)
    print(f"Collected speech source and notices: {output}")


if __name__ == "__main__":
    main()
