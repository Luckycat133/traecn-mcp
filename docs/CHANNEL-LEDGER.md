# TRAECNclaw Channel Ledger

Last checked: 2026-08-24 (Asia/Shanghai). Target release: 0.6.0.

Status meanings:

- `verified`: public surface inspected and its install/runtime path tested;
- `listed`: public discovery page is current, but the channel intentionally
  has no runnable install path;
- `preflight-failed`: the exact submission path was exercised but the external
  service did not accept it;
- `ready`: canonical payload is prepared but not yet published;
- `pending-review` or `pending-index`: an external site owns the next step;
- `blocked-external`: credentials, user confirmation, host state, or third-party
  availability is required;
- `stale`: a public page exists but does not describe the target release;
- `not-selected`: deliberately excluded from this product model.

No row below implies another row. In particular, a successful upload is not a
verified listing, and a directory scan is not a runtime test.

## Release and install channels

| Channel | Current public state | Target 0.6.0 state | Evidence / next exact step | Status |
| --- | --- | --- | --- | --- |
| Canonical source | Immutable `v0.5.9` resolves to `4edb1b3`; the approved Web Control Console design is on `main`, and the 0.6.0 implementation is isolated on `feat/web-control-console-v1` | Merge one reviewable 0.6.0 source commit line only after Node 22 release gates | Complete the feature PR, verify CI, merge, then tag the exact merge result | ready |
| Local LaunchAgent gateway | `com.traecnclaw.gateway` is loaded from the canonical checkout, owns `127.0.0.1:8788`, and reports live version 0.5.9 | Keep the long-running local service aligned with the checked-out release | Recovered a competing non-launchd listener, confirmed the final listener has PPID 1, then passed doctor and strict non-delegating live UAT | verified |
| Canonical GitHub Release | Private [`v0.5.9`](https://github.com/Luckycat133/TRAECNclaw/releases/tag/v0.5.9) contains the previous six verified assets | Private `v0.6.0` carries the exact generated artifacts and provenance manifest | Create only from the verified tag, download every asset, and compare size/SHA-256/source revision | ready |
| Public mirror | Public [`v0.5.9`](https://github.com/Luckycat133/traecnclaw-mcp-skill/releases/tag/v0.5.9) contains six verified assets; `main@5ad3a3e` carries the last canonical inspection fix | Regenerated public source and `v0.6.0` assets match the canonical release manifest | Regenerate from the exact canonical tag, push/tag/release, then download and compare all assets | ready |
| Scoped npm | `@luckycat133/traecnclaw` is not published | Public 0.6.0 with verified `mcpName`, Darwin restriction, bins, 20 tools, and Web Control Console assets | Complete npm CLI web login, publish the generated tarball, then perform a registry-origin clean-prefix test | blocked-external |
| Historical npm | Unscoped `traecnclaw@0.3.1` is still `latest` | Deprecation message points to scoped package; never republish current code here | Requires npm ownership/auth after scoped package is verified | blocked-external |
| MCPB artifact | Public 0.5.9 MCPB SHA-256 is `05baf8549ba75386b7f6586138608334d7a5d261109c2d24c2f35c231990dd1e`; official validation, deterministic rebuild, release download, and clean-room 20-tool discovery passed | Deterministic 0.6.0 bundle includes the fixed console assets and preserves the 20-tool manifest | Build twice during `test:release`, then compare public downloads before any host/listing claim | ready |
| Claude Desktop MCPB host | Claude Desktop is installed but was logged out during verification | Exact 0.6.0 bundle installed and 20 tools visible | This is an independent authenticated host check; it is not required for npm or the core release | blocked-external |
| Smithery Local | No current MCPB server listing; an older third-party Skill page is stale | 0.6.0 Local/MCPB listing and downloaded-bundle verification | Complete Smithery login; publish exact MCPB, download and compare digest | blocked-external |
| Official MCP Registry | Active [`io.github.Luckycat133/traecnclaw`](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.Luckycat133%2Ftraecnclaw) 0.3.1 entry uses the historical unscoped package and legacy environment names | Reconcile the existing identity with 0.6.0 backed by scoped npm; do not create a lowercase duplicate | Publish npm first, render/validate matching metadata, authenticate publisher, publish a new version, then query exact identity | blocked-external |
| PulseMCP | No verified current entry | Correct downstream entry | Wait for Official Registry ingestion, then inspect; do not duplicate early | pending-index |
| Homebrew tap | [`Luckycat133/tap/traecnclaw`](https://github.com/Luckycat133/homebrew-tap) is 0.5.9 at `329f2cc`; syntax, style, strict online audit, real upgrade, CLI help, and exact 20-tool `brew test` passed | Formula 0.6.0 is rendered from the public tarball digest and passes the same public install/test path | Update only after public assets exist, then run syntax, style, strict online audit, upgrade, CLI, console-file, and 20-tool checks | ready |
| ClawHub | `traecnclaw-mcp` latest and all six tags are 0.5.9; scanner result is CLEAN; publication source is public mirror commit `5ad3a3e` | 0.6.0 Skill version, public provenance, and scanner agree | Publish from the regenerated public mirror, then inspect version/source/scan independently | ready |
| Skills CLI | The public repository installs metadata version 0.5.9 and its launcher passes all 10 focused tests | Public 0.6.0 install is reproducible from the regenerated mirror | Re-run list/install/launcher tests after the mirror update | ready |
| skills.sh | [Detail page](https://www.skills.sh/luckycat133/traecnclaw-mcp-skill/traecnclaw-mcp) shows the correct repository, Skill content, and install command; audits are Trust Hub Warn, Socket Pass, Snyk Pass; install count is still unavailable | Keep source/install current and do not invent counts | Site-generated JSON-LD incorrectly says `Cross-platform`; retain the repository's explicit macOS limitation and request correction if the site exposes a channel | verified |

## Directory and catalog channels

| Channel | Current public state | Next exact step | Status |
| --- | --- | --- | --- |
| Glama | [Existing listing](https://glama.ai/mcp/servers/Luckycat133/traecnclaw-mcp-skill) has verified maintainers and is synced to public mirror commit `5ad3a3e`; the overview now shows canonical 0.5.9 copy, with no 0.5.6 or removed tool-profile text | Keep the page as discovery/inspection only. The public Schema and Score correctly have no hosted release/install path because a cloud container cannot reach the user's Mac | listed |
| Glama Docker preflight | Private Build test `01a03167-9fc1-7cb1-ae25-504060a86421` succeeded from pinned commit `5ad3a3e` with Node.js 22 and the public 0.5.9 archive; initialization reported server version 0.5.9 and discovery returned the exact 20 tools | Preserve the successful private test; do not click `Create Release` or `Build & Release`. Glama's Score page confirms that public coherence/tool grades require the deliberately unselected hosted release | verified |
| MCP.Directory Skill | Submission was already sent. A full 2026-08-24 pass over the public Skills API (9,291 rows at inspection time) found no `traecn` match | Wait and inspect; reconcile if rejected, never duplicate | pending-review |
| MCP.Directory Server | Submission was already sent. A full 2026-08-24 pass over the public Servers API (2,303 rows at inspection time) found no `traecn` match | Wait and inspect the generated install path; reconcile if rejected | pending-review |
| AwesomeSkills.dev | No exact entry exists. The confirmed deep Skill URL was submitted twice, but the site returned `Network error. Please try again.` and created no listing | Retry the same deep URL only after the submission service recovers, then inspect parsed name/platform/source/install fields | preflight-failed |
| MCP Server Hub (`mcpserver.dev`) | No exact entry exists. The anonymous form was filled with canonical URL/title/description/category/keywords, but it created no record; the account page requires Google sign-in | Complete the explicit Google account/OAuth handoff, submit once, then inspect the generated listing and install copy | blocked-external |
| mcp.so | Public issue [chatmcp/mcpso#3717](https://github.com/chatmcp/mcpso/issues/3717) requests the current local stdio/macOS listing and explicitly rejects the historical unscoped package | Wait for directory maintainers, then inspect and correct the generated listing rather than opening a duplicate | pending-review |
| mcpservers.org | [Existing page](https://mcpservers.org/servers/luckycat133/traecnclaw-mcp-skill) still renders 0.5.8 provenance. Its one-click refresh action was re-sent on 2026-08-24 and the page now shows `Requested`; the control exposed no preview or custom-message step | Wait for the crawler, then verify 0.5.9 version/install/platform copy; reconcile rather than submit a duplicate | pending-review |
| Smithery legacy Skill page | Existing third-party `xingmiao201081/traecnclaw-mcp` page contains stale profiles | Do not treat it as the MCPB server listing; request reconciliation after current Local listing exists | stale |
| `punkpeye/awesome-mcp-servers` | Existing PR [#10724](https://github.com/punkpeye/awesome-mcp-servers/pull/10724) is open and mergeable. Commit `c3bcdd2` removed the incorrect Windows marker and replaced stale profile claims; both submission checks pass | Maintainer review currently asks for a Glama quality score. The PR now records the successful private build and asks for a local-only exception because Glama exposes that score only after a misleading hosted release | pending-review |
| GitHub MCP Registry | Not selected as an independent runtime | Use public mirror and Official MCP Registry metadata only | not-selected |
| Smithery URL mode | No public Streamable HTTP product exists | Keep excluded; use Smithery Local/MCPB | not-selected |
| Glama hosted runtime | Cannot transparently reach the user's local Mac/TraeCN | Keep excluded; listing and schema inspection only | not-selected |

## Promotion and product work

| Deliverable | Current state | Next exact step | Status |
| --- | --- | --- | --- |
| Canonical listing copy | Checked in at `distribution/listing-copy.md` | Reuse verbatim, changing only site-specific length/fields | ready |
| Architecture, use cases, limitations, post drafts | Checked in at `docs/LAUNCH-KIT.md` | Render/capture against the final public URLs | ready |
| 60–90 second demo | Shot list updated for 0.6.0; no new verified recording | Record a real local TraeCN task and Web Control Console flow after final 0.6.0 install, redact and review | blocked-external |
| Five-minute tutorial | Script prepared; no new verified recording | Record clean installation, MCP host connection, task, result, and recovery | blocked-external |
| Chinese/global launch posts | Drafts prepared; not posted | Insert verified links/media, review exact payload, obtain confirmation, post | blocked-external |
| Live TraeCN compatibility | Public MCP `traecn_open_workspace` selected the canonical repository; DOM inspection and strict non-delegating UAT passed against TraeCN 1.107.1 with verified adapter `traecn-1.107` | Repeat for future TraeCN/release compatibility claims; this run did not send a model task or spend quota | verified |
| Web Control Console v1 | Direction B, specification, implementation plan, fixed assets, authenticated APIs/WebSockets, exact task interactions, package coverage, and mock browser acceptance are complete on the 0.6.0 candidate | Preserve one gateway-owned lifecycle and repeat live/browser checks after installation from the final public artifact | verified |

## Resume checklist

1. Merge, tag, and publish the exact 0.6.0 candidate; regenerate the public
   mirror and verify every downloaded artifact against its manifest.
2. Complete npm CLI web login, publish and clean-test the scoped package, then
   deprecate the historical unscoped package if ownership permits.
3. Publish the already validated Official Registry metadata and wait for
   PulseMCP ingestion.
4. Log into Claude Desktop, install the exact MCPB, then authenticate and
   publish the same bundle through Smithery Local.
5. Retry AwesomeSkills.dev after its submission API recovers and complete the
   MCP Server Hub Google account handoff. Monitor mcp.so issue #3717, awesome
   PR #10724, MCP.Directory, and mcpservers.org without duplicates. Keep Glama
   hosted Release deliberately absent.
6. Re-run strict non-delegating live UAT against the installed 0.6.0 release;
   record/review real launch media and exact post payloads before public posting.
