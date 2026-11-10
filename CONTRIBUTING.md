# Contributing

Maestro supports the M5Stack StopWatch C152 and Apple Silicon Macs running
macOS 14 or later. Keep changes within that scope unless an issue proposes
another target.

Follow the [README](README.md) to build from a fresh checkout. Before opening
a pull request, run:

```sh
npm run check
npm test
npm run firmware:build
.tools/python/bin/python -m unittest discover -s scripts/tests -v
```

The firmware build prepares the SDK needed by the character tests. CI tests
Node 24 and 26, builds StopWatch firmware, and builds and smoke-tests the Mac
app on Apple Silicon. No CI job flashes hardware or signs in to an agent.

Keep custom firmware under `firmware/src`. `scripts/prepare-firmware.py`
copies it into an ignored SDK build tree. Do not edit generated vendor files.
Keep downloads pinned and checksum-verified. Update the matching notices when
adding a dependency or artwork.

Add a test for a behavior fix. Describe what changed, how you checked it,
and any physical-device checks you could not run. Use your own provider
accounts; never include configuration, transcripts, recovery images, or keys
in an issue, test fixture, or pull request.

## Run the Mac app

After bootstrap, use macOS 26 or later with Xcode 26 or later to build and
open the native app:

```sh
npm run app:run
```

This stops a running Maestro app, refreshes its code and UI, and opens it
again. It reuses the bundled runtimes and compiler cache when available.
Use `npm run app:run -- --debug` for LLDB or `--logs` for live app logs.

## Repository layout

| Directory | Contents |
| --- | --- |
| `bridge/` | TypeScript bridge, local web interface, and bridge tests. |
| `desktop/` | Native Swift app, app icon, entitlements, and Python requirements. |
| `firmware/` | StopWatch code, pinned component versions, and board configuration. |
| `scripts/` | Setup, build, device, packaging, and release tools, plus Python/C tests. |
| `docs/` | Architecture, provider guides, images, and release instructions. |
| `.github/` | CI workflows. |

Private configuration stays in `.local/`. Downloaded tools, build caches,
and packaged apps stay in `.tools/`, `.cache/`, and `dist/`. These folders
and local Codex/Claude settings are ignored by Git.

## License

Contributions use the project's GPLv3 license (`GPL-3.0-only`). Preserve
copyright and license notices, including [NOTICE](NOTICE). Third-party files
retain their own terms. See [third-party notices](THIRD_PARTY_NOTICES.md).
