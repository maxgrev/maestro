# Maestro overview

Maestro connects an M5Stack StopWatch C152 to agents through an Apple Silicon
Mac. Choose a conversation, hold yellow to record, then release. Read or hear
the answer and return to saved replies in the inbox.

## Parts

- **Firmware:** C/C++, ESP-IDF, FreeRTOS, and LVGL on the ESP32-S3. Maestro
  extends the pinned Muse Gadget SDK for this board's microphone, speaker,
  display, touch, buttons, power, and pairing. It preserves the native Muse
  animation and original Codex companion. Their artwork has separate rights
  from Maestro's own code; see the character sources and third-party notices.
- **Mac app:** Swift, AppKit, and WebKit around local HTML/CSS/JavaScript. It
  runs the bridge, keeps a menu-bar item, and prevents idle sleep while open.
- **Bridge:** TypeScript on Node.js with Fastify and SQLite. It stores
  requests, replies, inbox items, and delivery state. Herdr manages coding
  sessions; provider readers retrieve final answers.
- **Speech and USB:** whisper.cpp transcribes locally. Kokoro and ONNX
  Runtime generate speech. Python handles speech and USB provisioning; LAME
  encodes MP3 when Muse's decoder needs it.

## A voice request

For bridge-backed agents, the watch records 16 kHz mono PCM while yellow is
held. On release, it uploads the recording with a stable request ID and the
selected target. The Mac transcribes it, dispatches to that conversation,
retrieves its final answer, saves it, and streams local speech to the watch.
Muse retains its SDK voice transport and phone pairing.

Codex, Claude Code, and Pi use Herdr sessions. Grok Bot uses a routine webhook
and its existing Mac connection to return a reply. Dot uses a scoped OAuth MCP
plugin and signed events. Accounts, subscriptions, and tool approvals remain
with the providers. [Agent prerequisites](../README.md#set-up-the-stopwatch)
and the provider guides explain the supported paths.

SQLite preserves receipts across restarts. Repeated request IDs do not cause
automatic redispatch. Missing or ambiguous replies show an uncertain state;
the bridge accepts late callbacks without repeating the work.

The watch and Mac share an inbox. Background replies update badges and group
vibration alerts after the active interaction ends. They never switch the
active agent or start speech. [Inbox notes](inbox.md) describe external-session
collection and the limits of provider read-status sync.

## Scope and limits

The release supports StopWatch C152 and Apple Silicon macOS 14+. The Mac must
stay powered and online. Tailscale Funnel can connect a watch on another
network to the Mac's authenticated device listener. Wi-Fi changes still need
USB, and the watch stores one network.

Recording upload starts on release. Agent replies finish before speech starts.
Mac-off operation, full-duplex voice, wake words, phone Wi-Fi setup, and other
boards remain future work. Live Pi sign-in, second-Mac setup, battery life,
and human speaker checks remain acceptance work.

See [setup](../README.md), [architecture](build-plan.md),
[security](../SECURITY.md), [licenses](../THIRD_PARTY_NOTICES.md), and
[release instructions](releasing.md). The measurement notes describe earlier
development checks, not acceptance results for every later build.
