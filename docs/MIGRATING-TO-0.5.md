# Migrating to 0.5.x

This guide covers the 0.3.x to 0.5.0 migration and compatible patch updates
through 0.5.5. TRAECNclaw 0.5.0 freezes MCP contract version 5 and repairs the
distribution, configuration, persistence, and security boundaries that changed
throughout the 0.4.x series.

## Updating from 0.5.4 to 0.5.5

Version 0.5.5 is a compatible reliability and architecture patch. Restart and
retry fault-injection coverage now exercises task identity, durable acceptance,
Trae submission state, partial results, terminal-task filtering, idempotency
replay, TaskStore rollback, and TaskEventStore cursor behavior. Idempotency-key
replay resolution is owned by `TaskOrchestrator`; HTTP response status and the
20-tool MCP contract are unchanged.

Before publishing, run `npm run verify`, build the artifacts from the same clean
0.5.5 commit, and verify the release manifest before creating the `v0.5.5` tag.

## Updating from 0.5.3 to 0.5.4

Version 0.5.4 is a compatible reliability, architecture, and release-verification
update. Durable task acceptance is now owned by `TaskOrchestrator`, which rolls
back the in-memory candidate and records a failed history state when the active
queue cannot be persisted. Completion-event clients can acknowledge cursors
after retention pruning, and an unknown future cursor no longer stalls later
events or long-poll subscriptions.

The HTTP route table now composes metadata from extracted handler modules. The
frozen MCP contract version 5 and its ordered 20-tool surface are unchanged.
Release tags now run the clean-room gate and artifact manifest checks before
GitHub Release assets are uploaded.

## Updating from 0.5.2 to 0.5.3

Version 0.5.3 is a compatible security and durability update. Remove
`TRAECN_MCP_SERVER_PATH` from portable Skill configuration: the launcher now
uses only a repository-local server, an installed `traecnclaw` package, or the
`traecnclaw-mcp` executable on `PATH`. A source checkout that needs a direct
entry point should use `assets/mcp-client-config.direct.json` instead.

Existing completion-event snapshots migrate automatically to checksummed
schema version 2. Preserve the primary, `.bak`, `.tmp`, and quarantined files
when diagnosing recovery. No MCP tool-contract migration is required; contract
version 5 and its ordered 20-tool surface are unchanged.

## Installation source

Install the exact 0.5.5 GitHub Release artifact or the matching published
package when using a registry. Until publication, use this source checkout and
build its artifacts from the final clean commit. A source checkout can point
the MCP client at
`mcp-server.js` or use the bundled Skill launcher. Do not mix a 0.5.4 Skill with
an older server package, or a 0.5.5 Skill with an older server, when validating
release-specific behavior.

## MCP contract

Remove `TRAECN_MCP_TOOL_PROFILE` and all `public`, `ops`, or `full` profile
selection. There is one ordered 20-tool Agent surface:

- prepare context only when needed with `traecn_open_workspace`,
  `traecn_select_model`, `traecn_select_mode`, and conversation tools;
- submit once with `traecn_send_message`;
- let the gateway own queueing, waiting, recovery, routine non-command questions, and
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
clients retain logging notifications. Modern clients should declare the
separately negotiated `io.modelcontextprotocol/tasks` extension on each
eligible request, handle `resultType: "task"`, and either respect
`pollIntervalMs` on `tasks/get` or subscribe to exact task IDs with
`subscriptions/listen`. Hosts without extension support intentionally read a
known task with `traecn_get_task`; no ordinary wait or event tool was added.

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

Only one gateway process may own an active-queue file. A second writer reports
degraded durability instead of replacing the first process's snapshot; a lock
left by a dead process is reclaimed on the next write. Task submission now
returns `202` only after its first snapshot is durable, and returns
`503 TASK_STORE_UNAVAILABLE` without accepting the candidate when persistence
fails. Retry uncertain submissions with a stable `Idempotency-Key`; active-task
ownership is restored with the queue after restart. Inspect the `durability`
object returned by `GET /api/status` before unattended delegation.

Completion events and per-client acknowledgement cursors use their own
checksummed schema version 2 snapshot with atomic replacement, `.bak` recovery,
and corrupt-file quarantine. `durability.taskEvents` reports its health. A
failed event write is not broadcast as a completed delivery, and a failed
cursor write returns HTTP 503 without advancing that client's durable cursor.

## Network security

A non-loopback gateway bind now requires a non-empty
`TRAECN_GATEWAY_TOKEN`. Startup fails instead of warning and continuing. Local
loopback operation can remain tokenless, although a token is still recommended
when other local processes are not trusted.

## Upgrade checklist

1. Stop the old gateway and back up its active queue file.
2. Update the source checkout or unpack the 0.5.5 release artifacts.
3. Remove MCP profile configuration and switch to canonical environment names.
4. Run `npm install`, `npm run doctor`, and `npm run verify`.
5. Start TraeCN with CDP on port 9222, then start the gateway and reconnect the
   MCP client.
6. Confirm `tools/list` returns exactly 20 tools and `/api/capabilities`
   reports contract version 5.
7. For a modern client, confirm `server/discover` includes `2026-07-28` and a
   newline-framed `tools/list` result contains `resultType: "complete"`.
