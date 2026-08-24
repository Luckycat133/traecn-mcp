# Web Control Console v1 Implementation Plan

**Status:** Approved for implementation on 2026-08-24

**Design:** `docs/superpowers/specs/2026-08-24-web-control-console-v1-design.md`

**Branch:** `feat/web-control-console-v1`

## Objective

Replace the legacy synchronous chat page with the approved native macOS-light
Web Control Console while preserving the gateway as the sole owner of task,
queue, review, approval, history, and reconnect state.

The implementation is build-free, keeps MCP contract v5 at exactly 20 ordered
tools, and adds only the two approved HTTP contracts plus browser-safe
WebSocket bearer authentication.

## Working rules

- Work in the isolated implementation worktree created from `origin/main` at
  design merge `a9cfe29`.
- Do not incorporate or rewrite changes from the repository owner's dirty root
  worktree.
- For every behavior change, write or extend the nearest focused test first,
  observe the intended failure, implement the smallest owner-side change, and
  rerun the focused test.
- Keep CommonJS, two-space indentation, semicolons, and build-free browser
  assets.
- Serve only an explicit allowlist of console assets. Never convert request
  paths into filesystem paths.
- Keep bearer values out of URLs, selected WebSocket protocols, rendered DOM,
  logs, and durable storage.
- Do not execute a real TraeCN task or spend model quota without a separate
  authorization. Strict readiness checks may run without delegation.
- Commit each completed task independently after its focused tests pass.

## Task 1: Characterize the legacy console boundary

**Files**

- Modify: `src/http/gateway.test.js`
- Modify: `src/http/request-gate.test.js` if the response helpers already have a
  focused test owner; otherwise keep the assertions in `gateway.test.js`.

**Steps**

1. Add a test that requests `/` and records the existing HTML response owner,
   authentication behavior, security headers, and cache behavior.
2. Add failing expectations for the approved semantic landmarks and fixed
   same-origin asset URLs.
3. Add failing expectations that arbitrary asset-like paths return 404 and
   cannot traverse outside the console asset allowlist.
4. Run:

   ```sh
   node src/http/gateway.test.js
   ```

5. Commit only the characterization tests with message:
   `test: characterize web console boundary`.

## Task 2: Extract fixed console assets and harden responses

**Files**

- Add: `src/http/web-console/index.html`
- Add: `src/http/web-console/styles.css`
- Add: `src/http/web-console/app.js`
- Add: `src/http/web-console/state.js`
- Modify: `src/http/chat-ui.js`
- Modify: `src/http/request-gate.js`
- Modify: `src/http/gateway.js`
- Modify: `src/http/gateway.test.js`
- Modify: `package.json`

**Steps**

1. Replace the monolithic HTML string with a loader for the fixed semantic
   shell.
2. Add an explicit map for `/assets/web-console/styles.css`,
   `/assets/web-console/state.js`, and `/assets/web-console/app.js`.
3. Return exact content types, `Cache-Control`, `nosniff`, referrer policy, and
   a nonce-free CSP that permits only same-origin scripts, styles, fetches, and
   WebSockets.
4. Remove `unsafe-inline` from the console CSP. Keep any compatibility helper
   scoped so JSON and other HTML responses do not regress.
5. Keep the initial JS files minimal but syntactically valid so asset-serving
   tests can pass before UI behavior is implemented.
6. Confirm traversal, unknown assets, and query variants cannot select a local
   file.
7. Run:

   ```sh
   node src/http/gateway.test.js
   npm run lint
   ```

8. Commit with message: `feat: serve fixed web console assets`.

## Task 3: Implement pure console state

**Files**

- Modify: `src/http/web-console/state.js`
- Add: `src/http/web-console/state.test.js`
- Modify: `package.json`

**Steps**

1. Export a browser global and CommonJS interface from the same file.
2. Define normalized state for runtime, selected context, active tasks,
   terminal tasks, recent history, connection state, token state, notices, and
   inspector state.
3. Add pure normalization for queued, executing, approval-required,
   awaiting-review, done, error, cancelled, queue-timeout, and review-rejected
   task payloads.
4. Add reducers for initial hydration, WebSocket snapshots, task events,
   reconnect, stale payload suppression, terminal replacement, unknown events,
   and multiple simultaneous tasks.
5. Ensure ordering is deterministic: exceptional interactions, executing,
   queued, then terminal/recent items.
