# TRAECNclaw current product audit

This is the current operational snapshot. Re-read source, public Releases,
marketplaces, open work, and live evidence before relying on any status below.
The detailed public-channel facts live in `docs/CHANNEL-LEDGER.md`.

## Snapshot — 2026-08-23

- Canonical release candidate: `0.5.9`, Node.js 22 CommonJS.
- Canonical repository: private `Luckycat133/TRAECNclaw`.
- Public distribution repository: public
  `Luckycat133/traecnclaw-mcp-skill`.
- Last verified public Release/Homebrew pair: 0.5.8.
- ClawHub remains stale at 0.5.6.
- Historical unscoped npm `traecnclaw@0.3.1` is not a current channel.
- Selected public npm identity: `@luckycat133/traecnclaw`.
- MCP identity: existing Registry name `io.github.Luckycat133/traecnclaw`.
- MCP contract v5 remains exactly 20 ordered tools.
- Verified runtime scope remains macOS and TraeCN 1.107.x. Unknown versions use
  a reported degraded adapter and are not a platform claim.
- The current worktree contains the 0.5.9 distribution fixes; it is not yet a
  clean release commit and no 0.5.9 public surface is claimed.

## Completion verdict

The core local runtime and MCP metadata milestone are complete. The 0.5.9
distribution implementation now covers:

- official-schema, deterministic MCPB building and validation;
- deliberately scoped npm staging without making the private source package
  publishable by accident;
- Official Registry metadata generation for local stdio;
- source-owned Homebrew formula rendering with a real 20-tool test;
- CLI-first setup, doctor, Quickstart, service, status, logs, and MCP config;
- scoped-package discovery from the portable Skill launcher;
- canonical listing copy, release runbook, channel ledger, and launch drafts.

The overall campaign is not complete until the external rows are verified.
Current external blockers are npm/Smithery/Claude authentication, action-time
confirmation for browser submissions and Glama claim, directory review/indexing,
real launch recording, and Web Console design approval.

## Product surfaces

| Surface | Audience | Purpose | Current boundary |
| --- | --- | --- | --- |
| Local gateway | Runtime | Same-Mac TraeCN control, durability, approvals, APIs | Sole owner of task/UI lifecycle mechanics |
| MCP Skill + stdio | Agents | Primary TraeCN operation | Exactly 20 focused tools; no wait/poll/recovery tools |
| Web Control Console | Humans | Local or authenticated private-network observation/control | Selected human product; design approval pending |
| CLI | Operators/scripts | Setup, doctor, service, recovery, logs, release/live checks | Leading commands simplified; not a second chat product |
| OpenClaw | OpenClaw users | Ecosystem adapter | No independent lifecycle |
| REST/JavaScript API | Integrators | Foundation for clients and custom composition | Secondary surface |
| LaunchAgent/service | Operators | Keep gateway running | Deployment mechanism, not product |
| Marketplaces/directories | Discovery/install | Distribute the local MCP product | Never imply cloud equals local TraeCN |

## MCP design audit

Completed and gated:

- stable names and exact order for 20 single-intent tools;
- purpose-led titles and descriptions;
- strict described inputs and reusable output schemas matched to real results;
- accurate read-only, destructive, idempotent, and open-world annotations;
- explicit optional Tasks support for `traecn_send_message`, forbidden elsewhere;
- actionable structured errors and text/structured semantic parity;
- gateway-owned queues, recovery, waiting, event cursors, persistence, and
  routine interaction handling;
- independent modern Tasks/subscriptions and legacy host compatibility below
  the frozen tool surface.

Still not selected:

- more tools, tool profiles, generic shell/GUI commands, or Agent recovery tools;
- resources/prompts/icons/apps added for marketplace counts;
- Streamable HTTP or a hosted execution product merely for a directory;
- cloud containers presented as access to the user's Mac.

## Distribution audit

### Verified current public facts

- Public mirror 0.5.8 Release is reachable and contains the server/Skill pair.
- Homebrew 0.5.8 installs and its real stdio server returns 20 tools; its public
  formula has stale caveats and an insufficient old test, fixed in the 0.5.9
  template but not yet published.
- Skills CLI can install the public Skill path cleanly.
- The skills.sh detail page exists and points to the public repository.
- Official Registry already has active
  `io.github.Luckycat133/traecnclaw@0.3.1`; it uses the historical unscoped
  package and legacy variables, so 0.5.9 must update that identity rather than
  create a lowercase duplicate.
- Glama has an existing listing, but it is stale/unclaimed and not current
  acceptance evidence.
- Cached Glama Docker preflight builds and discovers 20 tools. A forced image
  pull failed because the Docker daemon's registry TLS connection timed out;
  that external failure does not prove or disprove the listing.
- MCP.Directory Skill and Server submissions already exist in review; do not
  submit duplicates.

### 0.5.9 packaging acceptance

MCPB:

