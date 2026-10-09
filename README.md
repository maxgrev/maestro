# Maestro

A voice remote for the **M5Stack StopWatch C152**. Choose an agent, hold yellow to talk, then release to send. The Mac app handles local speech, coding sessions, and Grok Bot requests. Muse uses the official Gadget SDK.

## Use the Mac app

Open `dist/Maestro.app`. It starts the bridge and opens one guided flow:

1. **Device:** connect USB, check the board, and install firmware. Maestro verifies a recovery copy before writing.
2. **Wi-Fi:** enter a 2.4 GHz network or keep the device's verified saved network.
3. **Agents:** pair Muse, connect a Grok Bot routine, or install and sign in to coding agents. Choose a project folder with the Mac folder picker. Codex needs your explicit folder-trust choice; its tool approvals still apply.
4. **Try it:** check the device and Mac connection, open the agent list, and try a short message.

The app stays running when its window closes. Use its menu-bar item to reopen it. Quitting the app stops its bridge; Herdr keeps its conversations. Keep the Mac awake and on the same network for Grok, coding agents, and spoken replies.

This package targets **Apple Silicon macOS**. It includes its runtimes and speech model; no Homebrew or terminal is needed to run it. The development app has a local signature. A public release still needs a Developer ID signature, notarization, and distribution review of bundled third-party licenses. Do not tell users to bypass Gatekeeper.

## StopWatch controls

| Control | On the main screen | In the agent list |
| --- | --- | --- |
| Yellow | Hold to record; release to send | Choose the highlighted agent |
| Blue | Open agents | Move to the next row |
| Hold blue | Open settings | Open settings |
| Touch | Tap the agent name to open the list; swipe to settings | Tap a row to choose it; tap × to close |
| Power | Keep the board's normal power function | Same |

A short vibration confirms a choice. Settings reuse the SDK's volume, speaker, brightness, sleep, Wi-Fi, and phone setup controls. Blue moves through that menu; yellow selects. Hold blue to return.

Muse keeps its original character. Grok is a silver space cat, Codex a mint terminal robot, Claude a terracotta star, and Pi a golden sprout. They blink and respond to listening, thinking, speaking, and errors. They share the SDK's renderer, caption layout, and frame timing. Characters are Maestro artwork, not provider logos.

The device remembers the selected agent. A missing or busy saved session stays unavailable; it does not silently redirect a message to Muse. The list refreshes after Wi-Fi connects and every 15 seconds while idle. The Mac page chooses the recipient of its own messages; the device has its own selector.

## Agent support

| Agent | Supported connection | Limits |
| --- | --- | --- |
| Codex | New and existing Herdr sessions. Clean final replies from its read-only app-server API. | Existing sessions must be in Maestro's configured Herdr instance. If the read API times out, Maestro announces completion and keeps the terminal output available. |
| Claude Code / Pi | Herdr discovery, launch, prompts, and terminal output. Install controls use pinned official packages. Codex and Claude use provider browser sign-in; Pi can reuse its saved account or accept a provider API key. | Voice announces completion; clean answer speech is currently Codex-only. Live account sign-in and voice runs for Claude/Pi have not been checked here. |
| Muse | Official Muse Gadget SDK and phone pairing. The existing Elo pairing remains intact. | Uses the SDK's current conversation. Arbitrary chat creation and selection are not implemented. Muse spoken replies use Mac speech. |
| Grok Bot | An authenticated routine on the user's Bot. Replies return through its existing Mac connection. | Needs a webhook URL/key from Grok Bot. Maestro supplies the last 12 complete exchanges, capped at 24,000 text characters; it does not import arbitrary Bot chat transcripts. |

Provider account consent and tool approvals remain with the provider. See [Grok Bot setup](docs/grok-bot.md). The wizard includes a routine instruction tailored to the current Mac, with a copy button.

## Local data and networking

A downloaded app uses `~/Library/Application Support/Maestro`. A development app built under this checkout reuses its existing `.local` directory. The app remembers that location. Data includes the SQLite request history, private configuration, certificate, recovery copies, and tool installs. `MAESTRO_DATA` selects another directory for command-line development.

The local page uses loopback HTTP port 4210. The device uses authenticated HTTPS port 4211 with a pinned certificate. Setup saves the URL, certificate, bearer token, and personal Muse SDK token to device NVS over USB. The generic firmware contains no personal credentials. Bonjour resolves the Mac's `.local` name when its certificate covers that name; numeric addresses remain supported.

The certificate expires after one year. Renew it and use **Save to StopWatch** to provision the new pin. Do not disable certificate checks. The device uses SNTP for TLS time. No public tunnel, cloud relay, MQTT broker, or new orchestration framework is required.

Device NVS and flash encryption remain off for recoverable development. Physical flash access can expose saved Wi-Fi and account credentials. Keep runtime data and recovery images private. Git ignores `.local`, tool caches, build output, and packaged apps.

## Development

For a fresh checkout, use Apple Silicon macOS, Node 24+, Python 3.13, Xcode command-line tools, and FFmpeg for the source-only bridge. `scripts/bootstrap.sh` downloads the pinned Muse SDK, ESP-IDF 6.0.1, Herdr 0.9.3, and whisper.cpp 1.8.3 with its multilingual base model.

```sh
bash scripts/bootstrap.sh
npm start
```

Open [the local setup flow](http://localhost:4210/setup.html). Development commands remain available; ordinary app users do not need them.

```sh
npm run check
npm test
.tools/python/bin/python -m unittest discover -s scripts/tests -v
npm run firmware:build
.tools/portable-python/python/bin/python3 scripts/package-mac.py
```

`package-mac.py` verifies the portable runtime downloads, compiles TypeScript and the small AppKit/WebKit launcher, includes generic firmware and pinned dependencies, and creates `dist/Maestro-apple-silicon.zip`. The builder also needs Homebrew LAME; the resulting app does not. The app uses macOS `say` and bundled LAME instead of a full FFmpeg distribution.

`config.json` lists allowed projects, coding agents, the Herdr session, speech tools, and Grok's keys. The guided forms cover normal setup. Advanced Herdr instance changes still use this private configuration. Do not run two bridges on the same ports.

## Recovery and validation

The guided installer stores each board's 16 MB recovery image and checksum under `backups/<chip-mac>/`. It verifies the firmware manifest, board confirmation, chip identity, flash size, and backup before writing. A failed or uncertain request never retries itself. Reconnect USB and explicitly retry installation if needed.

The older `scripts/flash.py --restore` restores this development StopWatch's original factory image from `.local/backups/stopwatch-original.bin`. Use it only with the original board. Close other serial tools first.

The tests cover USB log interleaving, paced certificate transfer, board confirmation, concurrent setup writes, secret-free status, failed-write handling, project trust, callback delivery, request deduplication, restart recovery, and speech format validation. The SDK host suite passed 197 tests, with one optional dependency test skipped.

Live checks have covered Muse pairing and its physical voice path, Codex new sessions and follow-ups, and Grok routine replies. The guided installer has flashed this StopWatch, preserved Wi-Fi and Muse pairing, and verified its Bonjour connection to the Mac. Agent switching, selection after reboot, and characters have been checked on its display. The app installed Claude Code and found its saved account. Bundled speech and a recorded-audio request to Grok passed; the latest Mac-speaker-to-device-microphone test detected no speech. A human microphone/speaker check, battery life, a clean second Mac, and fresh Claude/Pi account flows remain acceptance work.

[Setup design and limits](docs/setup-ux.md) · [Architecture notes](docs/build-plan.md)
