# Migrating from 0.3.x to 0.5.0

TRAECNclaw 0.5.0 freezes MCP contract version 5 and repairs the distribution,
configuration, persistence, and security boundaries that changed throughout
the 0.4.x series.

## Installation source

Do not keep the `traecnclaw` npm package pinned to version `0.3.1`. Until a 0.5.0 npm artifact
has actually been published, install from the canonical GitHub release or a
source checkout and point the MCP client at `mcp-server.js` (or the bundled
Skill launcher). The repository does not claim an unpublished registry
artifact is available.

## MCP contract

Remove `TRAECN_MCP_TOOL_PROFILE` and all `public`, `ops`, or `full` profile
selection. There is one ordered 20-tool Agent surface:

- prepare context only when needed with `traecn_open_workspace`,
  `traecn_select_model`, `traecn_select_mode`, and conversation tools;
- submit once with `traecn_send_message`;
- let the gateway own queueing, waiting, recovery, routine approvals, and
  durable notifications;
- use `traecn_get_task` only for an intentional read, not a polling loop.

Removed low-level command, preflight, wait, recovery, event-acknowledgement,
and proof tools are operator/maintainer functions, not Agent MCP tools.

## MCP protocol revision

TRAECNclaw 0.5.0 supports the stable MCP `2026-07-28` revision and remains
compatible with initialization-based `2025-11-25` and `2024-11-05` clients.
These date-based revisions are distinct from TRAECNclaw MCP contract version 5.

Modern clients should probe with `server/discover` and include
`io.modelcontextprotocol/protocolVersion` plus client capabilities in each
request's `_meta`. Results include `resultType`, structured tool content,
server identity metadata, and cache hints where required. Legacy clients keep
using `initialize`; unsupported legacy versions negotiate to `2025-11-25`
instead of being echoed back unchecked.

Replace custom `Content-Length` stdio framing with one compact JSON-RPC object
per line. The server still accepts the old framing during migration. Legacy
clients retain logging notifications; modern clients intentionally read a
known task with `traecn_get_task` when they need its state because
`2026-07-28` removed free-floating logging notifications.

## Canonical environment names and defaults

Use `TRAECN_GATEWAY_HOST` and `TRAECN_GATEWAY_PORT` instead of `TRAECN_HOST`,
`TRAECN_PORT`, `HOST`, or `PORT` in new configuration. Compatibility aliases
remain readable during migration, but canonical names take precedence.

The canonical defaults are:

- gateway `127.0.0.1:8788`;
- TraeCN CDP `127.0.0.1:9222`;
- existing logged-in TraeCN profile;
- `TRAECN_AUTO_START_TRAE=0`;
- response collection timeout `1800000` ms;
- no total local queue cap while `TRAECN_QUEUE_MAX_WAIT_MS` is empty.

`npm run quickstart` checks an existing TraeCN/CDP session and starts the
gateway. Use `npm run start:traecn` to launch TraeCN explicitly, or
`npm run quickstart -- --launch-trae` for an opt-in combined invocation.

## Queue persistence

Legacy active-queue documents with `version: 1` are read once and rewritten as
checksummed schema version 2. The new store writes an atomic primary snapshot
and keeps `.bak` as last-known-good. Invalid primary files are renamed with a
`.corrupt-<timestamp>-<pid>` suffix before backup recovery. Preserve these
files when investigating storage or shutdown failures.

## Network security

A non-loopback gateway bind now requires a non-empty
`TRAECN_GATEWAY_TOKEN`. Startup fails instead of warning and continuing. Local
loopback operation can remain tokenless, although a token is still recommended
when other local processes are not trusted.

## Upgrade checklist

1. Stop the old gateway and back up its active queue file.
2. Update the source checkout or unpack the 0.5.0 release artifacts.
3. Remove MCP profile configuration and switch to canonical environment names.
4. Run `npm install`, `npm run doctor`, and `npm run verify`.
5. Start TraeCN with CDP on port 9222, then start the gateway and reconnect the
   MCP client.
6. Confirm `tools/list` returns exactly 20 tools and `/api/capabilities`
   reports contract version 5.
7. For a modern client, confirm `server/discover` includes `2026-07-28` and a
   newline-framed `tools/list` result contains `resultType: "complete"`.