- official manifest schema and official CLI validation;
- public repository metadata and 20 tool objects;
- no credentials or persistent user data;
- deterministic digest across rebuilds;
- release manifest size, SHA-256, and source revision;
- clean compatible-host install still required after the final tag.

Scoped npm and Registry:

- staged tarball internal name `@luckycat133/traecnclaw`;
- public provenance, Darwin restriction, bins, files, and `mcpName` verified in
  package tests;
- canonical package remains private;
- Registry template updates the existing uppercase-username identity with the
  public repository, scoped package, stdio transport, and secret token metadata;
- public registry install, npm authentication, Registry authentication, and
  PulseMCP ingestion still require external completion.

Homebrew:

- formula generated from the clean release manifest and public artifact digest;
- truthful `traecnclaw` caveats;
- CLI help and exact 20-tool stdio discovery in `brew test`;
- public 0.5.9 tap update, audit/style/reinstall/test still required.

Directories:

- canonical payloads are checked in for AwesomeSkills.dev, MCP Server Hub,
  mcp.so, and Glama correction;
- final public submit/claim actions require action-time confirmation;
- Smithery Local requires the exact verified MCPB and current account login;
- Official Registry must follow scoped npm, and PulseMCP should ingest it before
  any manual submission.

## Web Control Console plan

The existing page remains the only intended human product and reuses gateway
APIs. The required milestone contains:

- responsive readiness/status header;
- workspace, model, mode, and conversation context;
- instruction composer;
- active task cards and result timeline;
- cancel and exceptional-interaction cards;
- recent history;
- explicit mock/live/local state;
- authenticated private-network guidance;
- Advanced drawer for adapter, persistence, metrics, logs, OpenAPI, and audit.

The required brainstorming workflow is active. Implementation is paused until
the user chooses and approves a design direction/spec. Do not bypass that gate
or grow a second lifecycle in the browser.

## Promotion audit

Prepared in `docs/LAUNCH-KIT.md`:

- architecture/trust-boundary diagram;
- three reproducible use cases;
- limitation card;
- 60–90 second demo shot list;
- five-minute tutorial script;
- Chinese and global post drafts;
- privacy, evidence, and final-publication checklist.

Not yet complete:

- a real 0.5.9 host recording;
- a rendered tutorial;
- reviewed final URLs/media;
- public posts or community submissions.

Do not post drafts with placeholders, fabricate install counts, request
coordinated votes, or present mock output as live TraeCN evidence.

## Current execution order

1. Complete the 0.5.9 source change and run focused/full Node 22 gates.
2. Merge and tag the exact release commit; verify canonical and public Releases.
3. Publish and clean-test scoped npm.
4. Publish Official Registry metadata; then inspect PulseMCP ingestion.
5. Render, publish, and clean-test Homebrew 0.5.9.
6. Publish ClawHub 0.5.9 from the public mirror commit and recheck skills.sh.
7. Install the exact MCPB in a logged-in host and publish Smithery Local.
8. With confirmation, claim/sync Glama and submit the prepared directory forms.
9. Wait for and verify MCP.Directory and other review/indexing results.
10. Obtain Web Console design approval, implement it, and run browser acceptance.
11. Record real launch media; review exact posts at action time and publish.

## Test and evidence ladder

Focused/static:

```sh
npm ci
npm run verify:static
node scripts/public-mirror.test.js
npm run test:mcp-conformance
npm run test:mcp-stdio-smoke
npm run test:system
```

Repository/Release:

```sh
npm run audit:all
npm run verify
npm run test:release
npm run verify:release-manifest
```

Live Mac, only when real compatibility must be claimed:

```sh
npm run doctor
npm run inspect:verify
node scripts/live-uat.js --strict --require-ready --require-verified-adapter
```

For each external channel record URL, exact version, generated install command,
tool count, owner/claim state, score/scan, clean-install result, last-verified
time, and findings in `docs/CHANNEL-LEDGER.md`.

## Settled decisions

- MCP Skill is the primary Agent product.
- Web Control Console is the human product.
- CLI is the operator/developer interface.
- macOS-only verified scope is acceptable until additional real evidence exists.
- public mirror is the public provenance source.
- current npm identity is scoped `@luckycat133/traecnclaw`.
- Smithery uses Local/MCPB, not URL mode.
- Official Registry follows scoped npm; PulseMCP ingestion is checked before
  manual submission.
- Homebrew installs the operator/server layer, not the Agent Skill.
- Glama is a directory/inspection surface, not a hosted runtime.

## User or external input still required

- action-time confirmation for Glama Claim/sync and public directory submits;
- npm, Smithery, Registry, and Claude Desktop authentication where requested;
- Web Console design-direction/spec approval;
- a real local TraeCN session for final media and any fresh live compatibility
  claim;
- third-party review/indexing time.

These are tracked blockers, not authorization to invent substitute evidence or
mark unfinished rows complete.
