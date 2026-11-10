# Release a StopWatch build

The release target is the M5Stack StopWatch C152 and Apple Silicon macOS 14+.
Broader ESP32, Intel Mac, Windows, and Linux support are outside this release.

## Build and check

Follow the README's prerequisites, then run:

```sh
bash scripts/bootstrap.sh
npm run check
npm test
.tools/python/bin/python -m unittest discover -s scripts/tests -v
python3.13 scripts/package-firmware.py
npm run app:build -- --archive
python3.13 scripts/smoke-mac.py
npm run release:source
```

The smoke test uses isolated data and the bundled runtimes. It checks the
bridge, USB imports, and actual speech without signing in or flashing a
device. CI runs these checks on hosted Linux and Apple Silicon runners and
saves the artifacts for review. CI artifacts use an ad hoc signature for
testing; they are not notarized downloads.

All signing paths remove disposable Python bytecode before sealing the app.
The app disables bytecode writes at runtime, so deleting Python caches later
does not invalidate the signature.

Before calling a release tested on hardware, install it on a fresh StopWatch
from a second Mac with the public instructions. Try Wi-Fi, a voice round trip,
a restart, and recovery using that device's own backup. Mark any unchecked
provider as unverified. Never substitute an automated connection check for a
human listening or battery test.

## Sign the public Mac app

After building and testing, use your Developer ID and a notarytool keychain
profile:

```sh
python3.13 scripts/sign-mac.py --identity 'Developer ID Application: YOUR NAME (TEAMID)' --notary-profile maestro
```

The signer signs nested code with the hardened runtime, notarizes and staples
the app, verifies Gatekeeper, and replaces the ZIP only after success. The
signing certificate and notary credentials belong in the keychain, never Git.
Do not advise users to disable Gatekeeper.

Publish the firmware ZIP, signed Mac ZIP, Maestro source archive, third-party
source archive, and `SHA256SUMS` together under the same version tag. The Mac
package reads its version from `package.json`. Rebuild archives and checksums
after any source, dependency, or signing change.

Keep Maestro's `LICENSE` and `NOTICE` in source and firmware exports and the
Mac app's Notices directory. Distributions must preserve copyright and
license notices and meet GPLv3's corresponding-source requirements. Third-party
components and artwork retain their own terms.

## Publish source safely

The source exporter preserves the current source and artwork, with no Git
history, local data, build caches, or firmware backups. It does not grant
redistribution rights. Confirm the terms for the existing Codex companion
and native Muse artwork before publishing a source archive, firmware, Mac
binary, or the existing repository. Keep this licensing question explicit;
do not replace the artwork as part of release preparation without the owner's
approval.

Scan both the history you plan to publish and the extracted source archive:

```sh
gitleaks git --redact --no-banner
gitleaks dir --redact --no-banner /path/to/extracted/Maestro-0.2.0
```

Enable private vulnerability reporting on the public repository. Add a short
release note with the supported hardware, required Mac, provider limits, and
the checks run for that release.
