# Guided setup

Goal: someone with no coding experience can connect the StopWatch and talk to their agents. They should not need a terminal, token file, IP address, or firmware build.

The Mac app now runs this flow:

1. **Connect your StopWatch.** Detect the board over USB, save a recovery image for its chip MAC, verify checksums, and install generic firmware. Show each operation's progress. A retry requires a new click.
2. **Connect to Wi-Fi.** Ask once, send credentials directly to the device, and verify that the device can reach the Mac. Discover the Mac on the local network so an IP change does not require flashing again.
3. **Connect your agents.** Show installed agents and the account steps each one needs. Reuse provider login commands and existing sessions. Install pinned official coding-agent packages in the app's data directory. Send the Mac's URL, pin, device token, and Muse SDK token over USB; never compile personal credentials into the image.
4. **Try one message.** Show the verified device, Wi-Fi, Mac connection, and Muse pairing states. Open the device's agent picker, explain the buttons, and prompt the user to try a message. This step does not claim a voice test passed just because a connection exists.

What this setup exposed:

- Adding a Muse token now updates NVS over USB. The firmware reads it through the SDK's identity hook and reboots after an atomic save. The cached build configuration also receives every explicit Maestro override, so a new option cannot silently stay disabled.
- Muse's current SDK uses its phone app for device discovery and account pairing. Developer mode and Bluetooth permission are current prerequisites. Keep the provider's account consent and physical pairing confirmation; explain them at the right time.
- The first Muse pairing attempt disconnected after device confirmation. A fresh discovery attempt completed setup. Show pairing progress and offer a clear retry that preserves existing Wi-Fi settings.
- Grok routine runs start fresh. Maestro now supplies recent context from its saved receipts. Keep this behavior out of setup choices.
- Grok replies can use its existing Mac connection. A public tunnel is unnecessary on this Mac.
- Codex's folder-trust prompt needs an explicit choice in project setup. Save that choice for the exact folder and retain normal tool approvals. Pass the path as a TOML table because Codex's command-line dotted-key parser does not handle quoted paths.
- A connected USB cable does not grant control of an iPhone. iPhone Mirroring needs the user's local authentication. This is a development aid, not part of the product setup flow.

Do not hide an unfinished connection behind a green indicator. Show **Ready** only after a real request and reply. Keep recovery available, preserve provider approval rules, and never resend uncertain actions automatically.

The device has two programmable buttons and a power button. Yellow handles talk, pairing confirmation, and menu selection. Blue opens and steps through agents. From the home screen, holding blue or swiping left opens the same SDK settings page. In a menu, holding blue goes back. Blue focuses the next control; yellow selects, toggles, or steps a slider. Touch uses the same controls. Volume and mute live under Sound. The character identifies the agent, with a small title for coding sessions. A short vibration confirms a choice. The firmware remembers the selected identity, verifies it after reconnecting, and refuses unavailable sessions instead of falling back to a different agent.

The device UI audit checked native 466-pixel captures of home, agents, settings, Sound, and the thinking state. It caught clipped bottom rows; the final layout keeps whole rows visible at rest and scrolls the focused control into view. Button events use a small queue so quick presses keep their order during redraws. USB checks exercised navigation, speaker switching, saved volume, and menu transitions, then restored the original values and agent. The Mac guide uses the same button positions and controls. Finger swipes and the physical feel of long-press still need an in-hand check; the guide was checked in the desktop app, not at phone or tablet sizes.

Characters identify providers through shape as well as color. Muse retains its SDK character; the others use the same canvas, frame timing, and reply layouts. Expression follows real voice state. No extra animation engine or image download is needed.

Agents → Voice offers four local Kokoro voices and the previous macOS voice. Preview works before saving, and the saved choice applies to the next reply. Conversation playback has Cancel and Stop controls. The native app audit checked previews, voice selection, saved settings, playback cancellation, and provider characters. It caught an oversized Grok list icon and a false Ready label for agents awaiting sign-in; both were fixed. Phone and tablet layouts and reduced-motion rendering still need a browser check; the browser tool could not inspect its stale error tab. The app currently has one dark theme.

The bridge stopped between development sessions, which made the original device appear Muse-only. The Mac app now owns the bridge process and stays alive when its window closes. It reuses an existing bridge if one already owns the ports. The device retries discovery after Wi-Fi connects and shows a Mac-offline message when needed.

Still required before a broad release: Developer ID signing and notarization, a clean second-Mac test, bundled-license distribution review, fresh Claude/Pi sign-in checks, human speaker-quality and battery tests. Muse's phone app and Grok's routine UI still own their account and consent steps. Do not advertise fully automatic provider setup or arbitrary existing desktop-chat access.
