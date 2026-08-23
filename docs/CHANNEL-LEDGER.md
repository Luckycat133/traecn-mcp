# TRAECNclaw Channel Ledger

Last checked: 2026-08-24 (Asia/Shanghai). Target release: 0.5.9.

Status meanings:

- `verified`: public surface inspected and its install/runtime path tested;
- `ready`: canonical payload is prepared but not yet published;
- `pending-review` or `pending-index`: an external site owns the next step;
- `blocked-external`: credentials, user confirmation, host state, or third-party
  availability is required;
- `stale`: a public page exists but does not describe the target release;
- `not-selected`: deliberately excluded from this product model.

No row below implies another row. In particular, a successful upload is not a
verified listing, and a directory scan is not a runtime test.

## Release and install channels

| Channel | Current public state | Target 0.5.9 state | Evidence / next exact step | Status |
| --- | --- | --- | --- | --- |
| Canonical source | PR [#27](https://github.com/Luckycat133/TRAECNclaw/pull/27) merged the 0.5.9 release source; immutable `v0.5.9` resolves to `4edb1b3`; post-release Glama/Homebrew template fixes are on `main` | Exact release source and later distribution-template corrections remain distinguishable | Node 22 `test:release` passed on the tag commit; inspect the tag before every republish | verified |
| Canonical GitHub Release | Private [`v0.5.9`](https://github.com/Luckycat133/TRAECNclaw/releases/tag/v0.5.9) contains the scoped npm tarball, MCPB, two Skill archives, and provenance manifest | Downloaded bytes match every recorded SHA-256 | GitHub Actions is disabled for this repository, so the identical locally passed Node 22 workflow was run before manual Release creation | verified |
| Public mirror | Public [`v0.5.9`](https://github.com/Luckycat133/traecnclaw-mcp-skill/releases/tag/v0.5.9) contains six assets; `main@5ad3a3e` also carries the canonical Glama inspection fix | Public source, Release assets, provenance, and inspection entry are current | Downloaded all assets and matched their SHA-256; regenerate only from canonical source | verified |
| Scoped npm | `@luckycat133/traecnclaw` is not published | Public 0.5.9 with verified `mcpName`, macOS restriction, bins, and 20 tools | Complete npm web login, publish generated tarball, clean-prefix test | blocked-external |
| Historical npm | Unscoped `traecnclaw@0.3.1` is still `latest` | Deprecation message points to scoped package; never republish current code here | Requires npm ownership/auth after scoped package is verified | blocked-external |
| MCPB artifact | Public 0.5.9 MCPB SHA-256 is `05baf8549ba75386b7f6586138608334d7a5d261109c2d24c2f35c231990dd1e`; official validation, deterministic rebuild, release download, and clean-room 20-tool discovery passed | Preserve the exact public bundle for desktop-host and Smithery checks | Install this byte-identical bundle in Claude Desktop and compare the downloaded Smithery bundle later | verified |
| Claude Desktop MCPB host | Claude Desktop is installed but was logged out during verification | Exact 0.5.9 bundle installed and 20 tools visible | User logs into Claude Desktop; install and inspect extension | blocked-external |
| Smithery Local | No current MCPB server listing; an older third-party Skill page is stale | 0.5.9 Local/MCPB listing and downloaded-bundle verification | Complete Smithery login; publish exact MCPB, download and compare digest | blocked-external |
| Official MCP Registry | Active [`io.github.Luckycat133/traecnclaw`](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.Luckycat133%2Ftraecnclaw) 0.3.1 entry uses the historical unscoped package and legacy environment names | Reconcile the existing identity with 0.5.9 backed by scoped npm; do not create a lowercase duplicate | Publish npm first, render/validate matching metadata, authenticate publisher, publish a new version, then query exact identity | blocked-external |
| PulseMCP | No verified current entry | Correct downstream entry | Wait for Official Registry ingestion, then inspect; do not duplicate early | pending-index |
| Homebrew tap | [`Luckycat133/tap/traecnclaw`](https://github.com/Luckycat133/homebrew-tap) is 0.5.9 at `329f2cc`; syntax, style, strict online audit, real upgrade, CLI help, and exact 20-tool `brew test` passed | Keep formula generated from the release manifest digest | Re-run the public audit/install path for future releases | verified |
| ClawHub | `traecnclaw-mcp` latest and all six tags are 0.5.9; scanner result is CLEAN; publication source is public mirror commit `5ad3a3e` | Published Skill version, provenance, and scanner agree | Reinspect after future scanner/index changes | verified |
| Skills CLI | `npx skills add` cloned the public repository into a clean temporary project, installed metadata version 0.5.9, and passed all 10 launcher tests | Public install path is reproducible | Re-test after future Skill changes | verified |
| skills.sh | [Detail page](https://www.skills.sh/luckycat133/traecnclaw-mcp-skill/traecnclaw-mcp) shows the correct repository, Skill content, and install command; audits are Trust Hub Warn, Socket Pass, Snyk Pass; install count is still unavailable | Keep source/install current and do not invent counts | Site-generated JSON-LD incorrectly says `Cross-platform`; retain the repository's explicit macOS limitation and request correction if the site exposes a channel | verified |

## Directory and catalog channels

| Channel | Current public state | Next exact step | Status |
| --- | --- | --- | --- |
| Glama | [Existing listing](https://glama.ai/mcp/servers/Luckycat133/traecnclaw-mcp-skill) shows verified maintainers, but its last sync is public commit `d81c119` and the overview/schema still describe 0.5.6 and legacy tool-profile configuration | With action-time confirmation, click `Sync Server`, verify public commit `5ad3a3e`, then inspect version/tools/score/install text; do not repeat Claim | blocked-external |
| Glama Docker preflight | After reproducing npm `EBADPLATFORM`, the canonical inspection template bypasses only npm's platform guard. Both the root Dockerfile and the current Glama-generated `mcp-proxy` shape were reproduced locally with Node.js 22 and the public 0.5.9 archive: MCP reported version 0.5.9 and exactly 20 tools, while a tool call without the user's gateway returned actionable `ECONNREFUSED` rather than mock output | With action-time confirmation, run private `Build` using the pinned public commit and verified inputs; never click `Build & Release` for this local-first product | verified |
| MCP.Directory Skill | Submission was already sent. A full 2026-08-24 pass over the public Skills API (9,291 rows at inspection time) found no `traecn` match | Wait and inspect; reconcile if rejected, never duplicate | pending-review |
| MCP.Directory Server | Submission was already sent. A full 2026-08-24 pass over the public Servers API (2,303 rows at inspection time) found no `traecn` match | Wait and inspect the generated install path; reconcile if rejected | pending-review |
| AwesomeSkills.dev | No exact entry found; public GitHub payload is prepared | With action-time confirmation, submit the deep Skill URL and inspect the live page/install | blocked-external |
| MCP Server Hub (`mcpserver.dev`) | No exact entry found; form payload is prepared | With action-time confirmation, submit URL/title/description/category/keywords, then inspect | blocked-external |
| mcp.so | No exact entry found; current submission path is a public GitHub issue | With action-time confirmation, open the prepared issue and inspect the resulting listing | blocked-external |
| mcpservers.org | [Existing page](https://mcpservers.org/servers/luckycat133/traecnclaw-mcp-skill) still renders 0.5.6 documentation. Its one-click refresh action was sent on 2026-08-24 and the page now shows `Requested`; the control exposed no preview or custom-message step | Wait for the crawler, then verify version/install/platform copy; reconcile rather than submit a duplicate | pending-review |
| Smithery legacy Skill page | Existing third-party `xingmiao201081/traecnclaw-mcp` page contains stale profiles | Do not treat it as the MCPB server listing; request reconciliation after current Local listing exists | stale |
| `punkpeye/awesome-mcp-servers` | No exact open PR or issue was found in the 2026-08-24 GitHub search | After Glama evidence and action-time confirmation, follow current contribution rules and open one non-duplicate submission | blocked-external |
| GitHub MCP Registry | Not selected as an independent runtime | Use public mirror and Official MCP Registry metadata only | not-selected |
| Smithery URL mode | No public Streamable HTTP product exists | Keep excluded; use Smithery Local/MCPB | not-selected |
| Glama hosted runtime | Cannot transparently reach the user's local Mac/TraeCN | Keep excluded; listing and schema inspection only | not-selected |

## Promotion and product work

| Deliverable | Current state | Next exact step | Status |
| --- | --- | --- | --- |
| Canonical listing copy | Checked in at `distribution/listing-copy.md` | Reuse verbatim, changing only site-specific length/fields | ready |
| Architecture, use cases, limitations, post drafts | Checked in at `docs/LAUNCH-KIT.md` | Render/capture against the final public URLs | ready |
| 60–90 second demo | Shot list prepared; no new verified recording | Record a real local TraeCN task after final 0.5.9 install, redact and review | blocked-external |
| Five-minute tutorial | Script prepared; no new verified recording | Record clean installation, MCP host connection, task, result, and recovery | blocked-external |
| Chinese/global launch posts | Drafts prepared; not posted | Insert verified links/media, review exact payload, obtain confirmation, post | blocked-external |
| Web Control Console v1 | Design direction awaiting user selection under the required brainstorming workflow | Approve A/B/C direction, review spec, then implement and run browser acceptance | blocked-external |

## Resume checklist

1. Complete npm web login, publish and clean-test the scoped package, then
   deprecate the historical unscoped package if ownership permits.
2. Publish the already validated Official Registry metadata and wait for
   PulseMCP ingestion.
3. Log into Claude Desktop, install the exact MCPB, then authenticate and
   publish the same bundle through Smithery Local.
4. Obtain action-time confirmation for Glama sync/private Build,
   AwesomeSkills.dev, MCP Server Hub, mcp.so, and the curated GitHub list.
   Monitor the already-requested mcpservers.org refresh. Do not create a Glama
   hosted Release.
5. Re-run strict live UAT with the TRAECNclaw project actually open in TraeCN;
   current 1.107.1 doctor/DOM/adapter checks pass, but session UAT correctly
   rejected the currently open `empty-project` workspace.
6. Obtain Web Console design approval before implementation; record/review real
   launch media and exact post payloads before public posting.
