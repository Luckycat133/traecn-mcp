# Naming and architecture rules

## Canonical names and compatibility classes

The repository review baseline is `a37f6bed01931dd7fd984f3ca40d431d425451cc`
(2026-11-09). Re-read the current implementation before changing a value.

| Surface | Rule |
| --- | --- |
| Product text and new examples | `TraeCN MCP`; operator executable `traecn-mcp` |
| Canonical repository | `Luckycat133/traecn-mcp` |
| Source package | `package.json` name `traecn-mcp`; preserve `private: true` |
| Runtime Skill | `skills/traecn-mcp`, frontmatter `name: traecn-mcp` |
| Development Skill | `.agents/skills/traecn-mcp-development`, matching frontmatter; repository-local |
| MCP server identity | `SERVER_INFO.name` is `traecn-mcp`; title/version derive from package metadata |
| Public MCP tools | Preserve the ordered `traecn_*` names from `src/mcp/contract.js` |
| Host configuration | Preserve existing keys such as `traecn`; branding alone does not require changing host IDs |
| Environment | Canonical `TRAECN_*` schema; retain supported `TRAE_*` fallbacks and existing precedence |
| Published package compatibility | Builder currently emits `@luckycat133/traecnclaw`; this is not the source package name |
| Official Registry compatibility | Existing `mcpName` is `io.github.Luckycat133/traecnclaw`; do not silently create a second listing |
| Artifact/Homebrew compatibility | Existing `traecnclaw-<version>.tgz`, formula paths/names, and launcher package fallbacks require coordinated migration |
| Persistent/service compatibility | Existing `TRAECNclaw` state paths and old service labels are storage/process identities, not cosmetic prose |
| Historical evidence | Old versions, URLs, package digests, commit messages, and dated channel checks remain historical facts |

An old string is not automatically correct because it exists. Classify each
match as (a) current presentation to fix, (b) compatibility to preserve until
migrated, or (c) history to retain. An exception needs a concrete owning file,
consumer, reason, regression check, and removal/migration condition; do not
allow every old string under an entire source directory.

Useful inventory, not an acceptance test by itself:

```sh
git grep -n -i -E 'traecnclaw|traecnclaw-mcp|traecnclaw-mcp-skill' -- .
```

`docs/CHANNEL-LEDGER.md` contains dated older-release evidence; neither its
header nor an old `verified` row establishes the current release/channel state.
Do not replace names inside that evidence to make it appear current.

The review found a presentation dependency in
`distribution/public-mirror/README.md.template`: its provenance sentence names
`TRAECNclaw`, and `scripts/public-mirror.js` verifies that exact old label.
The direct-client example also has a test pinned to
`/absolute/path/to/TRAECNclaw/mcp-server.js` in
`skills/traecn-mcp/scripts/skill-contract.test.js`. Update new-install examples
and their assertions together, retaining support for actual existing checkout
paths. Update the provenance template and validator/tests together in a dedicated
migration cleanup. It is not a reason to rename the scoped npm/Registry identities.

## Required sequence for a compatibility migration

First inventory all producers and consumers: source, built package, bin,
launcher resolution, host config, generated Skill, service installer, state
stores, manifests, templates, and real install channels. Decide whether the
change is presentation-only, an alias/deprecation, or a breaking migration.

For state/service migration, design deterministic old/new path selection,
conflict handling, locking, atomic writes, backup/recovery, and repeatability.
Do not merge ambiguous state automatically or start two gateways. Test an
interrupted migration and repeated invocation with disposable copies; preserve
task IDs, submission fingerprints, event cursors, pending approvals, and
parent/child links. Specify an actually tested rollback, or a documented
forward-recovery limitation, rather than promising arbitrary downgrade safety.

For a channel identity change, preserve the old install path or publish an
explicit transition. Verify an old installation upgrading through the actual
new artifact, absolute MCP launcher resolution, CLI help, clean protocol
stdout, exact 20-tool discovery, state continuity, and service ownership. Check
published hashes and generated install instructions independently per channel.
A root package rename or successful upload does not prove this migration.

