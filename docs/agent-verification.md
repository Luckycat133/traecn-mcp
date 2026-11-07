# TRAECNclaw verification reference

Read for runtime, protocol, package or release work. Select evidence for the changed surface; metadata and mock results do not prove live desktop compatibility. Documentation-only edits do not require a live task.

## Build, Test, and Experience Commands

- `npm ci`: install the exact lockfile graph.
- `npm run verify:static`: check versions, generated configuration, Skill contracts, and release scanning.
- `node scripts/public-mirror.test.js`: verify generated public distribution files.
- `npm run test:mcp-conformance`: test supported protocol eras with independent clients.
- `npm run test:trae-adapters`: replay sanitized TraeCN fixtures.
- `npm run test:system`: run the real gateway against the mock bridge.
- `npm run test:mcp-stdio-smoke`: spawn stdio MCP and verify discovery.
- `npm run verify`: repository-wide non-live gate.
- `npm run test:release`: verified artifacts and clean-room mock task.
- `npm run doctor`: diagnose local setup.
- `npm run inspect:verify`: inspect real TraeCN DOM/adapter state.
- `node scripts/live-uat.js --strict --require-ready --require-verified-adapter`: live readiness without delegation.
- `TRAECN_ENABLE_MOCK_BRIDGE=1 npm run start:gateway`: mock experience.
- `npm run start:gateway`: real gateway once TraeCN CDP is ready.

Run the nearest focused test first. Static audits prove declarations, mock tests prove process integration, clean-room tests prove built artifacts, only live UAT proves current TraeCN compatibility, and marketplace scores prove only their scan.

For MCP metadata work, add focused tests that validate titles, property descriptions, reusable output schemas against real results, annotations, `execution.taskSupport`, exact tool order, and text/structured equivalence.

For package/channel work, test the actual published MCPB/npm/Homebrew/directory install rather than only local files.