6. Run:

   ```sh
   node src/http/web-console/state.test.js
   ```

7. Commit with message: `feat: add deterministic console state`.

## Task 4: Add the authenticated workspace read contract

**Files**

- Modify: `src/http/handlers/project.js`
- Add or modify: `src/http/handlers/project.test.js`
- Modify: `src/http/route-table.test.js`
- Modify: `src/http/openapi.js`
- Modify: `src/http/gateway.js` only for the existing handler shim/wiring if
  required by the route architecture.

**Steps**

1. Add authenticated `GET /api/workspace` to the project handler owner.
2. Read context through the existing driver workspace-context capability.
3. Return only `folderName`, `rootPath`, `selectedPath`, and `verified`.
4. Set `verified` only when the selected workspace guard and detected root path
   match using the existing canonical workspace comparison.
5. Return deterministic mock context and sanitize all error responses; do not
   expose selectors, profile paths, CDP targets, or driver internals.
6. Document success, authentication, unavailable-context, and failure responses
   in OpenAPI.
7. Run:

   ```sh
   node src/http/handlers/project.test.js
   node src/http/route-table.test.js
   node src/http/gateway.test.js
   ```

8. Commit with message: `feat: expose authenticated workspace context`.

## Task 5: Add task-bound exceptional interaction resolution

**Files**

- Modify: `src/http/handlers/task-actions.js`
- Add or modify: `src/http/handlers/task-actions.test.js`
- Modify: `src/http/route-table.test.js`
- Modify: `src/http/openapi.js`
- Modify: `src/http/gateway.js` only for existing owner wiring when needed.

**Steps**

1. Add authenticated `POST /api/task/:taskId/interaction`.
2. Require `interactionRequestId`, a supported action, and action-specific
   fields before any driver call.
3. Re-read the task from the gateway queue and require an exact task/status/
   interaction identity match.
4. Re-check the visible dialog belongs to that interaction before applying an
   answer or command decision.
5. For command approval, require exact command text, explicit acknowledgement,
   and a non-empty audit reason.
6. Delegate successful resolution to the existing interaction resolver and
   task-resume owner. Do not add a second lifecycle or new durable state.
7. Return 404 for a missing task, 409 for stale identity/dialog context, and
   deterministic 400 errors for malformed actions. Prove driver methods are not
   called on every rejected path.
8. Keep `/api/interactions/resolve` behavior unchanged for existing clients.
9. Run:

   ```sh
   node src/http/handlers/task-actions.test.js
   node src/http/handlers/unified-agent.test.js
   node src/http/route-table.test.js
   node src/http/gateway.test.js
   ```

10. Commit with message: `feat: bind interactions to task identity`.

## Task 6: Add browser-safe WebSocket authentication

**Files**

- Modify: `src/http/websocket-handler.js`
- Modify: `src/http/websocket-handler.test.js`

**Steps**

1. Accept browser bearer credentials only from the offered subprotocol prefix
   `traecnclaw.bearer.<base64url-token>`.
2. Decode and securely compare the bearer value without logging or reflecting
   it.
3. Select only the public protocol `traecnclaw.v1`; never select the credential
   subprotocol.
4. Preserve Authorization and `X-TraeCN-Token` header authentication for
   non-browser clients.
5. Reject query-string credentials, invalid base64url data, duplicate/conflicting
   credentials, invalid origins, and unauthenticated upgrades.
6. Cover direct `/ws/tasks/:taskId` and events-subscription paths.
7. Run:

   ```sh
   node src/http/websocket-handler.test.js
   node src/http/gateway.test.js
   ```

8. Commit with message: `feat: authenticate browser websocket sessions`.

## Task 7: Build the native-light semantic shell

**Files**

- Modify: `src/http/web-console/index.html`
- Modify: `src/http/web-console/styles.css`
- Modify: `src/http/gateway.test.js`

**Steps**

1. Implement the approved header, connection banner, context bar, composer,
   active-work area, history rail/drawer, exceptional interaction region,
   notice/live region, and Advanced inspector shell.
2. Use native system fonts, cool gray surfaces, one blue accent, semantic
   status colors, 1 px separators, and restrained shadows.
3. Keep task identity, cancel controls, and exceptional actions visible at
   1440x900, 1024x768, and 390x844.
4. Add keyboard-visible focus, 40 px narrow-screen targets, 200 percent zoom
   resilience, non-color status labels, and reduced-motion rules.
