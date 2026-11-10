# Third-party notices

Maestro's original source uses [GPLv3](LICENSE) (`GPL-3.0-only`).
Its copyright and license notice is in [NOTICE](NOTICE).
Third-party code, models, and marks keep their own terms. Maestro does not
grant access to a provider account or permission to use a provider's marks
as your own brand.

| Component | Version or source | License and source |
| --- | --- | --- |
| Muse Gadget SDK | `d7e5d22bbd1cb8e6369310f72039247b76942e5a` | [Apache-2.0](https://github.com/facebookincubator/muse-gadget-sdk/blob/d7e5d22bbd1cb8e6369310f72039247b76942e5a/LICENSE) for SDK code. Its native Jollybot avatar and animation data have separate terms; the SDK's Apache license does not cover them. |
| ESP-IDF | 6.0.1 | [Apache-2.0 and component notices](https://github.com/espressif/esp-idf/tree/v6.0.1). Managed component versions are in `firmware/dependencies.lock`; each retains its license. |
| Herdr | 0.9.3 | [Apache-2.0](https://github.com/herdrdev/herdr/blob/v0.9.3/LICENSE). |
| whisper.cpp | 1.8.3 | [MIT](https://github.com/ggml-org/whisper.cpp/blob/v1.8.3/LICENSE). |
| Whisper base model | checksum in `scripts/bootstrap.sh` | [MIT](https://github.com/openai/whisper/blob/main/LICENSE). |
| Kokoro model | 1.0 | [Apache-2.0](docs/licenses/Kokoro-model.txt), with [notice](docs/licenses/Kokoro-NOTICE.txt). |
| kokoro-onnx | 0.6.1 | [MIT](docs/licenses/Kokoro-wrapper.txt). |
| Phonemizer | 3.4.0 | GPL-3.0-or-later. Source and license accompany the Mac package. |
| eSpeak NG | 1.52.0, through espeakng-loader 0.2.4 | [GPL-3.0-or-later](https://github.com/espeak-ng/espeak-ng/tree/1.52.0). Source, build recipe, and license accompany the Mac package. |
| python-soxr / libsoxr | 1.0.0 / bundled upstream | LGPL-2.1-or-later; bundled third-party terms remain in the Python package. Source accompanies the Mac package. |
| LAME | 3.100, built from checksum-pinned source | [LGPL-2.0-or-later](https://lame.sourceforge.io/license.txt). Matching source and build instructions accompany the Mac package. |
| ONNX Runtime | 1.31.0 | MIT; its license and ThirdPartyNotices.txt remain in the Python runtime. |
| Node.js and Python | pinned by `scripts/package-mac.py` | License texts remain in their runtime distributions. |
| JavaScript dependencies | `package-lock.json` | Each package retains its license/README in `node_modules`. The Claude Agent SDK uses Anthropic's stated terms; Maestro does not relicense it. |
| Python dependencies | `desktop/requirements-*.txt` | Each package retains its metadata and license files. |
| MD4C | vendored | [MIT](firmware/src/vendor/md4c/LICENSE.md). |
| Pixel font | SDK's Adafruit-derived bitmap font | [BSD-2-Clause](docs/licenses/Pixel-font.txt). |
| Clawd Tank | `a8942d140eeb8bcf549857ad599f7d62fd29eb01` | [MIT](firmware/src/avatars/Clawd-LICENSE.txt), copyright Marcio Granzotto Rodrigues. |

See [character sources](firmware/src/avatars/SOURCES.md) for the artwork.
The original Codex companion and native Muse artwork remain in use. Their
public redistribution rights still need verification; Maestro's code license
does not grant rights to those assets.

`scripts/package-mac.py` collects notices in the app's
`Contents/Resources/Notices` directory and writes a matching
`Maestro-<version>-third-party-sources.zip`. Publish this source archive beside
any downloadable Mac binary. It contains source and build instructions for
the GPL/LGPL speech tools; a link to a private repository is not a source
distribution. Keep library files replaceable when rebuilding the app.
