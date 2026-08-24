# TRAECNclaw current product audit

This is the current operational snapshot. Re-read source, public Releases,
marketplaces, open work, and live evidence before relying on any status below.
The detailed public-channel facts live in `docs/CHANNEL-LEDGER.md`.

## Snapshot — 2026-08-24

- Canonical release: `0.5.9`, Node.js 22 CommonJS; tag commit `4edb1b3` passed
  the complete local release workflow before both Releases were created.
- Canonical repository: private `Luckycat133/TRAECNclaw`.
- Public distribution repository: public
  `Luckycat133/traecnclaw-mcp-skill`.
- Canonical and public GitHub Releases are verified at 0.5.9; every downloaded
  asset digest matches the generated provenance manifest.
- Homebrew and ClawHub are verified at 0.5.9. Skills CLI clean installation and
  the skills.sh public detail page are also verified.
- Historical unscoped npm `traecnclaw@0.3.1` is not a current channel.
- Selected public npm identity: `@luckycat133/traecnclaw`.
- MCP identity: existing Registry name `io.github.Luckycat133/traecnclaw`.
- MCP contract v5 remains exactly 20 ordered tools.
- Verified runtime scope remains macOS and TraeCN 1.107.x. Unknown versions use
  a reported degraded adapter and are not a platform claim.
- Canonical `main` contains post-release Glama inspection and strict Homebrew
  audit fixes. Those later commits are separate from the immutable 0.5.9 server
  bytes; the generated public mirror carries the Glama fix on its `main`.
- The local LaunchAgent now runs the canonical 0.5.9 source. Doctor passes, the
  TRAECNclaw workspace is open in TraeCN, and strict non-delegating live UAT
  passes against TraeCN 1.107.1 with verified adapter `traecn-1.107`.
- Glama is synced to public mirror commit `5ad3a3e`; its private Node 22 Build
  test passed with server version 0.5.9 and exactly 20 tools. No hosted Glama
  Release was created.

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

The verified source/Release/Homebrew/ClawHub/Skills/Glama-private-build/live-UAT
portion is complete. The overall campaign is not complete until the remaining
external rows are verified. Current blockers are npm/Smithery/Claude
authentication, the MCP Server Hub Google account handoff, an
AwesomeSkills.dev submission-service failure, directory review/indexing, real
launch recording, and complete Web Console B-spec approval.

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

- Public mirror 0.5.9 Release is reachable; all six downloaded assets match
  their published SHA-256 digests.
- Homebrew 0.5.9 passes syntax, style, strict online audit, real upgrade, CLI,
  and exact 20-tool stdio tests.
- ClawHub 0.5.9 is live with current tags, public-source provenance, and a CLEAN
  scanner result.
- Skills CLI installs metadata version 0.5.9 from the public repository in a
  clean project and the installed launcher passes all focused tests.
- The skills.sh detail page points to the public repository and correct install
  command. Its generated `Cross-platform` JSON-LD remains a third-party warning;
  canonical metadata continues to say macOS.
- Official Registry already has active
  `io.github.Luckycat133/traecnclaw@0.3.1`; it uses the historical unscoped
  package and legacy variables, so 0.5.9 must update that identity rather than
  create a lowercase duplicate.
- Glama's existing maintainer-verified listing is synced to public mirror
  commit `5ad3a3e`; its Overview now renders canonical 0.5.9 copy with no
  removed tool-profile guidance.
- A no-cache Glama Linux inspection build reproduced npm's intentional Darwin
  platform rejection. The canonical inspection-only override then built from
  the public 0.5.9 archive, negotiated MCP, and returned exactly 20 tools without
  changing package platform claims.
- The current Glama-generated `mcp-proxy` build shape was first reproduced
  locally, then verified by private Glama Build
  `01a03167-9fc1-7cb1-ae25-504060a86421` with Node.js 22, pinned public commit
  `5ad3a3e`, server version 0.5.9, and exactly 20 tools. A hosted Glama Release
  remains deliberately excluded because it could not reach the user's Mac.
- MCP.Directory Skill and Server submissions already exist in review; do not
  submit duplicates.
- mcpservers.org already has a page but still renders 0.5.8 provenance. Its
  one-click public update request was re-sent on 2026-08-24 and the page now
  shows `Requested`; verification waits for the site's refresh/indexing pass.

### 0.5.9 packaging acceptance

MCPB:

- official manifest schema and official CLI validation;
- public repository metadata and 20 tool objects;
- no credentials or persistent user data;
- deterministic digest across rebuilds;
- release manifest size, SHA-256, and source revision;
- public asset download and clean-room install are verified; Claude Desktop UI
  installation remains an independent authenticated host check.

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
- public 0.5.9 tap update, Ruby syntax, style, strict online audit, real upgrade,
  CLI help, and exact 20-tool stdio discovery in `brew test` are verified.

Directories:

- canonical payloads are checked in for AwesomeSkills.dev, MCP Server Hub,
  mcp.so, and Glama correction;
- Glama sync/private Build passed without creating a hosted Release;
- mcp.so issue #3717 is pending review;
- existing `punkpeye/awesome-mcp-servers` PR #10724 has accurate macOS-only
  copy and passing checks; its maintainer must decide whether to waive the
  hosted-Glama-score requirement for a local-only server;
- AwesomeSkills.dev returned a repeatable submission network error, and MCP
  Server Hub requires Google sign-in before its prepared form can be accepted;
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

The user selected direction B: a native macOS light control surface.
Implementation remains paused until the complete design is approved, written
and committed, and the written specification is reviewed. Do not bypass that
gate or grow a second lifecycle in the browser.

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

1. Complete npm web login, publish and clean-test scoped npm, then deprecate the
   historical package when account ownership permits.
2. Publish validated Official Registry metadata; inspect PulseMCP ingestion.
3. Install the exact MCPB in a logged-in Claude Desktop and publish Smithery
   Local after Smithery authentication.
4. Complete the MCP Server Hub Google account handoff and retry
   AwesomeSkills.dev after its submission service recovers.
5. Wait for and verify MCP.Directory, mcp.so issue #3717, awesome PR #10724,
   mcpservers.org, and other review/indexing results.
6. Obtain complete Web Console B-spec approval, commit and review the written
   specification, then implement and run browser acceptance.
7. Record real launch media; review exact posts at action time and publish.

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

- npm, Smithery, Registry, and Claude Desktop authentication where requested;
- Google sign-in/OAuth for MCP Server Hub and recovery of the
  AwesomeSkills.dev submission service;
- complete Web Console B-spec and written-spec approval;
- a real local TraeCN task plus recording review for final media;
- third-party review/indexing time.

These are tracked blockers, not authorization to invent substitute evidence or
mark unfinished rows complete.