5. Avoid external fonts, images, analytics, and third-party network requests.
6. Run the semantic/asset gateway tests and a static HTML accessibility scan if
   available.
7. Commit with message: `feat: build web control console shell`.

## Task 8: Implement API client, token lifecycle, and hydration

**Files**

- Modify: `src/http/web-console/app.js`
- Add: `src/http/web-console/app.test.js`
- Modify: `package.json`

**Steps**

1. Add a small same-origin fetch client with bearer headers, typed error
   normalization, idempotency keys for submissions, and no token reflection.
2. Store a successful token only in memory and `sessionStorage`.
3. Remove and ignore legacy `localStorage.traecn_bridge_token` during startup.
4. Hydrate health/readiness, workspace, models, modes, conversations, active
   task identities, and recent history from existing gateway APIs.
5. Make authentication failure explicit and clear token state without erasing
   visible non-sensitive task information.
6. Apply the approved 401, 403, 404, 409, 429, and 503 user-visible behavior.
7. Use injectable fetch, storage, clock, and ID providers in CommonJS tests.
8. Run:

   ```sh
   node src/http/web-console/app.test.js
   node src/http/web-console/state.test.js
   ```

9. Commit with message: `feat: hydrate authenticated console context`.

## Task 9: Implement event-first task synchronization

**Files**

- Modify: `src/http/web-console/app.js`
- Modify: `src/http/web-console/app.test.js`
- Modify: `src/http/web-console/state.js`
- Modify: `src/http/web-console/state.test.js`

**Steps**

1. Connect with protocols `traecnclaw.v1` and the encoded bearer credential.
2. Subscribe to active task identities and feed normalized events into the pure
   reducer.
3. On disconnect, mark data stale, reconnect with bounded backoff, then
   rehydrate authoritative task/history snapshots.
4. Use bounded HTTP refresh only when events cannot establish current state;
   never recreate the old fixed 1-second loop.
5. Preserve terminal state and exact task identity across reload/reconnect.
6. Announce meaningful state transitions once through the live region.
7. Run the app/state and WebSocket focused tests.
8. Commit with message: `feat: synchronize console tasks by events`.

## Task 10: Implement context, tasks, reviews, and Advanced behavior

**Files**

- Modify: `src/http/web-console/app.js`
- Modify: `src/http/web-console/app.test.js`
- Modify: `src/http/web-console/styles.css`

**Steps**

1. Wire workspace opening, model/mode/conversation selection, submit, exact
   cancel, result review, history detail/replay, and context refresh to their
   canonical gateway APIs.
2. Render concurrent task cards and explicit submitted context from captured
   task data, not mutable current controls.
3. Render question and command-approval cards above normal tasks; submit exact
   `taskId` plus `interactionRequestId`.
4. Require the approved command acknowledgement and audit-reason UI before
   enabling approval.
5. On 409, keep the action unapplied, refresh the task/dialog, and explain that
   the visible interaction changed.
6. Populate Advanced with adapter, persistence, metrics, configuration audit,
   log guidance, and OpenAPI links only; do not expose generic/raw driver
   controls.
7. Implement focus return for drawers/dialogs and stable keyboard navigation.
8. Run app/state/gateway focused tests.
9. Commit with message: `feat: complete web control console workflows`.

## Task 11: Prove distribution includes the console

**Files**

- Modify: `scripts/build-npm-package.test.js`
- Modify: `scripts/build-mcpb.test.js`
- Modify: `scripts/homebrew-formula.test.js`
- Modify: `scripts/release-scan.js` and its test only if the scanner needs a
  canonical asset rule.
- Modify: package manifests or builders only where a focused test proves an
  installed artifact omitted an asset.

**Steps**

1. Add assertions that HTML, CSS, app JS, and state JS are present in npm and
   MCPB artifacts and in the Homebrew-installed source layout.
2. Build each artifact and request the console from the installed/built copy,
   rather than checking the source tree alone.
3. Prove no `.env`, token, profile data, audit logs, or arbitrary local paths
   enter the artifacts.
4. Run:

   ```sh
   node scripts/build-npm-package.test.js
   node scripts/build-mcpb.test.js
   node scripts/homebrew-formula.test.js
   node scripts/release-scan.test.js
   ```

5. Commit with message: `test: verify console distribution assets`.

## Task 12: Update product contracts and completion evidence

**Files**

