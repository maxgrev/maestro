#!/usr/bin/env python3
"""Preview or remove build tools and caches while keeping the app and its data."""
import argparse
import hashlib
import json
import os
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SDK = Path("firmware/build/sdk/esp32")
BUILD = SDK / "build-maestro"
# Exact generated paths only. Keep runtime tools, dependencies, firmware images,
# prepared SDK source, release source archives, and all private data.
REMOVABLE = (
    ".tools/espressif", ".cache/esp-idf", ".cache/whisper-build",
    ".cache/lame-3.100", ".cache/lame-3.100-build", ".cache/third-party",
    ".cache/npm", ".cache/swift", "dist/Maestro-apple-silicon.zip",
    str(SDK / "managed_components"),
    *[str(BUILD / name) for name in (
        "esp-idf", "CMakeFiles", "CMakeCache.txt", "build.ninja",
        "compile_commands.json", ".ninja_deps", ".ninja_log", "config",
        "bootloader-prefix", "muse-gadget.elf", "muse-gadget.map",
        "bootloader/esp-idf", "bootloader/CMakeFiles", "bootloader/config",
        "bootloader/CMakeCache.txt", "bootloader/build.ninja",
        "bootloader/compile_commands.json", "bootloader/.ninja_deps",
        "bootloader/.ninja_log", "bootloader/bootloader.elf", "bootloader/bootloader.map",
    )],
)


def checked_path(root: Path, name: str | Path) -> Path:
    path = root / name
    if not path.is_relative_to(root) or ".." in path.parts:
        raise ValueError(f"Path outside the project: {name}")
    for part in [path, *path.parents]:
        if part == root:
            break
        if part.is_symlink():
            raise ValueError(f"Refusing a symlink: {part.relative_to(root)}")
    return path


def verify_firmware(root: Path) -> list[Path]:
    build = checked_path(root, BUILD)
    if not build.exists():
        return []
    manifest = json.loads(checked_path(root, BUILD / "maestro-manifest.json").read_text())
    if manifest.get("generic") is not True or manifest.get("board") != "m5stack-stopwatch" or not manifest.get("files"):
        raise ValueError("Cannot verify the saved StopWatch firmware; no files were removed.")
    images = []
    for item in manifest["files"]:
        name = Path(item["file"])
        if name.is_absolute() or ".." in name.parts:
            raise ValueError("Firmware image path escapes the build folder.")
        path = checked_path(root, BUILD / name)
        with path.open("rb") as source:
            checksum = hashlib.file_digest(source, "sha256").hexdigest()
        if checksum != item["sha256"]:
            raise ValueError(f"Firmware checksum failed: {name}")
        images.append(path)
    return images


def firmware_notices(root: Path) -> list[tuple[Path, bytes]]:
    notices = []
    if not checked_path(root, BUILD).exists():
        return notices
    for label, name in [("ESP-IDF", Path(".cache/esp-idf")), ("components", SDK / "managed_components")]:
        directory = checked_path(root, name)
        for source in directory.rglob("*"):
            if ".git" in source.parts or not source.name.upper().startswith(("LICENSE", "COPYING", "NOTICE")):
                continue
            checked_path(root, source.relative_to(root))
            if source.is_file():
                dest = checked_path(root, BUILD / "Notices" / label / source.relative_to(directory))
                data = source.read_bytes()
                if dest.exists() and dest.read_bytes() != data:
                    raise ValueError(f"Existing firmware notice differs: {dest.relative_to(root)}")
                notices.append((dest, data))
    return notices


def disk_bytes(path: Path, seen: set[tuple[int, int]]) -> int:
    paths = [path, *path.rglob("*")] if path.is_dir() else [path]
    total = 0
    for item in paths:
        stat = item.lstat()
        identity = (stat.st_dev, stat.st_ino)
        if identity not in seen:
            total += stat.st_blocks * 512
            seen.add(identity)
    return total


def protected_paths(root: Path) -> list[Path]:
    data_dirs = {(root / ".local").resolve(), (root / os.environ.get("MAESTRO_DATA", ".local")).resolve()}
    protected = list(data_dirs)
    for data in data_dirs:
        config_file = data / "config.json"
        if config_file.exists():
            config = json.loads(config_file.read_text())
            paths = [config.get("herdr", {}).get("binary")]
            paths += [config.get("speech", {}).get(key) for key in
                      ("python", "helper", "whisper", "model", "kokoro", "lame", "ffmpeg")]
            protected += [(root / path).resolve() for path in paths if isinstance(path, str) and path]
    protected += [(root / os.environ[key]).resolve() for key in ("MAESTRO_PYTHON", "MAESTRO_FIRMWARE")
                  if os.environ.get(key)]
    return protected


def clean(root: Path, apply: bool = False) -> int:
    root = root.resolve()
    candidates = [checked_path(root, name) for name in REMOVABLE]
    candidates = [path for path in candidates if path.exists()]
    protected = protected_paths(root)
    if any(path == saved or path in saved.parents or saved in path.parents
           for path in candidates for saved in protected):
        raise ValueError("A cleanup target overlaps configured data or a runtime dependency.")
    images = verify_firmware(root)
    if any(path == image or path in image.parents for path in candidates for image in images):
        raise ValueError("A cleanup target contains a required firmware image.")
    notices = firmware_notices(root)
    checksum_file = checked_path(root, "dist/SHA256SUMS")
    checksums = checksum_file.read_text() if checksum_file.exists() else None
    total = 0
    seen = set()
    for path in candidates:
        size = disk_bytes(path, seen)
        total += size
        print(f"{size / 1_000_000:9.1f} MB  {path.relative_to(root)}")
    print(f"{'Removing' if apply else 'Would remove'} {total / 1_000_000_000:.2f} GB. App, runtime tools, firmware images, and private data stay in place.")
    if apply:
        # Save license texts before removing downloaded SDKs and components.
        for dest, data in notices:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
        for path in candidates:
            checked_path(root, path.relative_to(root))
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
        if checksums is not None:
            lines = [line for line in checksums.splitlines(keepends=True)
                     if line.strip().split(maxsplit=1)[1:] != ["Maestro-apple-silicon.zip"]]
            if "".join(lines) != checksums:
                checksum_file.write_text("".join(lines))
    else:
        print("Preview only. Run npm run storage:clean -- --apply to remove these files.")
    return total


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="remove the listed files; default is a preview")
    args = parser.parse_args()
    try:
        clean(ROOT, args.apply)
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, f"Cleanup stopped: {error}\n")


if __name__ == "__main__":
    main()
