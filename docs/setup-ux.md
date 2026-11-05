# Guided setup

The setup flow serves a StopWatch C152 owner on an Apple Silicon Mac. The
signed app supplies its tools and firmware; source users first run
`scripts/bootstrap.sh` as described in the README.

## Device

Detect ESP32 USB devices and ask the user to confirm the StopWatch model.
Before writing, verify the chip's identity, 16 MB flash, generic firmware
manifest, and that board's recovery image and checksum. Show progress and
retain the backup. Retry only on a new user action.

Source bootstrap builds the firmware before it starts the bridge. If the
firmware files are missing, setup shows how to build them or reinstall the
downloaded app. It must not hide the missing step without an explanation.

## Wi-Fi

Save a 2.4 GHz network or phone hotspot over USB. Away from home guides the
user through installing and signing in to Tailscale, then verifies the public
device endpoint before saving its address. Do not replace another Tailscale
service. Local-only use keeps the Mac's pinned certificate.

The watch remembers one network. Explain when a save replaces it. Never
expose setup's localhost port 4210 through a tunnel.

## Agents

Every agent is optional. Keep provider consent, account sign-in, and tool
approvals with that provider. Install coding agents in Maestro's data folder
using the bundled npm in the app or the npm that launched the source bridge.
Never change the user's global package installation.

Project selection names an existing folder. Codex trust applies to that exact
folder and needs an explicit user choice. Changing folders clears that trust.
Muse pairing uses its phone app and a personal SDK token. Grok setup supplies
a helper command tailored to the current install. Dot has its own scoped
plugin connection and requires remote access.

Save the Mac address, certificate pin or public TLS mode, device key, and
optional Muse token over USB. Generic firmware contains none of these values.

## Try it

Show the verified USB, Wi-Fi, bridge, and pairing states. Opening the agent
picker is a connection check; a real voice request and answer are a separate
acceptance check. Do not label an unchecked integration Ready. Missing or
busy saved conversations stay unavailable rather than changing recipients.

The watch's yellow button records or confirms. Blue opens or advances menus;
holding blue opens settings or goes back. Touch uses the same controls.
Volume and mute live under Sound. Agent characters and title text identify
the recipient. Tap reply text to expand the reader.

## Verification

Automated tests cover concurrent setup writes, secret-free status, explicit
flash confirmation, reply isolation, folder trust, and failed-write handling.
The renderer test checks every agent and mode against full redraws, including
clipped display strips, with address and undefined-behavior sanitizers.

The Mac companion opens Conversations with a resizable list and an Unread
filter. Setup and Settings use separate screens with a clear route back.
Its graphite and sage palette follows the system appearance, with saved light
and dark options in Settings. Native window chrome, readable forms, and the
StopWatch's character art tie the screens together. Keep headings and action
labels direct. Omit taglines and repeated subtitles. Keep short field help
beside its field; use disclosures for optional controls, not single-line tips.
Credits live in Settings and the native Help menu. Keep trust and account
consent details visible at the relevant action.

Setup keeps the next action clear. Firmware updates, saved network changes,
and remote access use disclosures. A verified saved Wi-Fi network can continue
without entering it again. Conversations keeps saved history visible when a
session needs connecting, with a connection action beside the reply box.
See [the UI audit](ui-polish-audit.md) for the current interaction checks.

Test changed setup states at desktop, tablet, and phone widths, with keyboard
focus and reduced motion. Keep keyboard focus after saves and when returning
from a reply. The watch retains its fixed display and dark pixel theme.
Physical button feel, finger
gestures, speaker quality, battery life, and a fresh second-Mac install need
in-hand testing. Record those checks for each release rather than carrying
old results forward as proof.
