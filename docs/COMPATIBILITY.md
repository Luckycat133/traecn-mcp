# TraeCN Compatibility

This matrix separates observed compatibility from assumptions. Update it only
after the stated test level has been rerun.

| TraeCN version | Platform | Selector evidence | Mock/system tests | Live test | Status |
| --- | --- | --- | --- | --- | --- |
| 1.107.1 | macOS | `docs/REAL-DOM-FINDINGS.md` | Supported | 24/25 in v0.4.0 notes; palette retry added | Verified with documented limitation |
| Other versions | macOS/Windows | Not captured | Expected to run | Not verified | Experimental |

## Validation levels

- **Mock tests:** no TraeCN instance and no account quota.
- **System tests:** local gateway in mock bridge mode.
- **Live tests:** connect to an already-running TraeCN CDP endpoint; no delegation
  unless explicitly requested.
- **Quota-consuming acceptance:** requires the explicit
  `--allow-quota-spend` gate and must never run in default CI.

When TraeCN changes, capture selector findings with `npm run inspect:traecn`,
run `npm run inspect:verify`, update this matrix, and record the affected
version in the changelog.
