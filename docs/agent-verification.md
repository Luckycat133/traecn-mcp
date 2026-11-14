# traecn-mcp verification reference

Select evidence for the changed behavior. The maintainer reports PASS for `check:local-skill`, the runtime Skill contract test and full `npm test`, including 52 CLI tests. Preserve this supplied baseline; do not label it independently rerun or attach it to an unverified remote SHA.

## Focused checks

- Maintainer docs: frontmatter name/directory, relative references, IDE symlinks, active-name scan and changed-file scope.
- Runtime Skill changes: `npm run check:local-skill` and the contract test at the actual runtime Skill path. At the reviewed remote baseline that path is `skills/traecnclaw-mcp/scripts/skill-contract.test.js`.
- Recovery changes: `node src/http/task-restart-retry.test.js`, `node src/http/task-store.test.js`, relevant `gateway-polling.test.js` / workflow tests and `node scripts/long-queue-proof.test.js`, with new targeted failpoints.
- Context changes: project/unified-agent handler tests plus cross-entry workspace ownership tests.
- MCP/schema changes: `npm run check:skill-contracts`, `npm run test:mcp-conformance`, `npm run test:mcp-stdio-smoke`.
- Package/channel changes: generated artifact tests and an actual installed package, not just a source checkout.

Use current `package.json` to verify commands before executing. Do not invent scripts or silently skip a failure.

## Wider and live gates

`npm run verify:static` validates generated declarations. `npm test` runs the automated suites; `npm run verify` adds repository-wide gates. `npm run test:release` validates release/package behavior when that scope changes. None alone proves a real native model queue or the absence of every ambiguous-send crash window.

`npm run doctor`, `npm run inspect:verify`, and `node scripts/live-uat.js --strict --require-ready --require-verified-adapter` are the existing readiness path. Read the script's current effects and options first. Use the maintainer Skill's `references/live-proof-workspace.md` for an authorized real GLM-5.2 task, long-queue receipt and workspace protection scenario.

Report static, automated/mock, readiness, real generation, observed long queue and crash recovery separately. Docs-only edits do not require a paid prompt or a full-suite rerun. A missing local log/revision is missing attribution, not evidence that the user's tests failed.
