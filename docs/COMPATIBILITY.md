# TraeCN Compatibility

This matrix separates observed compatibility from assumptions. Update it only
after the stated test level has been rerun.

| TraeCN version | Platform | Adapter | Repeatable evidence | Live evidence | Status |
| --- | --- | --- | --- | --- | --- |
| 3.4.15 (engine 1.107.1) | macOS | `traecn-3.4.15` | Agent sidebar, native draft and result capture, workspace picker, model picker, settings, deletion and check-in tests | Signed-in stdio used disposable conversations to test task execution, cancellation, stop, mode and model switching, workspace selection, settings, questions, command denial and native conversation deletion. See [current DOM evidence](REAL-DOM-FINDINGS.md). | Tested for these workflows. Reward claims were not exercised. |
| 3.4.11 (engine 1.107.1) | macOS | `traecn-3.4.11` | Native Agent/IDE target selection and check-in protocol tests | CDP targets and controls inspected in an isolated profile. See [current DOM evidence](REAL-DOM-FINDINGS.md). | Partial. Signed-in task execution and reward claims require live verification. |
| 1.107.x | macOS | `traecn-1.107` | Sanitized list/select/submit/queue/approval/response/review fixture replay | 1.107.1 DOM capture and 24/25 v0.4.0 UAT; strict readiness, direct delegation, and Codex-hosted MCP task `task_1_mskicgl7_1dr1vgws79` returned `TRAECNCLAW_MCP_HOST_OK` on 2026-08-08 | Verified adapter and current source-checkout MCP host path |
| Any other version/platform | Any | `traecn-unknown` | Generic mock/system coverage only | None | Degraded; no version-specific capabilities are claimed |

The gateway reads the desktop product version and engine version separately
through CDP, then returns the selected adapter handshake in
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
