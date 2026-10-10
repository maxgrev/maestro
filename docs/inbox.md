# Inbox

Open **Agents → Inbox** on the StopWatch, or **Inbox** in the Mac app. Each row shows the agent’s character, conversation, and a reply preview. Tap a row or select it with yellow to read the complete answer. Blue moves down; hold blue or tap Back to return. Older replies have their own next page.

Unread counts appear beside conversations and on the home list icon. Opening a reply marks only that reply as read. Reading on the Mac clears the same badge on the watch. Switching agents loads that conversation’s latest saved reply without playing it. Starting a new message clears the home preview but keeps the saved reply in the inbox.

Nearby completions share a 160 ms vibration. The watch waits at least two seconds after the last arrival and for a quiet gap after listening, waiting for an answer, speaking, reading, or using a menu. While the inbox is configured, Wi-Fi and the Muse subscription remain available when the screen sleeps. Screen and audio power saving stay enabled, but battery life still needs measurement. Notifications never wake the display, open a page, change agents, or play speech. Mute controls speech; completion vibration remains enabled.

## Work started elsewhere

- **Dot:** ask your connected Dot to send a result or question to Maestro. Its scoped `notify_maestro` tool adds one receipt per update ID without changing the active conversation. This is a requested Dot action, not a scan of all ChatGPT history.
- **Codex:** final answers from local desktop, CLI, editor, and batch sessions. Maestro reads the official app-server API. It never resumes the session or grants tool approval. Child-agent turns are excluded to avoid duplicate reports from the same task.
- **Claude Code:** final text from local sessions through the official session reader. Tool narration and thinking blocks are excluded.
- **Pi:** completed replies on the current branch of its local v3 session files. Abandoned branches and incomplete writes are excluded.
- **Muse:** complete messages from the existing SDK subscription, including while another agent is selected. The watch must be connected when Muse sends the event; the SDK does not provide a durable history catch-up here. Pending forwards retry while the watch remains on, but are not stored across a device restart.
- **Grok Bot:** the main Bot has a saved instruction to call the existing reply helper with `--notify` for external work. This is an agent-followed instruction, not a guaranteed provider event hook. Other Grok bots need the same instruction separately. If its Mac connection is offline, retry waits until the Bot next runs. The live external callback was verified.

External coding sessions appear as **Saved replies** in the picker. They can be read, but sending into them still requires an attached Herdr session. Local discovery does not cover agents running on another computer or an unconnected cloud account. It scans about every five seconds; the watch polls about every three seconds on a separate inbox worker. Reading and collection continue during playback; vibration waits for quiet.

Monitoring starts when this version first runs. Existing Maestro history imports as read; unrelated old agent history does not flood the inbox. Supported coding-session timestamps allow the next scan to collect completions that happened while Maestro was stopped. Very large or unreadable sessions report a provider warning on the Mac inbox.

## Storage and delivery

The inbox shares Maestro’s existing SQLite database. Provider message IDs deduplicate retries and the foreground reply reader. A request result and its inbox receipt commit together. Explicit receipt IDs keep an acknowledgement from clearing a reply that arrives during the request. Read and alerted state survive app restarts. A late Grok answer remains a new unread receipt after an earlier delivery warning.

The watch keeps only a page of summaries and one reader snapshot in external RAM. Full history stays on the Mac. Replies above 64 KB show their first 64 KB on the watch and a note to continue in the Mac inbox. An open inbox reader cannot be overwritten by a background reply. A view ticket rejects late page loads after navigation. The existing authenticated device API carries inbox traffic through the same home or Tailscale connection; the setup UI remains local.

Inbox requests reuse one verified TLS connection through ESP-IDF's HTTP client. Taps wake the inbox worker immediately and take priority over pending acknowledgments and status polling. A failed acknowledgment cannot block a later read. Audio uses its own connection, so loading an inbox page does not wait for an agent or a spoken answer to finish.

A vibration is best effort across device power loss: if power drops between vibrating and the Mac receiving its acknowledgement, the batch may alert once more after reconnecting. No reply is deleted by an alert. While running, a local high-water mark prevents repeated vibration if the acknowledgement needs a retry.
