# TraeCN MCP 0.x release milestones

A commit containing a version is evidence of a source snapshot, not evidence
that a tag, GitHub Release, npm version, or Homebrew formula was published.
Keep existing public refs and assets immutable. Do not renumber or backfill
historical releases merely to make the sequence contiguous. New release tags
use `v0.MINOR.PATCH`; this release plan stays below 1.0.0.

| Version | Verified repository evidence | Disposition |
| --- | --- | --- |
| 0.1.0 | `3561183238abafd49f0916ece7c17124363166d3`, first source snapshot | Source-only archive label: `archive/source-0.1.0` (documentation only, no Git ref created). Historical source on the legacy `docs/geo-optimization` branch; not a release or on current main ancestry |
| 0.2.0 | `776aa114eaa75c3b209422b418912c99ea78f275`, 0.2 package metadata | Historical source only |
| 0.3.0 | `5d4c7363bf68d6019bdb84ec71ff133d398ccc67` source; public `v0.3.0-mcp-skill.1` at `64df81532cba7479ce5a30e9e5249a365df2e2cc` | Retain existing public tag spelling and six assets; do not retag it as `v0.3.0` |
| 0.4.0–0.4.7 | `4b3d0a68024588f822fec39812a27e814af6e008` through 0.4.7 snapshot `85a8bec89900281648a70caae1194a12cfa36bcf` | Versioned historical source; no corresponding public GitHub Release tags observed |
| 0.5.0–0.5.5 | `0282c125790f4db0c8249a58cbf2538b0b10539a` through 0.5.5 snapshot `4c01911d6967a479a1d5bdd72df48881543c9b56` | Versioned historical source; do not infer missing public GitHub Releases from mirror commits |
| 0.5.6–0.6.0 | `v0.5.6` → `d81c119`, `v0.5.7` → `2214f7a`, `v0.5.8` → `8a26b62`, `v0.5.9` → `753e468`, `v0.6.0` → `2d7fc66` | Existing GitHub Releases; these targets are the public mirror commits, not presumed identical source snapshots |
| 0.7.0 | `v0.7.0` points to `5e3bdc69fc3cee30332add2d6a045b1cbf14d58f` (annotated tag object `8b82efb746e6caf05fdfe84ebc2d821decaa9cb7`) | Existing public GitHub Release with six assets and the current canonical Homebrew pin |
| 0.7.1 | [Public GitHub Release](https://github.com/Luckycat133/traecn-mcp/releases/tag/v0.7.1), 2026-11-22, exact source `42aa3c53daa9d4d4756e7ab4d5c3229d669c8067` | Six public assets verified; the canonical formula pins this Release tarball. npm, Registry, and legacy-tap migration are separate and not implied. |

## v0.7.1 release handoff

Steps 1–3 completed in [release run 44979815913](https://github.com/Luckycat133/traecn-mcp/actions/runs/44979815913). Do not recreate the one-time approval marker.

1. Review and merge the candidate only after exact-commit Linux verification and
   native macOS no-publish checks pass. The macOS PR gate exercises the Homebrew
   recipe against the exact staged archive; it does not contact the candidate's
   future GitHub Release URL or run a real TraeCN desktop task.
2. With formal release authorization, open and merge a separate one-file PR
   adding `.release/approve-v0.7.1` with exactly `v0.7.1` and a trailing
   newline. The main-branch event must contain only that addition. At the
   exact new main commit, the one-version workflow re-runs Linux and macOS
   gates, including a Homebrew install of that exact staged tarball. It then
   creates the new tag without overwriting any ref and publishes only after
   verifying the tag's SHA. Replays verify downloaded public bytes against both
   the public manifest and this run's independently staged bytes. If a rebuilt
   manifest timestamp or archive differs, the run fails read-only and names
   the differing asset; it never overwrites a public artifact. An exact tag with
   no Release can safely finish publishing; other conflicts stop for inspection. The ordinary tag route
   is unchanged, and its manual dispatch remains verify-only.
3. Download the public manifest and the public server tarball. Verify the
   manifest version, clean source SHA, exact artifact set, and downloaded
   SHA-256. Do not claim success just because a tag or Release page exists.
4. Render a separate canonical formula PR **from that public manifest** only
   after the download passes. Update `Formula/traecnclaw.rb` in
   `Luckycat133/traecn-mcp`. Use the explicit tap URL and verify a clean
   Homebrew install, CLI help, and `brew test` on a disposable macOS runner.
   Do not use a PR build's archive hash on the live tap: the tarball embeds
   the source revision and the final tagged main SHA may differ from the PR SHA.
5. Keep the original formula name, installed executable name, scoped npm
   artifact identity, and existing Registry identity. Do not edit the legacy
   `Luckycat133/homebrew-tap` or change marketplaces without channel-specific
   evidence and authorization. A GitHub Release does not publish npm or another
   registry package.

The checked-in [canonical Homebrew formula](../Formula/traecnclaw.rb) pins the
public v0.7.1 archive. The PR verifier installs this exact recipe in a disposable
hosted macOS tap. After the formula merges, the scoped main workflow taps the
[real public repository](https://github.com/Luckycat133/traecn-mcp), checks its
exact event SHA, and uses a fresh cache for install, `brew test`, and CLI help.
That run is the public-tap evidence; it does not verify the legacy tap or an
upgrade of an existing user installation.
