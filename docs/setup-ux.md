# Setup after the MVP

Goal: someone with no coding experience can connect the StopWatch and talk to their agents. They should not need a terminal, token file, IP address, or firmware build.

Keep one guided flow in the Mac app:

1. **Connect your StopWatch.** Detect the supported board over USB, save a recovery image, install a signed release, and show progress with a safe retry.
2. **Connect to Wi-Fi.** Ask once, send credentials directly to the device, and verify that the device can reach the Mac. Discover the Mac on the local network so an IP change does not require flashing again.
3. **Connect your agents.** Show installed agents and the account steps each one needs. Use supported account links and existing sessions. Keep provider keys out of the main flow where provider APIs allow it.
4. **Try one message.** Confirm the microphone, selected agent, reply, and speaker. Report which step failed and give one next action.

What this setup exposed:

- Adding a Muse token must update an existing build, not just its defaults. Fixed in the build script.
- Muse's current SDK uses its phone app for device discovery and account pairing. Developer mode and Bluetooth permission are current prerequisites. Keep the provider's account consent and physical pairing confirmation; explain them at the right time.
- The first Muse pairing attempt disconnected after device confirmation. A fresh discovery attempt completed setup. Show pairing progress and offer a clear retry that preserves existing Wi-Fi settings.
- Grok routine runs start fresh. Maestro now supplies recent context from its saved receipts. Keep this behavior out of setup choices.
- Grok replies can use its existing Mac connection. A public tunnel is unnecessary on this Mac.
- A connected USB cable does not grant control of an iPhone. iPhone Mirroring needs the user's local authentication. This is a development aid, not part of the product setup flow.

Do not hide an unfinished connection behind a green indicator. Show **Ready** only after a real request and reply. Keep recovery available, preserve provider approval rules, and never resend uncertain actions automatically.

Muse account pairing and the physical voice loop passed on October 9, 2026. Finish the same physical voice checks for Grok and coding agents before packaging the guided flow. A new orchestration framework or cloud service is not required for these improvements.
