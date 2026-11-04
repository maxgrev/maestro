# Dot

Maestro connects to your existing ChatGPT Dot through an OAuth-authenticated MCP plugin and [MCP Events](https://developers.openai.com/plugins/build/mcp-events). Dot appears separately from Codex in the agent picker, with spoken replies and saved inbox messages.

## Connect

1. Enable **Setup → Wi-Fi → Away from home**. Keep Maestro and Tailscale running on this Mac.
2. Open **Setup → Agents → Dot → Connect Dot**. Choose the name shown on the watch and start setup.
3. In ChatGPT, open **Plugins → + → Add custom MCP server**. Name it Maestro, paste the address from setup, and choose OAuth. Leave client credentials blank. Approve the connection on this Mac, then finish installing the plugin in ChatGPT.
4. Copy the setup message into your existing Dot conversation. Dot subscribes to Maestro messages. Setup shows **Connected** after its callback verifies.

Select Dot on the StopWatch and hold yellow to talk. The bridge sends your transcript to Dot; Dot returns a complete answer through `reply_to_maestro`. The current voice and inbox handle it like other replies. Ask Dot to send a result from other work to Maestro when you want an inbox update. That uses `notify_maestro` and does not interrupt another agent’s conversation.

## Scope and delivery

The plugin can read messages addressed to Dot, return replies to those requests, and send requested updates. It cannot read other agents’ conversations, operate the device, change setup, or run Mac commands. Dot’s own tools and permissions still apply. Access tokens expire after one hour; rotating refresh tokens last up to 30 days. **Disconnect Dot** revokes the connection. Account and workspace plugin controls may limit availability.

Requests and pending deliveries live in the existing private SQLite database. Delivery uses signed HTTPS callbacks, verified before activation. Retries retain the event ID; reply IDs prevent duplicate inbox alerts. A reply delayed more than ten minutes shows an uncertain state and still accepts a late answer. Check Dot before repeating a task. After a bridge restart, pending deliveries can retry; Dot’s setup instruction tells it to check the stored request and avoid repeating completed work.

Callback addresses must belong to ChatGPT or OpenAI, resolve to public addresses, and pass TLS verification. Redirects are not followed. The plugin has its own OAuth scope and cannot use the device or Grok callback keys. Setup and consent stay on localhost; only the MCP and OAuth endpoints join the existing public device origin.

MCP Events requires protocol `2026-07-28`. The stable TypeScript SDK handles OAuth and legacy tool requests; a small separate dispatcher implements modern discovery, tools, and events until the stable SDK supports them. Event settings use the plain object/string schema from OpenAI’s example: ChatGPT rejected the first generated schema with its `const` field and draft declaration. Runtime validation still restricts subscriptions to `dot`. Rescan the plugin after changing event definitions. Protocol details follow the [official MCP server guide](https://developers.openai.com/plugins/build/mcp-server) and [authorization guide](https://developers.openai.com/plugins/build/auth).

The live check on October 9, 2026 completed OAuth, activated a verified callback, sent a message, received Dot’s answer, generated speech, and displayed the saved answer on the StopWatch. Dot’s text reply took 40.9 seconds; local speech generation took 0.88 seconds. This event-based path is not yet fast conversational voice. It does not stream Dot’s partial answer or audio.

This version still needs the Mac for speech, delivery, and inbox storage. It does not add cloud hosting or Mac-off support.
