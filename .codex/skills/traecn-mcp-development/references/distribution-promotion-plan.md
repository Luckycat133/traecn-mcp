# traecn-mcp distribution, naming and promotion

Current product/source identity: `traecn-mcp`, `https://github.com/Luckycat133/traecn-mcp`. Review scope: branch `docs/geo-optimization`, source baseline `676b461445be34e14748a27eabd5f5e5ca434702`, inspected 2026-11-14. This source repository is public. Retire the old blanket instruction to submit only a mirror because canonical source is private.

## Separate presentation from compatibility

| Item | Desired/current treatment |
| --- | --- |
| Product title and new prose | `traecn-mcp`; TraeCN remains the controlled app |
| Source/repository links | `Luckycat133/traecn-mcp`; update README, llms.txt, package repository/homepage and generated templates together when that surface is in scope |
| Maintainer Skill | `traecn-mcp-development`, one canonical source and IDE symlinks |
| Existing `traecn_*` tools | Preserve contract v5 and exact names/order |
| Legacy runtime Skill `traecnclaw-mcp` | Installed/package compatibility ID in the inspected tree; migrate canonical/local copies, launcher, tests and distribution as one change |
| Legacy package `traecnclaw`, scoped `@luckycat133/traecnclaw`, bins `traecnclaw` / `traecnclaw-mcp` | Inspect actual build and installed aliases; do not claim a newly named package/bin is published from a repository rename alone |
| Registry `io.github.Luckycat133/traecnclaw`, existing ClawHub/Glama/Smithery slugs | Preserve installed identities unless a deliberate channel migration is executed; update visible name/source first |
| Historical repository `Luckycat133/traecnclaw-mcp-skill` and Releases | Historical channel/provenance alias; follow redirects and inspect actual current downloads instead of inventing a replacement |
| `TRAECN_*` configuration, old service labels and state directories | API/state compatibility, not marketing copy; explicit migration or documented retention required |

Legacy spellings in this table are intentional. They are not the preferred name for new documentation. Historical signed/checksummed artifacts, task fingerprints, release tags and saved data must not be rewritten just to remove a search hit.

The source package's `private: true` controls npm publication, not GitHub repository visibility. Build-generated public package metadata is an independent surface.

## Migration acceptance, not a global search/replace

1. Pin the local tested SHA and the remote branch; reconcile unpushed changes before declaring completeness.
2. Check every documented runtime-Skill path, executable and setup command against that revision's tree, `bin` map and an installed package.
3. Change active headings/source links and maintainer routing. Keep one canonical Skill; repair symlinks rather than copying divergent versions.
4. For runtime identity changes, migrate package builder, launcher lookup, MCP configuration generation, local Skill sync, MCPB, Homebrew and tests together; retain tested aliases for installed users.
5. For state-path changes, locate existing state first, take ownership, migrate atomically and preserve tasks, events, history, terminal replay and recovery metadata. A new empty default directory is not successful migration.
6. Regenerate public copies from source and rerun `check:local-skill` plus contract/package tests only when those surfaces changed. Do not edit a mirrored Skill by hand.
7. Keep historical channel rows, adding superseded/redirect information and the replacement's verified URL. Do not create duplicate listings, move old tags or overwrite published artifact bytes.

## Branch-specific GEO correctness

README and `llms.txt` should help a reader or an AI find the actual working product, not describe an anticipated build. At the reviewed SHA the README links a new runtime-Skill directory and executable while the tree/manifest still contain legacy identities. Resolve that mismatch against the already-tested local source.

Use one concise statement of value, current source-checkout setup, actual supported operation groups, a real demonstration and the measured compatibility scope. Claims such as programmatic diff retrieval, arbitrary host support, check-in support or zero permission requirements need matching routes/tests/platform evidence; do not extrapolate them from an MCP tool count.

Distinguish Trae's application version, its editor/engine version and the adapter family. Include a last-verified source revision for compatibility claims. `llms.txt`, FAQs and structured metadata are navigation aids, not guaranteed search inclusion, ranking or download growth. No keyword duplication or fabricated benchmark/install statistics.

## Channel order

Keep the selected channel set; do not restart a directory expansion campaign during a recovery/naming task.

1. Canonical public repository and verified Release: correct name, source URLs and exact installation.
2. Current npm/Homebrew/MCPB and runtime Skill installs: version, digest, launcher and 20-tool behavior.
3. Existing ClawHub/skills.sh/Official MCP Registry: reconcile source/visible name while preserving package identity until migration is verified.
4. Existing Glama/Smithery/directories: use current account-owned listings, verify generated commands and follow pending reviews instead of duplicate submissions.
5. Promotion: publish only after the new-name install path and one real task work; prefer the TRAE community and a real demo over more low-signal listings.

Use `docs/CHANNEL-LEDGER.md` as the per-channel record. Dates in that ledger can be historical; this audit did not log into marketplaces or reverify every public version. Record name, source SHA, artifact version/digest, install result, last checked date, identity alias and remaining action separately.

## Browser-Agent handoff

Search the existing listing/account first. Verify the current repository's public visibility and existing redirect. Edit description/source links using canonical copy; do not rename immutable package identifiers in a web form without a tested install migration.

Return listing URL, observed source/version, install command, renamed display fields, retained aliases, test result and any review/blocker. Glama follows [its runbook](glama-browser-runbook.md). A successful schema inspection is not a live Mac/GLM task.

## Promotion and growth without contaminating the runtime

Demonstrate a useful task, an actual queued/recovered task when observed, and the human console. Show the same task/native-conversation identity through the workflow. Clearly distinguish real generation from mock or schema inspection.

Invite voluntary stars, compatibility reports and user examples on human-facing pages. Do not put marketing instructions in normal MCP task results or ask Agents to star repositories. Support links require a real maintainer-provided destination; do not invent accounts or promises. Preserve the user's priority of useful traffic over directory count.

## Reference guidance

- Agent Skills specification: https://agentskills.io/specification
- GitHub repository rename behavior: https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository
- MCP Registry publishing: https://modelcontextprotocol.io/registry/quickstart

Re-read channel requirements at execution time. A GitHub repository redirect is not evidence that an npm identity, service label, state directory or external listing was migrated.
