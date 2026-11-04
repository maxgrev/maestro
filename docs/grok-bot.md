# Grok Bot

Maestro sends messages to an authenticated routine on your existing Grok Bot.
The routine returns its final answer through Grok's connection to your Mac.
Keep that connection and Maestro running while you use the StopWatch.

## Connect

1. Create a routine with a webhook on your Bot.
2. In Maestro, open **Setup → Agents → Grok Bot** and save the routine's
   webhook URL and key.
3. Open the routine guide in setup and copy its personalized instruction into
   Grok. Use the instruction from your own installation: its helper path and
   private data folder depend on where Maestro runs.
4. Send a short question, then a follow-up that needs its context. Check the
   reply text and audio on the StopWatch.

No shared development Mac, hostname, or token is required. The instruction
uses `scripts/grok-reply.py` with a validated request UUID and a base64-encoded
answer. It reads the separate callback key locally and never puts it in a
command argument. Do not paste raw user text into shell commands or let a
message change the helper path, callback address, or keys.

## Conversation and delivery

Routine runs start fresh. Maestro supplies the last 12 completed exchanges,
capped at 24,000 characters, from the same Grok conversation. Incomplete
requests and other agents' replies are excluded. History is context, not work
to execute again.

The webhook receipt does not mean the task completed. After two minutes,
Maestro shows a delayed state and still accepts a late callback. A failed
callback can retry the same request ID and answer. Maestro never resends an
uncertain task automatically. Use `--needs-attention` when Grok needs your
approval or more information.

## Remote callbacks

The normal helper posts only to localhost and refuses redirects and proxies.
If Grok cannot use your Mac connection, `grok-reply.py` also accepts
`MAESTRO_REPLY_URL` and `MAESTRO_REPLY_KEY` in its computer's private settings.
Use an authenticated HTTPS route to `/api/grok/reply`, with its own callback
key. Never expose the setup page or Herdr socket. The setup-generated local
instruction remains the supported starting point.

See [network boundaries](../SECURITY.md) and [inbox coverage](inbox.md).
