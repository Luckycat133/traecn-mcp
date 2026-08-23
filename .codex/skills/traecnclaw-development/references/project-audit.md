# TRAECNclaw current product audit

This is the current operational snapshot. Re-read source, public Releases,
marketplaces, open work, and live evidence before relying on any status below.

## Snapshot — 2026-08-21

- Canonical source line: `0.5.6`, Node.js 22 CommonJS.
- Canonical repository: private `Luckycat133/TRAECNclaw`.
- Public distribution repository: public `Luckycat133/traecnclaw-mcp-skill`.
- Current public pair: public mirror `v0.5.6` server/Skill archives and ClawHub
  `traecnclaw-mcp` 0.5.6.
- npm `traecnclaw@0.3.1` is an older independent channel and must not be used as
  the current server.
- MCP contract: version 5, exactly 20 ordered tools.
- Verified runtime scope: macOS and TraeCN 1.107.x, with fresh evidence for
  1.107.1.
- Real Codex host, strict live readiness, one authorized live task, clean-room
  Release install, durable active/terminal idempotency, task subscriptions, and
  new-client history isolation have passed for the 0.5.6 milestone.
- PR #21 contains the current Glama/public-mirror/product-surface work. Public
  mirror PR #7 replaces stale 0.3.0 Glama files. Recheck their status before
  continuing.

## Completion verdict

The selected 0.5.6 local runtime is complete. No known unblocked core runtime
bug or mandatory new MCP tool remains from the prior milestone.

Selected next work is:

1. complete Glama readiness and listing;
2. improve MCP metadata/schema quality without changing the 20-tool contract;
3. add high-value install and discovery channels;
4. productize the human Web Control Console;
5. simplify first-run and CLI presentation;
6. promote through channels that can produce real users and feedback.

Anything else requires reproduced failure evidence or an explicit product-scope
choice.

## Product surfaces

| Surface | Audience | Purpose | Status | Boundary |
| --- | --- | --- | --- | --- |
| Local gateway | Runtime | Same-Mac TraeCN control, durability, approvals, APIs | Core | Own all task/UI lifecycle mechanics |
| MCP Skill + stdio | Agents | Primary convenient TraeCN operation | Primary product | Freeze 20 focused tools |
| Web Control Console | Humans | Local/remote observation and control | Selected next product work | One human UI over gateway APIs |
| CLI | Maintainers/scripts | Setup, doctor, service, recovery, logs, live UAT | Keep/demote | Not a second chat product |
| OpenClaw | OpenClaw users | Ecosystem adapter | Keep | No independent lifecycle |
| REST/JS API | Integrators | Foundation for clients/custom composition | Secondary | Do not lead onboarding |
| LaunchAgent/service | Operators | Keep gateway running | Deployment mechanism | Not a product surface |
| Marketplaces/directories | Discovery/install | Distribute local MCP product | Expand selectively | Never imply cloud equals local TraeCN |

## MCP design audit

### What is already correct

- One public tool represents one user intent.
- Durable work is created through `traecn_send_message`.
- Context, settings, conversations, and exceptional interactions are split into
  specific tools rather than one generic command interface.
- Queueing, recovery, waiting, event cursors, persistence, and routine UI
  mechanics remain gateway-owned.
- Tool names are stable, ordered, and validated during module loading and Skill
  contract tests.
- Modern Tasks/subscriptions and legacy host behavior are handled below the
  public tool count.

### Selected MCP quality improvements

Implement the metadata milestone defined in `mcp-product-design.md`:

- add human-readable titles;
- rewrite descriptions around purpose, when-to-call, side effects, and result;
- retain strict input schemas and improve property constraints/descriptions;
- replace generic output schemas with reusable schemas matching real
  `structuredContent`;
- validate representative success and error results;
- make read-only, idempotent, destructive, and open-world annotations accurate
  per tool;
- declare `traecn_send_message` task support explicitly and forbid it on tools
  that are synchronous;
- standardize actionable structured errors;
- preserve semantic parity between text and structured results;
- add a metadata quality test that does not change tool names, order, or runtime
  semantics.

### Not selected

- more tools;
- tool profiles;
- generic shell/GUI commands;
- Agent polling/recovery tools;
- resources/prompts solely for marketplace counts;
- MCP Apps without a named host/user use case;
- Streamable HTTP merely to satisfy a remote marketplace.

## Distribution channel matrix

### Existing and verified

