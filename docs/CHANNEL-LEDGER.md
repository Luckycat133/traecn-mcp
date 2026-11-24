# TRAECNclaw Channel Ledger

Last checked: 2026-08-25 (Asia/Shanghai). Target release: 0.6.0.

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
| Canonical source | Immutable `v0.6.0` and `origin/main` resolve to merge commit `40bcf7707ed9b0ff7938aea8e511d0b87d300705`; PR [#34](https://github.com/Luckycat133/TRAECNclaw/pull/34) is merged | Keep the tagged source and generated release manifest immutable | Node 22 `test:release` passed from the exact clean merge result before tagging | verified |
| Local LaunchAgent gateway | `com.traecnclaw.gateway` is loaded from the canonical checkout, owns `127.0.0.1:8788`, and reports live version 0.5.9 | Keep the long-running local service aligned with the checked-out release | Recovered a competing non-launchd listener, confirmed the final listener has PPID 1, then passed doctor and strict non-delegating live UAT | verified |
| Canonical GitHub Release | Private [`v0.6.0`](https://github.com/Luckycat133/TRAECNclaw/releases/tag/v0.6.0) contains all six generated assets from tag `v0.6.0`; every downloaded asset was byte-compared and its SHA-256 matches the release manifest | Preserve the verified immutable release | Release tarball SHA-256 is `ae7c2a9170e4525bb2b0bab8f9009c8a19ce7b68ff298bbceccc9e6fbbeb9f33`; MCPB SHA-256 is `437a8ff85c8ab377c709cf6446739809a0112ddf1731ea1b85dda1eb00480e00` | verified |
| Public mirror | Public [`v0.6.0`](https://github.com/Luckycat133/traecnclaw-mcp-skill/releases/tag/v0.6.0) resolves to mirror merge `2d7fc66dfc86cf6a0967b87d0e28f5be087ae308`; all six downloaded assets byte-match the canonical Release | Keep the generated mirror, tag, Release, and `SOURCE_REVISION` aligned | PR [#8](https://github.com/Luckycat133/traecnclaw-mcp-skill/pull/8) merged; public tarball SHA-256 is `ae7c2a9170e4525bb2b0bab8f9009c8a19ce7b68ff298bbceccc9e6fbbeb9f33` | verified |
| Scoped npm | Public [`@luckycat133/traecnclaw@0.6.0`](https://www.npmjs.com/package/@luckycat133/traecnclaw/v/0.6.0) has integrity `sha512-4wCZmtskz5Cge/rF474OxsfAvTux1ln0Ry63V9JW3vLS8mcZMjivO69UZ4gHJ9rHy5rEJ9UeGzMrhdO4RC5DcA==` | Preserve scoped identity, Darwin restriction, exact `mcpName`, bins, and console assets | Registry-origin clean-prefix install passed CLI help, all four Web Control Console assets, and exact 20-tool stdio discovery; temporary bypass-2FA token was revoked and `npm token list` is empty | verified |
| Historical npm | Unscoped `traecnclaw@0.3.1` is still `latest`; current account ownership is confirmed | Deprecation message points to `@luckycat133/traecnclaw`; never republish current code here | Exact deprecation request is blocked by npm's 2FA-or-bypass-token policy (`E403`) after the temporary publish token was revoked | blocked-external |
| MCPB artifact | Public 0.6.0 MCPB SHA-256 is `437a8ff85c8ab377c709cf6446739809a0112ddf1731ea1b85dda1eb00480e00`; official validation, deterministic rebuild, Release download comparison, and clean-room 20-tool discovery passed | Preserve the deterministic bundle and matching manifest | Both canonical and public Release downloads byte-match the verified artifact | verified |
| Claude Desktop MCPB host | Claude Desktop is installed but was logged out during verification | Exact 0.6.0 bundle installed and 20 tools visible | This is an independent authenticated host check; it is not required for npm or the core release | blocked-external |
| Smithery Local | [`xingmiao201081/traecnclaw-mcp`](https://smithery.ai/servers/xingmiao201081/traecnclaw-mcp) is published as `Local`; deployment `c8e5dbc8-6d19-4a96-a940-8354874c5373` is `SUCCESS` | Preserve local stdio semantics and verify the generated Quick Start when Smithery repairs its keychain dependency | Smithery CLI 4.11.1 rejects valid MCPB 0.3 tool summaries, so the published compatibility bundle omits only that optional manifest array (SHA-256 `893bf23de1eb9060f59aab93b0efb2b336c5a80aadf1b3cebbde32bc48da46cd`). Public page inspection passed, but both Node 26.7.0 and 22.23.2 Quick Start fail at `keytar` with `setPassword is not a function`, before a connection or tool list can be created | preflight-failed |
| Official MCP Registry | Active [`io.github.Luckycat133/traecnclaw@0.6.0`](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.Luckycat133%2Ftraecnclaw) is latest and points to `@luckycat133/traecnclaw@0.6.0` over stdio with current gateway variables | Keep the existing case-sensitive identity; 0.3.1 remains immutable historical data with `isLatest:false` | `mcp-publisher` 1.8.1 validation and publication passed; the public API reports 0.6.0 active and latest | verified |
| PulseMCP | No verified current entry | Correct downstream entry | Wait for Official Registry ingestion, then inspect; do not duplicate early | pending-index |
| Homebrew tap | [`Luckycat133/tap/traecnclaw`](https://github.com/Luckycat133/homebrew-tap) is 0.6.0 at `c168cbc`; formula uses the verified public tarball digest | Preserve the public archive pin and exact stdio test | Ruby syntax, `brew style`, strict online audit, real 0.5.9-to-0.6.0 upgrade, CLI help, four console assets, and exact 20-tool `brew test` passed | verified |
| ClawHub | `traecnclaw-mcp` latest and all six tags are 0.6.0; installed core files match public mirror commit `2d7fc66` | Preserve public provenance and CLEAN scanner results | Scan `w17ccxfxapp2vncexav4qpr84h8d22qf` reports static analysis clean, VirusTotal 0 malicious/0 suspicious, ClawScan benign, and Skillspector SAFE/LOW with zero issues | verified |
| Skills CLI | A clean temporary project installed public repository Skill metadata version 0.6.0 for Codex | Preserve the public GitHub install path and launcher contract | `npx skills add ... --skill traecnclaw-mcp --agent codex --copy --yes` succeeded and installed the expected Skill files | verified |
| skills.sh | [Detail page](https://www.skills.sh/luckycat133/traecnclaw-mcp-skill/traecnclaw-mcp) shows the correct repository, Skill content, and install command; audits are Trust Hub Warn, Socket Pass, Snyk Pass; install count is still unavailable | Keep source/install current and do not invent counts | Site-generated JSON-LD incorrectly says `Cross-platform`; retain the repository's explicit macOS limitation and request correction if the site exposes a channel | verified |

On 2026-11-06, the [public Homebrew formula](https://github.com/Luckycat133/homebrew-tap/blob/19b53bd417163d4eb34a4e4200e872ee33f41760/Formula/traecnclaw.rb)
switched the 0.6.0 archive URL to the scoped npm registry. The npm archive
byte-matched the GitHub Release asset and retained its SHA-256. A fresh
isolated Homebrew install used an empty cache and a local Node.js 22.14.0
dependency, then passed `brew test` and exact 20-tool discovery.

## Directory and catalog channels

| Channel | Current public state | Next exact step | Status |
| --- | --- | --- | --- |
| Glama | [Existing listing](https://glama.ai/mcp/servers/Luckycat133/traecnclaw-mcp-skill) has verified maintainers and is synced to public mirror commit `2d7fc66`; the public Schema lists the exact ordered 20-tool contract | Keep the directory and schema-inspection copy local-first and current | Manual `Sync Server` completed against the 0.6.0 public mirror | listed |
| Glama Docker preflight | Private Build test `01a03357-3631-780a-96c7-f5bf7523886a` succeeded from pinned commit `2d7fc66dfc86cf6a0967b87d0e28f5be087ae308` with Node.js 22 and the public 0.6.0 archive; initialization reported server version 0.6.0 | Preserve the private test and exact build spec; do not promote it as a working cloud-to-Mac runtime | Public Schema independently exposes exactly 20 tools, from `traecn_send_message` through `traecn_decide_approval` | verified |
| MCP.Directory Skill | Submission was already sent. A full 2026-08-24 pass over the public Skills API (9,291 rows at inspection time) found no `traecn` match | Wait and inspect; reconcile if rejected, never duplicate | pending-review |
| MCP.Directory Server | Submission was already sent. A full 2026-08-24 pass over the public Servers API (2,303 rows at inspection time) found no `traecn` match | Wait and inspect the generated install path; reconcile if rejected | pending-review |
| AwesomeSkills.dev | No exact entry exists. The confirmed deep Skill URL was submitted twice, but the site returned `Network error. Please try again.` and created no listing | Retry the same deep URL only after the submission service recovers, then inspect parsed name/platform/source/install fields | preflight-failed |
| MCP Server Hub (`mcpserver.dev`) | [`TRAECNclaw MCP`](https://mcpserver.dev/s/traecnclaw-mcp_dflmqfc) is publicly listed as a Developer Tools MCP server and appears in Recently added. Inspection confirmed the canonical public repository, generated 0.6.0 scoped npm and Homebrew commands, Skill install command, local stdio/macOS boundary, exact 20-tool description, and explicit rejection of historical npm 0.3.1 | Preserve the public mirror identity and current generated copy | verified |
| mcp.so | Public issue [chatmcp/mcpso#3717](https://github.com/chatmcp/mcpso/issues/3717) requests the current local stdio/macOS listing and explicitly rejects the historical unscoped package | Wait for directory maintainers, then inspect and correct the generated listing rather than opening a duplicate | pending-review |
| mcpservers.org | [Existing page](https://mcpservers.org/servers/luckycat133/traecnclaw-mcp-skill) now renders generated 0.5.9 provenance, including canonical commit `a579d771`, npm/Homebrew 0.5.9, and release `v0.5.9`; it remains stale relative to 0.6.0. Its one-click refresh action was re-sent on 2026-08-24 and the page still shows `Requested`; the control exposed no preview or custom-message step | Wait for the crawler, then verify 0.6.0 version/install/platform copy; reconcile rather than submit a duplicate | pending-review |
| Smithery legacy Skill page | The existing identity now resolves to the current Local/MCPB server listing | Keep the published Local listing distinct from URL/cloud execution claims | listed |
| `punkpeye/awesome-mcp-servers` | Existing PR [#10724](https://github.com/punkpeye/awesome-mcp-servers/pull/10724) is open and mergeable. Commit `c3bcdd2` removed the incorrect Windows marker and replaced stale profile claims; both submission checks pass | Maintainer review currently asks for a Glama quality score. The PR now records the successful private build and asks for a local-only exception because Glama exposes that score only after a misleading hosted release | pending-review |
| GitHub MCP Registry | Not selected as an independent runtime | Use public mirror and Official MCP Registry metadata only | not-selected |
| Smithery URL mode | No public Streamable HTTP product exists | Keep excluded; use Smithery Local/MCPB | not-selected |
| Glama hosted runtime | A public Glama `0.6.0` hosted Release unexpectedly exists, but its linked test `01a03353-5d23-7072-aec6-8338dd8b80db` is pinned to commit `5ad3a3e` and installs the 0.5.9 archive; it is not the verified 0.6.0 build | Glama exposes no owner delete control. A removal request naming the listing, image, stale test, and correct private Build was sent to `support@glama.ai` on 2026-08-24; wait for support and verify public removal | pending-review |

## Promotion and product work

| Deliverable | Current state | Next exact step | Status |
| --- | --- | --- | --- |
| Canonical listing copy | Checked in at `distribution/listing-copy.md` | Reuse verbatim, changing only site-specific length/fields | ready |
| Architecture, use cases, limitations, post drafts | Checked in at `docs/LAUNCH-KIT.md` | Render/capture against the final public URLs | ready |
| 60–90 second demo | Shot list updated for 0.6.0; no new verified recording | Record a real local TraeCN task and Web Control Console flow after final 0.6.0 install, redact and review | blocked-external |
| Five-minute tutorial | Script prepared; no new verified recording | Record clean installation, MCP host connection, task, result, and recovery | blocked-external |
| Chinese/global launch posts | Drafts prepared; not posted | Insert verified links/media, review exact payload, obtain confirmation, post | blocked-external |
| Live TraeCN compatibility | From exact tag `v0.6.0`, DOM inspection and strict non-delegating UAT passed against the open `empty-project` workspace in TraeCN 1.107.1 with verified adapter `traecn-1.107`; readiness, two logical sessions, settings reads, SOLO chat reads, and cleanup dry-run all passed | Repeat for future TraeCN/release compatibility claims; this run did not send a model task or spend quota | verified |
| Web Control Console v1 | Direction B, specification, implementation plan, fixed assets, authenticated APIs/WebSockets, exact task interactions, package coverage, mock browser acceptance, and clean release artifact tests are shipped in `v0.6.0` | Repeat the browser check after installation from the final public artifact | verified |

## Resume checklist

1. Deprecate the historical unscoped npm package after satisfying npm's
   2FA-or-bypass-token policy; do not recreate a broad token merely for status cleanup.
2. Wait for PulseMCP to ingest the verified Official Registry 0.6.0 entry, then
   inspect its package, transport, platform, and install metadata.
3. Re-run Smithery's generated Quick Start after its `keytar` integration is
   repaired, list the runtime tools, and verify the downloaded compatibility
   bundle digest. Claude Desktop remains a separate optional host acceptance check.
4. Wait for Glama support to remove the unintended hosted `0.6.0` Release that
   is backed by the stale 0.5.9 build, then inspect the public page; preserve the
   correct private 0.6.0 Build test.
5. Retry AwesomeSkills.dev after its submission API recovers. Monitor mcp.so
   issue #3717, awesome PR #10724, MCP.Directory, and mcpservers.org without
   duplicates. Keep Glama hosted Release deliberately absent.
6. Re-run strict non-delegating live UAT against the installed 0.6.0 release;
   record/review real launch media and exact post payloads before public posting.
