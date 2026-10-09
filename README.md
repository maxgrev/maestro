# Maestro

A voice remote for the **M5Stack StopWatch C152**. Pick an agent, hold the talk button, and release to send. A small Mac bridge handles local speech, coding sessions, and Grok Bot requests. Muse keeps its native Gadget SDK connection.

**Built and checked on October 9, 2026.** The firmware, including the supplied Muse SDK token, is installed on the StopWatch and the device has joined Wi-Fi. Muse is paired with Elo and online; a spoken test passed through the physical microphone, Muse, and device reply playback. The Mac bridge works with real Codex sessions, including new conversations, follow-ups, transcription, and clean final replies. Grok's authenticated routine and local reply path passed live request and follow-up tests, including after a bridge restart. The device lists Grok Bot.

| Agent | Current support |
| --- | --- |
| Codex | New and existing Herdr sessions; clean reply text from Codex's read-only app-server API. Live tested. |
| Claude Code / Pi | Herdr discovery, launch, prompt, and terminal output. Install and sign in to their CLIs first. Voice announces completion; clean answer speech is currently Codex-only. Not live tested here. Pi means the Pi coding agent. |
| Muse | Paired with Elo through the official Muse Gadget SDK. Physical microphone → native Muse voice note → reply playback passed, using the Mac TTS addition. Uses the SDK's current conversation; arbitrary chat selection/creation is not implemented. |
| Grok Bot | Configured routine on the main Bot; replies return through its existing Mac connection. Live requests and follow-ups work. Maestro supplies the last 12 exchanges, capped at 24,000 text characters. This does not import arbitrary Bot chat transcripts. |

Existing coding sessions must run in the configured Herdr session. Maestro does not take over arbitrary desktop chats or terminal processes.

**Run on this Mac**

The tools and configuration are already installed locally. From this folder:

```sh
npm start
```

Open [Maestro on localhost](http://localhost:4210). The launcher starts or reuses the dedicated `maestro` Herdr session. `Ctrl+C` stops the bridge; Herdr keeps its conversations. Open its terminal UI with `scripts/herdr.sh`. Use `npm run doctor` to check dependencies.

The bridge listens on loopback HTTP port 4210 for its local page and authenticated HTTPS port 4211 for the device. It needs this Mac awake and on the same network. No public tunnel or login service was installed.

**Connect the StopWatch**

1. Set its 2.4 GHz Wi-Fi over USB. This prompts for the password without saving it in shell history:

   ```sh
   .tools/python/bin/python scripts/wifi.py /dev/cu.usbmodem101
   ```

2. Keep `npm start` running. Tap the agent name on the device to refresh and choose a conversation. Hold the talk button, then release. Bridge recordings must be 0.3–20 seconds. After a new coding session replies, the device selects that session for follow-ups.
3. Muse is already paired on this StopWatch. The supplied SDK token is saved in `.local/muse-sdk-token` and included in the installed firmware. For a fresh installation, get a token from [gadgets.muse.ai](https://gadgets.muse.ai), save it in that private file before building, then follow the [official phone pairing steps](https://github.com/facebookincubator/muse-gadget-sdk/tree/d7e5d22bbd1cb8e6369310f72039247b76942e5a/esp32#readme). The StopWatch's yellow button confirms pairing and acts as push-to-talk afterward.

```sh
npm run firmware:build
.tools/python/bin/python scripts/flash.py /dev/cu.usbmodem101
```

`.local/device.json` contains the bridge's LAN HTTPS address; the firmware embeds it, its pinned certificate, and a device bearer token. If the Mac's IP changes, update that address and regenerate the certificate if the new address is absent from its SANs, then rebuild and flash. Reserve the Mac's current IP in your router to avoid routine changes. The certificate expires after one year. Do not disable certificate checks.

The device needs network time for TLS, obtained through SNTP. Muse text can use its native connection without this Mac; Maestro's added spoken Muse replies need the bridge. The web page chooses the recipient for its own messages; it does not remotely change the device's selected agent.

**Configuration**

Private settings live in `.local/config.json`. `projects` is the allowlist for new coding sessions. `herdr.session` chooses an existing Herdr instance; the supplied launcher uses `maestro`. To connect another instance, change the configuration and start it separately. The agent keeps its normal tool permissions. Approvals stay in the agent's own interface.

On this Mac, `.tools/codex` points at the working Codex app bundle because the global CLI wrapper was broken. Maestro launches it with `--no-daemon` to avoid a package-version conflict with the shared daemon. `codexBinary` must point at that same CLI for clean spoken replies. No global CLI or login settings were replaced.

See [Grok Bot setup](docs/grok-bot.md) for the webhook and reply helper. Leave `grok` absent until it is configured; the UI shows the missing setup instead of a fake connected agent.

**A fresh checkout**

This version targets Apple Silicon macOS, Node 24+, Python 3.13, Xcode command-line tools, and FFmpeg. For example, install missing prerequisites through Homebrew, then:

```sh
bash scripts/bootstrap.sh
```

The script downloads checksum-pinned Herdr 0.9.3 and the Muse SDK, installs ESP-IDF 6.0.1 in `.cache`, and builds whisper.cpp 1.8.3 with its multilingual base model. It keeps tools under `.tools`, uses `npm ci`, and preserves existing private configuration. It does not flash hardware. Install/sign in to your chosen agent CLI separately; make it available in PATH or link its executable into `.tools`. Then run `npm run setup` and set `codexBinary` if using Codex reply extraction.

**Recovery**

The original 16 MB flash image and SHA-256 checksum are in `.local/backups`. The flasher checks the backup before writing firmware and uses IDF's generated partition addresses. To restore this same StopWatch:

```sh
.tools/python/bin/python scripts/flash.py /dev/cu.usbmodem101 --restore
```

Close other serial monitors first. If the port disappears, reconnect USB or enter the board's download mode. This build disables OTA and automatic eFuse provisioning. NVS/flash encryption is also off for recoverable bring-up, so physical flash access can expose stored Wi-Fi and device credentials. Keep `.local`, firmware binaries, and backups private; they are ignored by Git.

**Checks and limits**

```sh
npm run check
npm test
```

Twelve bridge tests cover duplicate requests, lost acknowledgments, restart recovery, bounded Grok history, busy conversations, stale or blocked targets, callback authentication, audio validation, and matching final answers. Three Python helper tests cover local delivery, invalid input, and redirect refusal. The pinned SDK's host suite ran 198 tests: 197 passed and one skipped for an optional dependency. Hardware boot, USB flashing, Wi-Fi agent discovery, the 466×466 UI, and the SDK's microphone/audio initialization checks passed. A synthesized recording completed the real HTTPS → whisper.cpp → Codex → final-text flow.

Muse's live hardware check used a short phrase spoken by this Mac and captured by the StopWatch's microphone through the SDK's push-to-talk bench controls. The 11.08-second recording had no clipped samples. Muse accepted it and returned one reply; the device decoded 0.83 seconds of reply audio at 16 kHz. Playback began 6.40 seconds after release. The device reported paired/Online, and the iPhone showed it connected. This checks the audio path, not a human judgment of speaker quality.

Physical microphone round trips to Grok and coding agents, speaker quality judged by a listener, touch behavior, and battery life still need acceptance checks. Earlier development failures remain visible in local request history; requests are never silently replayed to clear an error.

[Design and protocol notes](docs/build-plan.md) explain the small set of dependencies and the remaining targeting limits.

[Setup UX notes](docs/setup-ux.md) outline the guided setup to build after this MVP.