| Channel | Type | State | Notes |
| --- | --- | --- | --- |
| Public GitHub mirror Release | Install/provenance | verified for 0.5.6 | Current public server + Skill pair |
| ClawHub | Skill install/discovery | verified for 0.5.6 | Skill requires matching server archive |
| Canonical private Release | Provenance | verified for authorized users | Not submitted as public source |

### Immediate selected channels

| Channel | Type | Dependency | Acceptance evidence |
| --- | --- | --- | --- |
| Glama | Directory/inspection/score | PR #21 + public PR #7 | claim, sync, 20 tools, score, no false hosted claim |
| skills.sh | Skill install/index | Public Skill path | clean `npx skills add` install and public detail page |
| AwesomeSkills.dev | Skill directory | Canonical Skill copy | parsed metadata and direct install/source link |
| MCP.Directory Skill | Skill directory | Canonical Skill copy | listing reviewed and accurate |
| MCP.Directory Server | MCP directory | Public repo/Release | local stdio, macOS, 20 tools, correct install |
| MCP Server Hub | MCP/Skill directory | Canonical listing copy | public listing and corrected install metadata |
| mcp.so | MCP directory | Canonical listing copy | listing without old npm/current-host confusion |

### Packaging and authority milestones

| Channel | Type | Dependency | Decision |
| --- | --- | --- | --- |
| MCPB | One-click local package | Manifest/build/test work | selected next package |
| Smithery Local | MCPB distribution | Verified `.mcpb` | selected; URL mode not selected |
| Current npm package | Public package | Package-name/migration decision | selected prerequisite for Registry |
| Official MCP Registry | Authoritative metadata | Current public package | selected after package publish |
| PulseMCP | Enriched aggregator | Official Registry ingestion | verify automatic ingestion first |
| Homebrew tap | macOS operator install | Stable public archive/package | selected after MCPB/package truth |

### Curated and secondary syndication

- Reconcile the existing `punkpeye/awesome-mcp-servers` PR after Glama evidence.
- Submit mcpservers.org, AllMCPs, MCPSkills, or similar only after higher-signal
  pages use correct install data.
- Do not pay for premium placement before organic evidence.
- Stop when additional directories produce no installs, links, feedback, or
  indexing value.

### Rejected/deferred

- `mcpub` for the current product because it indexes public live remote
  endpoints, not local stdio servers.
- Glama hosted public runtime.
- Smithery URL publication without a real Streamable HTTP endpoint.
- Official Registry metadata backed by npm 0.3.1.
- Generic remote/cloud execution architecture.

## Current Glama work

Before browser registration:

- validate canonical PR #21;
- validate public mirror PR #7;
- ensure root Dockerfile installs current 0.5.6 archive;
- remove old tool profile and legacy host/port variables;
- verify root `glama.json`, README, LICENSE, Release, and provenance;
- build/start the inspection container without a token or mock bridge;
- confirm exactly 20 tools.

Then use `glama-browser-runbook.md` to submit/claim/sync/score. Do not click a
public hosted Release action unless a secured remote-to-Mac product is selected
and proven.

## Package roadmap

### MCPB + Smithery

This is the best next install form for a local desktop MCP server.

Acceptance:

- reproducible valid MCPB manifest;
- bundled current server and production dependencies;
- no user credentials or persistence data;
- clean installation in a real MCPB-capable host;
- exact 20-tool discovery;
- mock clean-room task and authorized live task evidence when needed;
- release manifest records `.mcpb` source revision, size, and SHA-256;
- Smithery Local page downloads and installs the same bundle.

### npm + Official Registry

Do not publish until the old unscoped 0.3.1 channel is deliberately handled.
Preferred path is a current scoped package such as
`@luckycat133/traecnclaw`, followed by an Official Registry entry under the
GitHub-authenticated namespace.

Acceptance:

- public package installs from registry in a clean directory;
- package contains the matching `mcpName` and current version;
- full release/audit gates pass;
- Official Registry API shows correct package, transport, repository, and
  environment variables;
- PulseMCP and downstream indexes reflect the current metadata.

### Homebrew

Use a dedicated `Luckycat133/homebrew-tap`. The formula installs the Mac
operator/server binaries from a checksummed public artifact and includes a
non-live stdio/discovery test. Pair Homebrew with Skill/host setup; it does not
replace the Agent Skill.

## Web Control Console plan

The existing page should become the only intentional human product. Do not
rewrite the gateway.

Milestone 1:

- responsive status/readiness header;
- workspace/model/mode/conversation context strip;
- instruction composer;
- active task cards and result timeline;
- cancel and exceptional interaction cards;
- recent history;
- explicit mock/live/local state;
- mobile layout;
- authenticated Tailscale/private-network guidance;
- Advanced drawer for adapter, persistence, metrics, logs, OpenAPI, and audit.