## Architecture ownership map

| Owner | Owns | Must not acquire |
| --- | --- | --- |
| `src/config` | Runtime schema, parsing, environment precedence | Duplicate configuration truth in each adapter |
| `src/shared` | Reusable persistence, security, logging, event primitives | Product orchestration disguised as a utility |
| `src/client` | HTTP client, shared command catalog, transport cancellation | Desktop actions, durable task execution, independent retries of uncertain sends |
| `src/http` | Gateway, task/queue/recovery services, UI serialization, durable lifecycle, routes/OpenAPI, human web console | Protocol-era policy duplicated from `src/mcp` |
| `src/cdp` | CDP discovery/transport and DOM operations | Cross-client durable queues or a second business task lifecycle |
| `src/trae-adapters` | Product/version selection, selectors, capabilities, sanitized replay fixtures | Unverified universal compatibility claims |
| `src/mcp` | Frozen tools/schemas, protocol and Tasks adaptation, authorization, framing and notification delivery | An independent task database or desktop coordinator |
| `src/skill` | Existing JavaScript/TypeScript compatibility API | A new implementation of the gateway task engine |
| `integrations/openclaw-traecn-plugin` | OpenClaw registration and adaptation | A fork of `src/client` or gateway execution logic |
| `scripts/traecn-cli.js` | Operator/scripting command entry | A competing general-purpose human product |

These are ownership boundaries, not a demand to move every function now.
`src/mcp/handler.js` already imports `src/client/traecnapi-client.js`.
`integrations/openclaw-traecn-plugin/lib/traecnapi-client.js` is already a
re-export. Extend the owner, not the compatibility wrapper. Preserve supported
export paths even when implementation moves.

Separate reusable completion/event delivery from durable state ownership.
Notification failure must not rewrite a completed task. Gateway-authorized
polling/event pumps are not the prohibited agent-authored polling tool surface.
Refactor large files only with behavior characterization and a bounded owner
extraction; file size alone is not evidence of a correctness bug.

## Contracts that branding cannot change

`src/mcp/contract.js` defines **product contract v5** and the exact ordered
20-tool set. `src/mcp/protocol.js` independently declares wire support for
`2026-07-28`, `2025-11-25`, and `2024-11-05` at this baseline. Reconcile future
changes against code and independent conformance clients, not memory or a
hard-coded copy of protocol details in this reference.

Keep Tasks and legacy tools on the same gateway authorization/lifecycle.
Preserve text/structured equivalence for errors, accepted tasks, terminal
replays, and final results. Validate real result instances against output
schemas. Metadata improvements do not authorize changed tool names/order or
relaxed approval/destruction checks.

Cancellation, uncertain submissions, queue restart, storage retry, review
continuation, native conversation binding, and subscription disposal are
cross-surface invariants. Test them at the owning gateway/driver layer and
through the affected client; do not separately implement them in CLI and MCP.

## Skill source and mirrors

The runtime Skill is a distributable operator package. Its source is
`skills/traecn-mcp`; `.codex/skills/traecn-mcp` is a complete generated copy.
The existing `.agents` and `.claude` runtime entries resolve to that package.
Use `sync:skill-contracts` when schemas/metadata change, `sync:local-skill`
after canonical Skill changes, then their check commands. Keep generated
references and helpers, not only the frontmatter, synchronized.

The development Skill is separate: `.agents/skills/traecn-mcp-development` is
the only maintained source; `.codex/skills/traecn-mcp-development` and
`.claude/skills/traecn-mcp-development` resolve there. Do not include it in
ClawHub/MCPB/operator Skill publication or tie its metadata to runtime version
synchronization. `AGENTS.md` and `docs/development.md` route developers here.

## External specifications

Agent Skills format, frontmatter/name matching, and progressive references:
https://agentskills.io/specification

MCP tool/result semantics for the currently implemented modern era:
https://modelcontextprotocol.io/specification/2026-07-28/server/tools

These specifications constrain format/protocol behavior; the 20-tool limit
and product ownership policy are this repository's rules, not universal MCP
requirements.
