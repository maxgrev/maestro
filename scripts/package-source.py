#!/usr/bin/env python3
"""Export a source snapshot without private Git history, tools, or runtime data."""
import hashlib
import json
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PATHS = (
    "bridge", "desktop", "docs", "firmware/src", "scripts", ".github",
    "firmware/dependencies.lock", "firmware/sdkconfig.maestro", ".gitignore", ".gitleaksignore",
    "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "CONTRIBUTING.md", "SECURITY.md",
    "package.json", "package-lock.json", "tsconfig.json",
)
EXCLUDED = {"__pycache__", ".DS_Store"}


def source_files(root=ROOT):
    for name in PATHS:
        path = root / name
        if not path.exists():
            raise FileNotFoundError(f"Missing release source: {name}")
        for file in sorted(path.rglob("*")) if path.is_dir() else [path]:
            relative = file.relative_to(root)
            if any(part in EXCLUDED or part.startswith(".") and part not in {".github", ".gitignore", ".gitleaksignore"}
                   for part in relative.parts) or file.suffix in {".pyc", ".log", ".bin", ".key", ".pem", ".sqlite"}:
                continue
            if file.is_symlink():
                raise ValueError(f"Release source must not contain symlinks: {relative}")
            if file.is_file():
                yield file


def checksums(dist):
    files = sorted(path for path in dist.iterdir() if path.is_file() and path.suffix in {".gz", ".zip"})
    lines = [f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n" for path in files]
    (dist / "SHA256SUMS").write_text("".join(lines))


def main():
    version = json.loads((ROOT / "package.json").read_text())["version"]
    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    archive = dist / f"Maestro-{version}-source.tar.gz"
    files = list(source_files())
    with tarfile.open(archive, "w:gz") as tar:
        for file in files:
            tar.add(file, arcname=str(Path(f"Maestro-{version}") / file.relative_to(ROOT)), recursive=False)
    checksums(dist)
    print(f"Exported {len(files)} source files to {archive}")


if __name__ == "__main__":
    main()