Milestone 2 only after real use:

- pairing/session UX;
- PWA/notifications;
- multiple named Macs;
- richer file/diff review.

## CLI reduction plan

Keep implementation compatibility. Lead documentation with:

- `setup:mcp`;
- doctor/readiness/status;
- service start/stop/status;
- logs and recovery;
- live UAT;
- scripted status/result reads.

Move interactive `delegate`, `vibe`, `wait`, `batch`, proof, and cleanup into
Advanced/Operator documentation. Remove commands only after the MCP/web
replacement has regression coverage and actual usage evidence.

## Promotion plan

### Required launch assets

- 60–90 second real demo;
- five-minute setup tutorial;
- architecture diagram;
- three reproducible use cases;
- honest Mac/TraeCN/local-runtime limitations;
- current public links/version;
- README video/GIF and social preview.

### Highest-priority Chinese channels

1. TRAE official Chinese community `案例与作品`.
2. Bilibili real workflow demo and detailed setup video.
3. Two of V2EX, 掘金, and 知乎, using technical content rather than duplicate ads.
4. TRAE Friends meetup/demo day when available.

### Highest-priority global channels

1. GitHub Release/README and YouTube.
2. Show HN after trial friction is low and the maintainer can discuss the work.
3. X/LinkedIn technical launch post.
4. Product Hunt only after Web Control Console v1 and onboarding form a complete
   human product.
5. Relevant Reddit communities only within their self-promotion rules.

### Promotion guardrails

- one canonical narrative, adapted to each community;
- ask for feedback, never coordinated upvotes;
- no unsupported benchmarks or “works everywhere” claims;
- show real host + real TraeCN, not only mock output;
- respond to issues and update FAQ during launch week;
- do not use MCP contributor channels as unsolicited marketing venues.

## Current selected development order

1. Validate and merge Glama/public-mirror work.
2. Execute Glama browser flow and fix score findings.
3. Implement MCP metadata quality milestone.
4. Verify skills.sh and submit immediate Skill/MCP directories.
5. Build MCPB and publish Smithery Local.
6. Decide current npm package name/migration, then Official Registry and PulseMCP.
7. Add Homebrew tap.
8. Build Web Control Console v1.
9. Simplify first-run/CLI documentation.
10. Produce launch assets and run Chinese-first, then global promotion.
11. Continue runtime/architecture work only from reproduced evidence.

## Test and evidence ladder

### Static and focused

```sh
npm ci
npm run verify:static
node scripts/public-mirror.test.js
npm run test:mcp-conformance
npm run test:mcp-stdio-smoke
npm run test:system
```

Add focused metadata-schema tests for the MCP quality milestone and manifest/
install tests for each package channel.

### Repository and Release

```sh
npm run verify
npm run test:release
```

Release-facing work also verifies public-registry installs or MCPB/Homebrew
artifacts from their actual published channel.

### Live Mac

```sh
npm run doctor
npm run inspect:verify
node scripts/live-uat.js --strict --require-ready --require-verified-adapter
```

Use an authorized short task only when real execution must be re-proven.

### Web

Exercise local and second-device authenticated access through the same gateway.

### Channel

For every listing/package, record URL, version, install command, tool count,
owner state, score/scan, clean-install result, screenshots, and findings.

## Channel ledger

Maintain this structure as channels change:

| Channel | Type | Version | State | URL | Install tested | Last verified | Findings |
| --- | --- | --- | --- | --- | --- | --- | --- |

Allowed states:

```text
planned
preflight-failed
submitted
pending-review
listed
claimed
verified
superseded
rejected
paused
```

## Settled decisions

Do not ask again unless the user changes direction:

- TRAECNclaw is an MCP Skill product.
- MCP is the Agent interface.
- Web Control Console is the human interface.
- CLI is the operator/developer interface.
- macOS-only verified scope is acceptable while it is the available test
  platform.
- public mirror and ClawHub are already public channels.
- Glama registration is approved.
- useful additional distribution and promotion channels are approved when they
  preserve local-first truth and exact provenance.

## Decisions needed only when implementation reaches them

- exact current npm package name and old 0.3.1 deprecation/migration;
- whether Smithery Uplink is useful for a named private workflow;
- which two Chinese technical communities to use after TRAE/Bilibili;
- Tailscale versus another private remote-access path for Web Console docs;
- whether Product Hunt is worthwhile after Web Console v1.

None of these block Glama, MCP metadata quality, skills.sh/directories, MCPB
prototype work, or Web Console milestone 1.
