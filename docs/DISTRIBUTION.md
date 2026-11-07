# TRAECNclaw Distribution

TRAECNclaw has one runtime and several independent publication surfaces. A
source version, tag, GitHub Release, npm package, Homebrew formula, MCPB bundle,
Skill listing, and MCP directory entry are separate facts. Never call a release
complete until each selected surface has been inspected and its generated
install path has been exercised.

The live, date-stamped status is maintained in
[`CHANNEL-LEDGER.md`](CHANNEL-LEDGER.md). This document defines how to build,
publish, and verify those rows.

## Product and package identities

| Role | Canonical identity |
| --- | --- |
| Public source and GitHub releases | `Luckycat133/traecn-mcp` |
| MCP server name | `io.github.Luckycat133/traecnclaw` (existing Registry identity) |
| Current npm package | `@luckycat133/traecnclaw` |
| Historical npm package | `traecnclaw@0.3.1`; never advertise as current |
| Agent Skill | `traecn-mcp` |
| Homebrew formula | `Luckycat133/traecn-mcp/traecnclaw` |
| Transport | local stdio on the same Mac as TraeCN |
| Platform evidence | macOS with TraeCN 1.107.x; do not claim other platforms |
| Public MCP surface | contract v5, exactly 20 ordered tools |

The public repository contains the reviewed runtime source and release assets.
The release manifest records the exact public source commit and artifact hashes.

## Release build

Use Node.js 22. Do not use a green run from a different default runtime as the
release result.

```sh
nvm use 22
npm ci
npm run verify:static
npm run pack:skill
```

`npm run pack:skill` creates:

- `dist/traecn-mcp-skill.tgz` and `.zip`;
- `dist/traecn-mcp-<version>.mcpb`, validated with the pinned official
  MCPB CLI and normalized for byte-identical rebuilds;
- `dist/traecnclaw-<version>.tgz`, whose internal npm identity is
  `@luckycat133/traecnclaw` even though the canonical source package remains
  private and unscoped;
- `dist/traecn-mcp-release.json`, recording source revision, dirty state,
  artifact size, SHA-256, package identity, and install hints.

The generated files are ignored by git. Build them from the clean tagged
commit; a manifest with `sourceDirty: true` is evidence for testing only and
must not be published.

## Required release gate

Run focused tests first, then the complete gate:

```sh
npm run audit:all
npm run verify
npm run test:release
npm run verify:release-manifest
```

The release is blocked if any of these are true:

- source, lockfile, Skill, or OpenClaw versions differ;
- the tree contains unrelated or local-only files in the release commit;
- an archive contains credentials, `.env`, raw TraeCN profile data, or a
  private canonical URL where a public link is required;
- MCPB validation fails or two builds differ;
- a clean npm/MCPB/Homebrew install does not discover exactly 20 tools in the
  stable order;
- the mock clean-room task does not complete;
- a live compatibility claim lacks current live UAT evidence.

## Tag and GitHub Releases

After the release commit is merged and the full gate passes:

1. Tag the exact commit `vX.Y.Z` and push the tag.
2. Publish the generated assets and manifest in the public GitHub Release.
3. Download the assets anonymously and verify their SHA-256 values;
   local `dist/` files alone are not public-channel evidence.

The root Dockerfile and `glama.json` are inspection metadata. They do
not turn TRAECNclaw into a hosted service and must never include a gateway token
or mock bridge.

## Scoped npm publication

The source `package.json` keeps `"private": true` to guard against accidental
direct npm publication. `scripts/build-npm-package.js`
stages a separate public tarball with:

- package name `@luckycat133/traecnclaw`;
- the release version and `mcpName`;
- public repository, homepage, and issue URLs;
- `os: ["darwin"]` and public publish configuration;
- the `traecn-mcp` binary.

Publish only the generated tarball:

```sh
npm run build:npm-package
npm publish dist/traecnclaw-<version>.tgz --access public
```

Then verify the registry, not the local cache:

```sh
npm view @luckycat133/traecnclaw@<version> \
  name version dist.integrity dist.tarball mcpName os
npm install --global @luckycat133/traecnclaw@<version>
traecn-mcp help
```

Use a temporary prefix for automated stdio discovery so an existing global
install cannot mask a broken package. Record the registry URL, integrity, clean
install path, 20-tool result, and task smoke result in the channel ledger.

If the maintainer owns the historical unscoped package, deprecate it only after
the scoped package is live and verified. The message must point to
`@luckycat133/traecnclaw`; never republish current code under the old identity.

## Official MCP Registry and PulseMCP

The Registry row is blocked until the exact scoped npm version is public.
Generate metadata only after that check:

```sh
npm run build:registry-metadata
mcp-publisher validate
mcp-publisher publish
```

Run the publisher from the directory containing generated `server.json`, use
the official GitHub authentication flow, then query the public Registry API for
`io.github.Luckycat133/traecnclaw`. Confirm the package, version, stdio
transport, repository, secret flag, and install command.

