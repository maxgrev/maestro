# Voice and portable access

Maestro now has guided remote access through Tailscale Funnel. The Mac can remain online at home while the StopWatch uses another Wi-Fi network or a phone hotspot. Tailscale sign-in and its HTTPS/Funnel approval are account steps; Maestro verifies the resulting connection before offering to save it over USB.

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

Network upload and device buffering are outside the local speech measurements. As of October 10, the device holds each result request for up to one second and the bridge releases it immediately when the answer completes. It no longer adds a fixed one-second sleep between successful polls. Older bridges and network failures retain a bounded request rate.

### October 10 comparison

The same request asked each agent for “Ready when you are,” without tools or file changes. These are single samples measured from the Mac bridge, not full microphone-to-speaker timings or a model leaderboard.

| Agent | Existing test session | New test session | First speech chunk after answer |
| --- | ---: | ---: | ---: |
| Claude Code | 2.37 s | 6.89 s | 0.21 s |
| Codex | 2.99 s | 10.91 s | 0.74 s |
| Grok Bot | 15.84 s | — | 0.24 s |
| Dot | 24.47 s | — | 0.24 s |
| Muse | Not measured in this comparison; it uses the native SDK voice route | — | — |
| Pi | Not connected | — | — |

Claude was fastest in this check. Reusing a coding session avoids startup work. Grok and Dot use background task delivery followed by a reply callback, so a short message still crosses that extra task path. The first Grok attempt failed to return within two minutes because its Mac connection was offline. Restarting the existing Grok Bot app restored the link, and it delivered the original pending reply without repeating the task. The 15.84-second result is a separate healthy check after reconnection; the outage is not part of that timing.

The reply-wait change removes up to one second of polling delay, not the agent's thinking or tool time. The largest next improvement for long answers is to speak complete answer sentences while generation continues, where the agent exposes them. Streaming recognition while the talk button is held can hide transcription and upload time. [Deepgram's voice pipeline](https://developers.deepgram.com/docs/voice-agent) provides those building blocks over one WebSocket, but plugging it around an existing background agent cannot remove that agent's own queue and callback delay. Keep the selected agent's identity, history and permissions intact.

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

## Portable access

The Wi-Fi step detects Tailscale and guides installation, sign-in, account approval, enabling, verification, and disabling. Tailscale owns the persistent tunnel and certificate renewal; Maestro owns the authenticated loopback origin. Closing Maestro's window keeps it running. Quitting stops the origin, and the app's idle-sleep assertion ends. Leave a MacBook powered with its lid open; an idle-sleep assertion cannot override lid sleep or a shutdown.

The remote origin uses `127.0.0.1:4212`; its routes match the device API and require its bearer key. The unauthenticated setup listener on `127.0.0.1:4210` stays private. Before saving the address, Maestro checks anonymous rejection, an authenticated health response, and the absence of setup routes. It does not follow redirects or accept invalid TLS. The device uses ESP-IDF's public CA bundle; existing home connections retain their certificate pin. Only URLs obtained from this Mac's running Tailscale node can be saved. An outage retains the saved address. Enabling never resets another service's Tailscale configuration.

The checks resolve the address through public DNS and connect to the Funnel relay. Tailscale's private DNS can make the Mac reach itself before the public address works; that route cannot prove readiness. [Public DNS may take up to ten minutes](https://tailscale.com/docs/features/tailscale-funnel#dns-propagation) after enabling Funnel. A failed check leaves the saved address unchanged.

Live checks on October 9, 2026 confirmed anonymous HTTP 401, authenticated health and agent discovery, setup HTTP 404, and a complete 67,584-byte PCM reply through the public relay. The physical StopWatch connected with public certificate validation, loaded seven agent entries, and kept Grok Bot selected. Its Wi-Fi and Muse pairing stayed intact. These checks used the public route from the home network; a separate phone-hotspot trip has not been tested.

For travel, save a phone hotspot once over USB. [Apple's Maximize Compatibility setting](https://support.apple.com/en-ca/guide/security/secfd166f620/web) selects 2.4 GHz on current iPhones. The device currently remembers one Wi-Fi network. Phone-based Wi-Fi provisioning remains a follow-up so a new network does not need a computer.

For Grok, test whether the routine can return directly to the authenticated HTTPS endpoint from its cloud computer; this could remove the Mac tool-execution hop. Verify outbound requests and credential storage before changing the routine. Remote access alone does not reduce its measured 30-second routine latency.

If the Mac must be off, the agents that currently run there need an always-on host or a supported cloud connection. A cloud voice service alone does not move those sessions, local files, or permissions. Keep Muse's SDK path; use direct cloud voice only where the provider exposes the required agent identity and account access. Start with one provider before adding a relay service or a general plugin system.

For either path, stream microphone audio while the button is held, keep the connection open, and start speech from complete answer sentences when the provider exposes them. Never speak tool logs or provisional text as a finished answer. Keep interrupt, text-reader, mute, and error behavior consistent across providers. PCM is already supported by the hardware and candidate services; add Opus only if measured bandwidth or battery use warrants it. MQTT is not needed for this audio path.
