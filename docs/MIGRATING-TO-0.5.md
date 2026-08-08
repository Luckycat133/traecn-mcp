# Migrating to 0.5.x

This guide covers the 0.3.x to 0.5.0 migration and compatible patch updates
through source version 0.5.6. TRAECNclaw 0.5.0 freezes MCP contract version 5 and repairs the
distribution, configuration, persistence, and security boundaries that changed
throughout the 0.4.x series.

## Updating to 0.5.6

Source version 0.5.6 contains compatible reliability and onboarding
changes newer than the immutable `v0.5.5` tag. It hardens Quickstart CDP
identity probing, applies the CLI's intended request timeout, upgrades
TaskHistory to checksummed atomic schema 2 persistence with health reporting,
repairs strict live UAT discovery against the frozen MCP v5 surface, and adds
a tested MCP configuration generator.

TaskStore now migrates schema 2 snapshots to schema 3 and retains terminal
idempotency records beside active tasks under the same checksum, atomic-write,
backup, quarantine, and single-writer boundary. A matching retry returns the
original active task or the retained terminal result; a different semantic
request using the same key returns HTTP 409. Terminal replays expire after
`TRAECN_TERMINAL_IDEMPOTENCY_TTL_MS`, which defaults to 24 hours.

MCP is the primary Agent path in 0.5.6. Generate a resolved
client entry with `npm run --silent setup:mcp`, or create a new file with
`npm run setup:mcp -- --output FILE`. The CLI remains the live-validation path,
the web UI is diagnostic, and OpenClaw remains an ecosystem adapter.

The compatible version decision has been applied as source version `0.5.6`,
but source metadata alone is not a public release. The local
`npm run test:release` gate passes, including artifact manifest verification
and clean-room installation. Publishing still requires matching GitHub Release
server and Skill assets from the manifest's exact revision. Never move the
historical `v0.5.5` tag.

## Updating from 0.5.4 to 0.5.5

Version 0.5.5 is a compatible reliability and architecture patch. Restart and
retry fault-injection coverage now exercises task identity, durable acceptance,
Trae submission state, partial results, terminal-task filtering, idempotency
replay, TaskStore rollback, and TaskEventStore cursor behavior. Idempotency-key
replay resolution is owned by `TaskOrchestrator`; HTTP response status and the
20-tool MCP contract are unchanged.

The immutable `v0.5.5` tag already points to commit `4c01911`, but no matching
GitHub Release assets were published. Do not move the tag to include later
fixes. Any historical 0.5.5 artifact must be built from that exact commit; the
later completion work is source version 0.5.6.

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

As of 2026-08-08, there is no complete public 0.5.6 server + Skill installation
pair: source is 0.5.6, ClawHub has the 0.5.5 Skill, the latest downloadable
canonical GitHub Release is 0.5.4, npm `traecnclaw` is 0.3.1, and the public
mirror still identifies canonical 0.5.3. Use an authorized exact 0.5.6 source
checkout for current behavior. A source checkout can point the MCP client at
`mcp-server.js` or use the bundled Skill launcher. Never mix a newer Skill with
an older server when validating version-specific behavior.

For public installation, wait for one next-version source revision to provide
both the server and Skill, then verify their version, source commit, manifest,
and checksums before replacing an existing installation.

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
- terminal idempotency replay retention of `86400000` ms (24 hours).

`npm run quickstart` checks an existing TraeCN/CDP session and starts the
gateway. Use `npm run start:traecn` to launch TraeCN explicitly, or
`npm run quickstart -- --launch-trae` for an opt-in combined invocation.

## Queue persistence

Legacy active-queue documents with `version: 1` and checksummed schema version
2 documents are read and rewritten as checksummed schema version 3. The store
persists both active tasks and bounded terminal idempotency replays in one
atomic primary snapshot and keeps `.bak` as last-known-good. Invalid primary files are renamed with a
`.corrupt-<timestamp>-<pid>` suffix before backup recovery. Preserve these
files when investigating storage or shutdown failures.

Only one gateway process may own an active-queue file. A second writer reports
degraded durability instead of replacing the first process's snapshot; a lock
left by a dead process is reclaimed on the next write. Task submission now
returns `202` only after its first snapshot is durable, and returns
`503 TASK_STORE_UNAVAILABLE` without accepting the candidate when persistence
fails. Retry uncertain submissions with a stable `Idempotency-Key`; active-task
ownership is restored with the queue after restart, and terminal ownership is
retained for the configured TTL with the original status, result, or error.
Keys longer than 256 characters are rejected, and a key cannot be reused for
different meaningful input. Inspect the `durability` object returned by
`GET /api/status` before unattended delegation; it includes the terminal replay
count and configured TTL.

Completion events and per-client acknowledgement cursors use their own
checksummed schema version 2 snapshot with atomic replacement, `.bak` recovery,
and corrupt-file quarantine. `durability.taskEvents` reports its health. A
failed event write is not broadcast as a completed delivery, and a failed
cursor write returns HTTP 503 without advancing that client's durable cursor.

Task history and replay evidence also migrate legacy version 1 JSON into a
checksummed schema version 2 snapshot with atomic replacement, `.bak` recovery,
and corrupt-file quarantine. Step-only updates now schedule persistence, and
`durability.taskHistory` reports write, load, and recovery health.

## Network security

A non-loopback gateway bind now requires a non-empty
`TRAECN_GATEWAY_TOKEN`. Startup fails instead of warning and continuing. Local
loopback operation can remain tokenless, although a token is still recommended
when other local processes are not trusted.

## Upgrade checklist

1. Stop the old gateway and back up its active queue file.
2. Update to the exact verified 0.5.6 source revision, or unpack matching
   0.5.6 server and Skill artifacts after they are published.
3. Remove MCP profile configuration and switch to canonical environment names.
4. Run `npm install`, `npm run doctor`, and `npm run verify`.
5. Start TraeCN with CDP on port 9222, then start the gateway and reconnect the
   MCP client.
6. Confirm `tools/list` returns exactly 20 tools and `/api/capabilities`
   reports contract version 5.
7. For a modern client, confirm `server/discover` includes `2026-07-28` and a
   newline-framed `tools/list` result contains `resultType: "complete"`.