PulseMCP normally ingests Official Registry entries. Wait for that ingestion
and inspect it before any manual submission. A delayed aggregator is
`pending-index`, not published.

## MCPB and Smithery Local

The MCPB manifest follows the official schema and lists 20 tool objects with
names and descriptions. It exposes only gateway host, port, token, and client
ID configuration. Build and validate it with:

```sh
npm run build:mcpb
npm exec --package=@anthropic-ai/mcpb@2.1.2 \
  --call='mcpb validate dist/traecn-mcp-<version>.mcpb'
```

Install the exact bundle into a clean compatible desktop host and verify all 20
tools before publishing it through Smithery Local. Smithery URL mode is not
valid because TRAECNclaw does not expose a public Streamable HTTP service.
Record the Smithery page, bundle digest, downloaded digest, host, and tool count.

Smithery CLI 4.11.1 validates the optional MCPB `manifest.tools` summaries as
full MCP tool definitions and rejects official MCPB 0.3 summaries that contain
only `name` and `description`. Build the explicitly named compatibility bundle
when that defect is present:

```bash
npm run build:mcpb -- --smithery-compatible
```

This variant omits only the optional manifest summaries. It keeps the same
server, version, local stdio transport, macOS restriction, and runtime 20-tool
contract. Record its separate digest and never substitute it for the immutable
GitHub Release MCPB. After publication, the Smithery page must say `Local`.

## Homebrew

Render the formula from the clean release manifest:

```sh
npm run build:homebrew-formula -- \
  --manifest dist/traecn-mcp-release.json \
  --out Formula/traecnclaw.rb
```

The formula downloads the pinned GitHub Release tarball. Before publishing the
formula, download that tarball and verify its SHA-256 against the release
manifest. The formula test exercises CLI help and a stdio initialize/tools-list
exchange with exactly 20 tools. Verify the public tap on a clean install:

```sh
brew tap Luckycat133/traecn-mcp https://github.com/Luckycat133/traecn-mcp.git
brew install Luckycat133/traecn-mcp/traecnclaw
brew test Luckycat133/traecn-mcp/traecnclaw
traecn-mcp help
```

Homebrew installs the local operator CLI and stdio runtime. Users install the
Agent Skill separately.

## Agent Skill and ClawHub

The public mirror is the public provenance source. After its release commit is
known, dry-run and publish the generated Skill path:

```sh
clawhub publish skills/traecn-mcp \
  --slug traecn-mcp \
  --name "TRAECNclaw MCP" \
  --version <version> \
  --tags latest,mcp,agent-skills,codex,openclaw,traecn \
  --source-repo Luckycat133/traecn-mcp \
  --source-commit <public-commit> \
  --source-ref main \
  --source-path .codex/skills/traecn-mcp \
  --changelog "See CHANGELOG.md for verified release changes."
clawhub inspect traecn-mcp --versions --limit 3
```

The public mirror stores the Skill under `.codex/skills/traecn-mcp` even
though the canonical source path is `skills/traecn-mcp`.

Also test the public repository through Skills CLI:

```sh
npx skills add https://github.com/Luckycat133/traecn-mcp \
  --skill traecn-mcp \
  -g
```

Restart the host after installing or updating the Skill.

## Directory submissions

Search each site for an existing record before submitting. Reconcile the
existing record rather than creating a duplicate. Every listing must use the
canonical copy in [`distribution/listing-copy.md`](../distribution/listing-copy.md)
and state:

- local stdio server on the user's Mac;
- TraeCN desktop and Node.js 22 requirements;
- exactly 20 tools;
- public mirror and matching release;
- no cloud-hosted control claim;
- no unscoped npm 0.3.1 install path;
- tested macOS/TraeCN versions only.

Browser submissions, claims, public issues, and social posts are external
representational actions. Prepare and review the exact payload first, then get
action-time confirmation before the final click.

## Promotion evidence

Promotion requires real artifacts, not mock claims:

- architecture and trust-boundary diagram;
- three concrete use cases;
- limitation card covering macOS, local runtime, TraeCN version, and transport;
- 60–90 second real host recording with secrets and unrelated content removed;
- five-minute setup tutorial;
- Chinese and global copy linked to the verified install page;
- screenshots or recordings of the public listing and generated install path.

Use [`LAUNCH-KIT.md`](LAUNCH-KIT.md) for the prepared copy and shot list. A
draft or unrecorded shot list is not a completed public launch asset.

## Definition of done

A selected channel is done only when all four items exist:

1. public page or package/version URL;
2. generated install/download path inspected;
3. clean install and appropriate runtime test passed;
4. evidence and date recorded in `CHANNEL-LEDGER.md`.

Authentication, payment, maintainer approval, a browser confirmation, real
TraeCN availability, or indexing delay can be legitimate external blockers.
Record the exact blocker and resume step; do not mark the row complete or
silently substitute a different product surface.
