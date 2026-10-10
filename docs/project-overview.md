# Maestro project overview

Current as of October 10, 2026. See the [README](../README.md) for setup, development commands, and pending work.

- **Maestro is a handheld voice remote for your agents.** Choose a conversation, hold a button to talk, and hear or read the answer. Coding agents and daily companions share one device, with separate conversations and an inbox.

- **The hardware is the M5Stack StopWatch C152, powered by an ESP32-S3.** We use its round touchscreen, microphone, speaker, physical buttons, vibration motor, Wi-Fi, battery, and USB connection.

- **The stack has three main parts:**

  - **Device firmware:** C/C++ on ESP-IDF and FreeRTOS, with LVGL for the interface. We extend the official Muse Gadget SDK, which already supports the board.
  - **Mac app:** Swift, AppKit, and WebKit around a local HTML/CSS/JavaScript interface. It starts the bridge, stays in the menu bar, and prevents idle sleep while running.
  - **Bridge:** TypeScript on Node.js, Fastify for HTTP endpoints, and SQLite for requests, replies, delivery state, and the inbox. Python helpers handle speech and USB provisioning.

- **We connect each agent through its existing tools:**

  - **Codex:** Herdr starts or connects to coding sessions. Codex's read-only app-server API supplies complete final answers from the selected conversation.
  - **Claude Code:** Herdr manages sessions; Claude's official SDK reads replies from the matching conversation.
  - **Pi:** Herdr manages sessions; its native session files supply completed answers from the active branch. Provider sign-in or API keys are still required.
  - **Muse:** the official Gadget SDK connects to your paired Muse agent. It keeps its native connection and animation.
  - **Grok Bot:** an authenticated routine receives requests. Grok returns answers through a helper on its existing Mac connection. Maestro carries recent conversation history between routine runs.
  - **Dot:** a separate connection to your existing ChatGPT Dot through an OAuth-authenticated MCP plugin and signed message events. Dot can answer device requests and send requested inbox updates.

- **The usual voice flow is straightforward.** The watch records while you hold yellow. Releasing uploads the recording to the Mac, where whisper.cpp transcribes it. The bridge sends the transcript to the selected agent, retrieves its final answer, saves it, and streams synthesized speech back to the watch. Muse uses its native SDK path.

- **Speech runs locally on the Mac.** Transcription uses whisper.cpp's multilingual base model. Spoken replies use Kokoro through ONNX Runtime, with Heart, Bella, Michael, and Emma available in setup. The original macOS Samantha voice remains optional. Audio uses 16 kHz PCM, plus MP3 where Muse's decoder needs it. We have not added MQTT or Opus.

- **Setup is one guided Mac flow:** connect the device, install firmware, configure Wi-Fi, connect agents, and try a message. It includes voice previews, project-folder selection, and remote-access setup. The Apple Silicon app bundles its runtimes and speech model, so normal use does not need a terminal.

- **The device controls now serve the whole interface.** Yellow records or confirms; blue opens agents or moves down; holding blue opens settings or goes back. Touch handles selection and scrolling. Tap reply text to expand it, then scroll or page with the buttons. Muted replies open the reader automatically.

- **The interface uses a consistent retro pixel style.** Bitmap fonts, pixel controls, fixed-size list rows, character portraits, and chat-title subtitles cover the picker, inbox, settings, and reply reader. Muse retains its native artwork. Claude uses Clawd Tank animations; Codex uses its blue companion; Pi keeps its three-color identity; Dot wears sunglasses on a mint diamond; Grok keeps its round body and simple face. Characters react to listening, thinking, speaking, errors, and other supported states. [Character sources and licenses](../firmware/src/avatars/SOURCES.md) record where the art came from.

- **The inbox preserves replies across agent switches.** Multiple agents can keep working while you talk to another. Completed replies collect unread badges, and nearby completions share a vibration alert after the current interaction ends. Background replies do not switch agents, open screens, or start speaking.

- **Work started elsewhere can reach that inbox.** Maestro watches supported local Codex, Claude, and Pi sessions, receives Muse events, accepts Grok notifications, and exposes a notification tool to Dot. Coverage depends on the connection: it does not scan every cloud conversation or every computer. The [inbox notes](inbox.md) describe each provider's coverage and delivery limits.

- **Read status syncs where providers expose enough information.** Reading in Maestro on the Mac clears watch badges. Codex desktop read changes also sync. Continuing a Claude or Pi conversation clears earlier replies on that branch. Reading inside Muse, Grok Bot, or Dot cannot yet clear Maestro badges through their current connections.

- **Replies support Markdown.** The Mac renders it with Marked. The watch uses MD4C to make headings, lists, links, code, and tables readable within its small display; its bitmap font does not add bold or italic faces. The watch reader supports up to 64,000 bytes per reply; longer answers remain available on the Mac.

- **We removed several sources of delay.** Fixed-size rows and paused hidden animations raised measured list scrolling from roughly 5–6 to about 31 frames per second. Inbox requests reuse a TLS connection and run separately from audio. Kokoro stays loaded between replies, warms while other work runs, and streams audio as it generates it. Agent startup, reasoning, tools, and callback delivery still account for much of the voice delay; reusing a conversation helps. The [UI measurements](pixel-ui.md) and [voice measurements](voice-and-portability.md) include the conditions and limits of those checks.

- **It works away from the Mac through Tailscale Funnel.** The watch can use another Wi-Fi network or a phone hotspot while the Mac stays home. The tunnel exposes authenticated device endpoints and Dot's scoped connection; setup stays local. The watch currently remembers one Wi-Fi network, and changing it requires USB provisioning. The public relay has been tested; a separate phone-hotspot trip remains untested.

- **Delivery and recovery are built in.** SQLite preserves requests and replies across restarts. IDs prevent duplicate receipts, session checks reduce wrong-conversation replies, and uncertain requests are not blindly resent. Late callbacks remain accepted. Firmware installation verifies a recovery backup before writing, and personal credentials stay out of the generic firmware and Git.

- **The current build is installed on the development StopWatch and saved in the private repository.** The Mac still needs to remain powered, online, and running Maestro; Grok also needs its Mac connection. Mac-off operation, phone-based Wi-Fi setup, full-duplex voice, and speaking before an agent finishes its answer remain future work. Pi's live account check, clean second-Mac setup, battery-life measurement, and human listening checks remain pending. Public distribution still needs signing, notarization, and bundled-asset licensing review.
