# TRAECNclaw Channel Ledger

Last checked: 2026-08-23 (Asia/Shanghai). Target release: 0.5.9.

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
| Canonical source | Private `Luckycat133/TRAECNclaw`; tag `v0.5.8` exists; 0.5.9 is on a release branch | Clean merged 0.5.9 commit and immutable tag | Run Node 22 gates, merge, tag, inspect tag commit | ready |
| Canonical GitHub Release | No verified canonical `v0.5.8` Release was found | Private 0.5.9 provenance Release with all manifest assets | Create after clean manifest; download and hash assets | ready |
| Public mirror | [`v0.5.8`](https://github.com/Luckycat133/traecnclaw-mcp-skill/releases/tag/v0.5.8) is live | Generated 0.5.9 mirror, tag, Release, and asset verification | Regenerate from exact canonical commit, scan, push, release | ready |
| Scoped npm | `@luckycat133/traecnclaw` is not published | Public 0.5.9 with verified `mcpName`, macOS restriction, bins, and 20 tools | Complete npm web login, publish generated tarball, clean-prefix test | blocked-external |
| Historical npm | Unscoped `traecnclaw@0.3.1` is still `latest` | Deprecation message points to scoped package; never republish current code here | Requires npm ownership/auth after scoped package is verified | blocked-external |
| MCPB artifact | Local 0.5.9 builder now passes official schema validation and deterministic rebuild check | Public Release asset plus clean host install with 20 tools | Rebuild from tag, verify digest, install in a compatible desktop host | ready |
| Claude Desktop MCPB host | Claude Desktop is installed but was logged out during verification | Exact 0.5.9 bundle installed and 20 tools visible | User logs into Claude Desktop; install and inspect extension | blocked-external |
| Smithery Local | No current MCPB server listing; an older third-party Skill page is stale | 0.5.9 Local/MCPB listing and downloaded-bundle verification | Complete Smithery login; publish exact MCPB, download and compare digest | blocked-external |
| Official MCP Registry | Active [`io.github.Luckycat133/traecnclaw`](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.Luckycat133%2Ftraecnclaw) 0.3.1 entry uses the historical unscoped package and legacy environment names | Reconcile the existing identity with 0.5.9 backed by scoped npm; do not create a lowercase duplicate | Publish npm first, render/validate matching metadata, authenticate publisher, publish a new version, then query exact identity | blocked-external |
| PulseMCP | No verified current entry | Correct downstream entry | Wait for Official Registry ingestion, then inspect; do not duplicate early | pending-index |
| Homebrew tap | [`Luckycat133/tap/traecnclaw`](https://github.com/Luckycat133/homebrew-tap) installs 0.5.8 and its runtime smoke passed; caveats and formula test are too weak | 0.5.9 formula with truthful CLI commands and real 20-tool stdio test | Render from clean manifest, update tap, audit/style/reinstall/test public formula | ready |
| ClawHub | `traecnclaw-mcp` latest is 0.5.6 | Clean 0.5.9 Skill sourced from public mirror commit | Dry-run, publish after public mirror, inspect version/security/install | ready |
| Skills CLI | Clean install from public mirror passed | Re-test exact 0.5.9 public commit | Install into clean temporary skills root and inspect files | ready |
| skills.sh | [Detail page](https://www.skills.sh/luckycat133/traecnclaw-mcp-skill/traecnclaw-mcp) is live; first seen 2026-08-23, no install count yet | Page resolves to 0.5.9 public source and correct install | Reinspect after mirror release/indexing; verify platform copy if site exposes it | pending-index |

## Directory and catalog channels

| Channel | Current public state | Next exact step | Status |
| --- | --- | --- | --- |
| Glama | [Existing listing](https://glama.ai/mcp/servers/Luckycat133/traecnclaw-mcp-skill) is stale at 0.5.6, unclaimed, and did not expose the current 20-tool schema | With action-time confirmation, click Claim, sync the 0.5.9 public mirror, then inspect version/tools/score/install text | blocked-external |
| Glama Docker preflight | After reproducing npm `EBADPLATFORM`, the canonical inspection template now bypasses only npm's platform guard; a no-cache Linux build installed the public 0.5.9 archive, initialized MCP 2025-11-25, and returned exactly 20 tools | Keep the explicit schema-only/no-Linux-support copy; do not confuse this with listing completion | verified |
| MCP.Directory Skill | Submission was already sent; current site states review can take up to 24 hours | Wait and inspect; reconcile if rejected, never duplicate | pending-review |
| MCP.Directory Server | Submission was already sent; no exact public listing was found yet | Wait and inspect generated install path; reconcile if rejected | pending-review |
| AwesomeSkills.dev | No exact entry found; public GitHub payload is prepared | With action-time confirmation, submit the deep Skill URL and inspect the live page/install | blocked-external |
| MCP Server Hub (`mcpserver.dev`) | No exact entry found; form payload is prepared | With action-time confirmation, submit URL/title/description/category/keywords, then inspect | blocked-external |
| mcp.so | No exact entry found; current submission path is a public GitHub issue | With action-time confirmation, open the prepared issue and inspect the resulting listing | blocked-external |
| Smithery legacy Skill page | Existing third-party `xingmiao201081/traecnclaw-mcp` page contains stale profiles | Do not treat it as the MCPB server listing; request reconciliation after current Local listing exists | stale |
| `punkpeye/awesome-mcp-servers` | Previous submission state was not re-verified in this release pass | Search open/closed PRs, reconcile existing work after Glama evidence, do not open a duplicate | pending-review |
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

1. Finish and merge the 0.5.9 release commit under Node.js 22.
2. Tag and verify both GitHub Release surfaces.
3. Publish and test scoped npm; only then publish Registry metadata.
4. Update and clean-test Homebrew; publish ClawHub from the public mirror.
5. Install the exact MCPB in a logged-in desktop host and publish Smithery Local.
6. Complete the confirmed Glama claim/sync and the three prepared directory
   submissions.
7. Reinspect every public page and generated install path, then replace this
   ledger's provisional states with evidence and timestamps.
8. Record real launch media and obtain confirmation before public posts.
