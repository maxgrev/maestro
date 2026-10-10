# Voice and portable access

Maestro should work over another Wi-Fi network or a phone hotspot. The current build still reaches the Mac over the local network. The changes below improve the existing voice path; they do not enable remote access.

## What we measured

Measured on this Mac on 2026-10-09. These are individual checks, not percentile claims or service guarantees.

| Stage | Result |
| --- | --- |
| Local transcription of a 2.5-second synthetic recording | 651 ms |
| Coding-agent discovery | 290 ms |
| Grok text submission accepted by Maestro | 67 ms |
| Grok routine returns a one-word reply through its Mac helper | 30.12 seconds |
| First audio for that reply, with the model already loaded | 461 ms |
| Same longer TTS phrase, old process per request | 1,624 ms; 1,238 ms |
| Same phrase, persistent worker | 1,349 ms cold; 323 ms and 339 ms warm |

The device also polls for the completed result once a second. Network upload and device buffering are outside the local speech measurements.

Grok's routine/return-helper path dominated this check. Changing the codec or voice engine cannot remove that delay. A live voice layer could acknowledge a request promptly while the bot works, but must not imply the bot has finished.

## Changes in this build

The local Kokoro model now loads while transcription or the agent runs, and remains loaded for later PCM replies. Audio still streams as it is generated. A cancelled or failed stream discards its worker; the next request starts cleanly. Mac app shutdown stops it. The browser's MP3 preview keeps its existing one-shot encoder.

Grok submissions no longer wait for local coding-agent discovery. Request IDs, durable receipts, exact session matching, and the no-resend rule stay in place. No request is sent to an agent before its final transcript is known.

## Reuse options

| Option | Useful part | What it does not solve |
| --- | --- | --- |
| [ESP32 Deepgram Voice Agent](https://github.com/dg-edcharbeneau/esp32-deepgram-voice-agent) | Apache-2.0 project with device-to-cloud audio over one WebSocket, audio queues, cancellation, and phone-based Wi-Fi provisioning. | It targets a different board. Its generic LLM session is not a connection to an existing personal bot. Port the relevant components, not its firmware image. |
| [Deepgram Voice Agent](https://developers.deepgram.com/reference/voice-agent/voice-agent) | Streaming recognition, speech, turn handling, and function calls. [Custom LLM endpoints](https://developers.deepgram.com/docs/voice-agent-llm-models) can preserve an agent adapter. | Requires provider credentials and usage billing. An adapter that waits for Grok's routine still waits for Grok. |
| Codex app-server real-time API | The installed binary exports experimental `thread/realtime/start`, `appendAudio`, output-audio notifications, and voice enumeration. These can address a specific Codex chat. | An isolated read-only connection check returned `realtime conversation requires API key auth`. The current ChatGPT sign-in did not authorize this path. Starting a session returned `{}` before the later error; the start acknowledgment alone is not proof of a working call. |
| [OpenAI voice APIs](https://developers.openai.com/api/docs/guides/audio) | Realtime speech-to-speech, or streaming speech around an existing text agent. | API access is separate from simply having desktop Voice enabled. Do not silently replace a selected Codex session with a generic model. |
| [xAI voice API](https://docs.x.ai/developers/model-capabilities/audio/voice) | Direct streaming Grok voice. | This is not evidence of access to the user's existing Grok Bot, its files, memory, or routine. Keep those identities distinct. |
| [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel) | A stable HTTPS route to an existing Mac service without port forwarding. | The Mac must stay online. Funnel's public endpoint still needs Maestro authentication. A Tailscale account and sign-in are required. |

## Smallest next step

If the Mac can remain online at home, add guided remote access through a stable tunnel and provision its HTTPS address to the StopWatch. Expose only the authenticated device API. Never expose the unauthenticated localhost setup listener, disable certificate verification, or use a temporary tunnel URL as a saved connection. Keep the tunnel lifecycle in the Mac app and show whether it is connected. Add phone-based Wi-Fi setup so a new network does not require a computer. For Grok, test whether the routine can return directly to that authenticated HTTPS endpoint from its cloud computer; this could remove the Mac tool-execution hop. Verify outbound requests and credential storage before changing the routine.

If the Mac must be off, the agents that currently run there need an always-on host or a supported cloud connection. A cloud voice service alone does not move those sessions, local files, or permissions. Keep Muse's SDK path; use direct cloud voice only where the provider exposes the required agent identity and account access. Start with one provider before adding a relay service or a general plugin system.

For either path, stream microphone audio while the button is held, keep the connection open, and start speech from complete answer sentences when the provider exposes them. Never speak tool logs or provisional text as a finished answer. Keep interrupt, text-reader, mute, and error behavior consistent across providers. PCM is already supported by the hardware and candidate services; add Opus only if measured bandwidth or battery use warrants it. MQTT is not needed for this audio path.