- Modify: `README.md`
- Modify: `docs/CHANNEL-LEDGER.md`
- Modify: `.codex/skills/traecnclaw-development/references/project-audit.md`
- Modify: `CHANGELOG.md` if the implemented behavior is release-facing under
  the repository's changelog policy.

**Steps**

1. Describe the Web Control Console as the single human product and the CLI as
   setup/service/recovery tooling.
2. Document local token connection, private authenticated access, explicit
   context, concurrent task cards, exceptional interactions, exact cancel, and
   Advanced diagnostics.
3. Document current macOS/TraeCN limits without implying cloud execution or an
   untested remote host.
4. Record focused/mock/live evidence separately and leave real send/result
   evidence pending unless separately authorized and executed.
5. Run formatting and static verification.
6. Commit with message: `docs: document web control console v1`.

## Task 13: Mock browser acceptance

**Runtime**

- Node.js 22
- `TRAECN_ENABLE_MOCK_BRIDGE=1 npm run start:gateway`
- Browser automation against the real local gateway

**Acceptance matrix**

1. Load unauthenticated, authenticate with the configured test token, and prove
   the token never appears in URL, DOM text, console logs, or selected protocol.
2. Hydrate workspace/model/mode/conversation and prove submission is disabled
   when required context is unavailable or stale.
3. Exercise queued, running, question, command approval, awaiting review,
   completed, failed, cancelled, reload, and reconnect fixtures without a fixed
   polling loop.
4. Exercise recent history detail/replay and the Advanced inspector.
5. Inspect 1440x900, 1024x768, and 390x844; check horizontal overflow, 200
   percent zoom, reduced motion, and 40 px touch targets.
6. Complete a keyboard-only pass, including focus return and live-region
   announcements.
7. Assert zero uncaught console errors and zero external network requests.
8. Save screenshots and a compact acceptance log under a temporary directory,
   not in the repository.
9. Fix every failed item with a focused regression test before repeating the
   browser path.

Commit any acceptance fixes separately with a behavior-specific message.

## Task 14: Repository, release, and live readiness gates

**Steps**

1. Ensure a clean implementation worktree and run under Node.js 22:

   ```sh
   npm run verify:static
   npm run test:system
   npm run verify
   npm run test:release
   npm run doctor
   npm run inspect:verify
   node scripts/live-uat.js --strict --require-ready --require-verified-adapter
   ```

2. Confirm MCP discovery still returns exactly the 20 ordered contract-v5
   tools and text/structured parity tests remain green.
3. Confirm strict live UAT performed no delegation and therefore spent no model
   quota.
4. Push `feat/web-control-console-v1`, open a PR with the exact focused, mock,
   repository, package, and live evidence, inspect CI, and merge only when all
   required checks pass.
5. After merge, verify the public `main` files and release-facing install path.
   Do not claim npm publication, Claude Desktop verification, or a real task
   result unless each independent channel is actually completed and inspected.

## Completion record — 2026-08-24

Tasks 1–13 are implemented on `feat/web-control-console-v1` through commits
`0ff86d0`, `4a617f6`, `93bb048`, `efa6cc2`, `3a08e8a`, `ff12940`, and
`4513437`, with lint/package corrections in `0e92bfc` and `1728c86`.

- The focused console, workspace, task-action, WebSocket, gateway, and package
  tests pass under Node.js 22.
- The complete `npm run verify` gate passes with 85.92% line, 77.01% branch,
  and 75.56% function coverage.
- Mock browser acceptance passes at desktop, tablet, mobile, 200% page scale,
  and reduced motion, including keyboard focus return and a synthetic-token
  authentication/reload flow.
- Fixed console assets are present in npm and MCPB release packaging while the
  MCP contract remains v5 with exactly 20 ordered tools.
- External publication, live installed-release UAT, and independent desktop
  host/directory authentication remain channel-ledger work, not implementation
  evidence.

## Stop conditions

Stop implementation and report the exact blocker if any of these occur:

- the implementation would require changing MCP tool names, order, count, or
  behavior;
- the only path forward would duplicate task lifecycle outside the gateway;
- an existing public endpoint would need an incompatible change;
- a real task send, credential entry, OAuth grant, package publication, or
  public listing submission becomes necessary without explicit authority;
- a failing live adapter check cannot be reproduced without altering the
  user's active TraeCN workspace.

Otherwise continue through the next safe task until the completion criteria in
the approved design are met.
