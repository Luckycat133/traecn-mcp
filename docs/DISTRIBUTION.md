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
| Private source | `Luckycat133/TRAECNclaw` |
| Public distribution mirror | `Luckycat133/traecnclaw-mcp-skill` |
| MCP server name | `io.github.Luckycat133/traecnclaw` (existing Registry identity) |
| Current npm package | `@luckycat133/traecnclaw` |
| Historical npm package | `traecnclaw@0.3.1`; never advertise as current |
| Agent Skill | `traecnclaw-mcp` |
| Homebrew formula | `Luckycat133/tap/traecnclaw` |
| Transport | local stdio on the same Mac as TraeCN |
| Platform evidence | macOS with TraeCN 1.107.x; do not claim other platforms |
| Public MCP surface | contract v5, exactly 20 ordered tools |

The canonical repository stays private unless its full history is deliberately
approved for disclosure. Public sites receive only the generated mirror,
release assets, and the exact canonical `SOURCE_REVISION`.

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

- `dist/traecnclaw-mcp-skill.tgz` and `.zip`;
- `dist/traecnclaw-mcp-<version>.mcpb`, validated with the pinned official
  MCPB CLI and normalized for byte-identical rebuilds;
- `dist/traecnclaw-<version>.tgz`, whose internal npm identity is
  `@luckycat133/traecnclaw` even though the canonical source package remains
  private and unscoped;
- `dist/traecnclaw-mcp-release.json`, recording source revision, dirty state,
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

## Tag, Releases, and public mirror

After the release commit is merged and the full gate passes:

1. Tag the exact commit `vX.Y.Z` and push the tag.
2. Verify or create the private canonical GitHub Release with the generated
   assets and manifest.
3. Regenerate the public mirror from that exact full commit:

   ```sh
   node scripts/public-mirror.js \
     --mirror /path/to/traecnclaw-mcp-skill \
     --revision <full-canonical-commit>
   node scripts/public-mirror.js --check \
     --mirror /path/to/traecnclaw-mcp-skill \
     --revision <full-canonical-commit>
   ```

4. Scan the generated mirror, commit it, tag the public commit, and create the
   public Release with the exact same assets.
5. Download the assets from the public Release and verify their SHA-256 values;
   local `dist/` files alone are not public-channel evidence.

The mirror's root Dockerfile and `glama.json` are inspection metadata. They do
not turn TRAECNclaw into a hosted service and must never include a gateway token
or mock bridge.

## Scoped npm publication

The private canonical `package.json` intentionally retains
`"name": "traecnclaw"` and `"private": true`. `scripts/build-npm-package.js`
stages a separate public tarball with:

- package name `@luckycat133/traecnclaw`;
- the release version and `mcpName`;
- public repository, homepage, and issue URLs;
- `os: ["darwin"]` and public publish configuration;
- the `traecnclaw` and `traecnclaw-mcp` binaries.

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
traecnclaw --help
traecnclaw-mcp
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
npm exec --yes --package=@anthropic-ai/mcpb@2.1.2 -- \
  mcpb validate dist/traecnclaw-mcp-<version>.mcpb
```

Install the exact bundle into a clean compatible desktop host and verify all 20
tools before publishing it through Smithery Local. Smithery URL mode is not
valid because TRAECNclaw does not expose a public Streamable HTTP service.
Record the Smithery page, bundle digest, downloaded digest, host, and tool count.

## Homebrew

Render the formula from the clean release manifest:

```sh
npm run build:homebrew-formula -- \
  --manifest dist/traecnclaw-mcp-release.json \
  --out /path/to/homebrew-tap/Formula/traecnclaw.rb
```

The formula URL and SHA-256 must point to the public Release tarball. Its test
must exercise both `traecnclaw --help` and a real stdio initialize/tools-list
exchange with exactly 20 tools. Verify the public tap on a clean install:

```sh
brew update
brew audit --strict Luckycat133/tap/traecnclaw
brew style Luckycat133/tap/traecnclaw
brew reinstall Luckycat133/tap/traecnclaw
brew test Luckycat133/tap/traecnclaw
traecnclaw --help
```

Homebrew installs the local operator CLI and stdio runtime. Users install the
Agent Skill separately.

## Agent Skill and ClawHub

The public mirror is the public provenance source. After its release commit is
known, dry-run and publish the generated Skill path:

```sh
clawhub publish skills/traecnclaw-mcp \
  --slug traecnclaw-mcp \
  --name "TRAECNclaw MCP" \
  --version <version> \
  --tags latest,mcp,agent-skills,codex,openclaw,traecn \
  --source-repo Luckycat133/traecnclaw-mcp-skill \
  --source-commit <public-commit> \
  --source-ref main \
  --source-path .codex/skills/traecnclaw-mcp \
  --changelog "See CHANGELOG.md for verified release changes."
clawhub inspect traecnclaw-mcp --versions --limit 3
```

The public mirror stores the Skill under `.codex/skills/traecnclaw-mcp` even
though the canonical source path is `skills/traecnclaw-mcp`.

Also test the public repository through Skills CLI:

```sh
npx skills add https://github.com/Luckycat133/traecnclaw-mcp-skill \
  --skill traecnclaw-mcp \
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
