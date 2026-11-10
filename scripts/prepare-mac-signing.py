#!/usr/bin/env python3
"""Remove disposable Python bytecode before sealing a Mac app's resources."""
import argparse
import shutil
from pathlib import Path


def prepare(app: Path) -> int:
    app = app.absolute()
    python = app / "Contents/Resources/.tools/python"
    for path in [python, *python.parents]:
        if path.is_symlink():
            raise ValueError("Refusing a symlink in the app's Python runtime path.")
        if path == app:
            break
    if app.suffix != ".app" or not (app / "Contents/Info.plist").is_file() or not python.is_dir():
        raise ValueError("Expected a Maestro app bundle with its bundled Python runtime.")
    removed = 0
    for path in python.rglob("*"):
        cached = "__pycache__" in path.relative_to(python).parts or path.with_suffix(".py").is_file()
        if cached and not path.is_symlink() and path.is_file() and path.suffix in {".pyc", ".pyo"}:
            path.unlink()
            removed += 1
    for path in sorted(python.rglob("__pycache__"), key=lambda p: len(p.parts), reverse=True):
        if not path.is_symlink() and path.is_dir():
            shutil.rmtree(path)
    return removed


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path, help="app bundle to prepare before codesign")
    args = parser.parse_args()
    try:
        count = prepare(args.app)
    except (OSError, ValueError) as error:
        parser.exit(1, f"Signing preparation stopped: {error}\n")
    print(f"Prepared Python runtime for signing: {count} bytecode files removed.")


if __name__ == "__main__":
    main()
