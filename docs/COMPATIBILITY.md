# TraeCN Compatibility

This matrix separates observed compatibility from assumptions. Update it only
after the stated test level has been rerun.

| TraeCN version | Platform | Adapter | Repeatable evidence | Live evidence | Status |
| --- | --- | --- | --- | --- | --- |
| 1.107.x | macOS | `traecn-1.107` | Sanitized list/select/submit/queue/approval/response/review fixture replay | 1.107.1 DOM capture and 24/25 v0.4.0 UAT; strict readiness, direct delegation, and Codex-hosted MCP task `task_1_mskicgl7_1dr1vgws79` returned `TRAECNCLAW_MCP_HOST_OK` on 2026-08-08 | Verified adapter and current source-checkout MCP host path |
| Any other version/platform | Any | `traecn-unknown` | Generic mock/system coverage only | None | Degraded; no version-specific capabilities are claimed |

The gateway detects the product version and structural mode through a read-only
CDP probe, then returns the selected adapter handshake in
`GET /api/status.traeAdapter`. Only an exact registry match can report
`verified: true`. An unknown version deliberately keeps all version-specific
capability flags false while generic DOM fallbacks remain available on a
best-effort basis.

## Validation levels

- **Mock tests:** no TraeCN instance and no account quota.
- **System tests:** local gateway in mock bridge mode.
- **Live tests:** connect to an already-running TraeCN CDP endpoint; no delegation
  unless explicitly requested.
- **Quota-consuming acceptance:** requires the explicit
  `--allow-quota-spend` gate and must never run in default CI.

When TraeCN changes, capture selector findings with `npm run inspect:traecn`,
add a sanitized fixture under `src/trae-adapters/<adapter>/fixtures`, run
`npm run test:trae-adapters` and `npm run inspect:verify`, update this matrix,
and record the affected version in the changelog. Historical live evidence
must not be relabelled as a current live run.
