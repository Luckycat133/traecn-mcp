# Web Control Console v1 Design

- Status: design approved on 2026-08-24; written specification awaiting owner
  review
- Target: TRAECNclaw after 0.5.9
- Verified baseline: canonical `main@7c2beba`, Node.js 22, macOS, TraeCN 1.107.x

## Decision summary

TRAECNclaw will replace the current dark three-column bridge page with one
responsive, native-macOS-light Web Control Console. It is the sole human
product for observing and controlling the existing local gateway. It does not
own another task queue, recovery loop, conversation model, or cloud runtime.

The console will:

- use the gateway's unified task, context, history, approval, and WebSocket
  contracts;
- make workspace, model, mode, and conversation context explicit before work
  is submitted;
- render gateway-owned tasks as durable cards with status, timeline, result,
  exact cancellation, and exceptional-interaction controls;
- keep adapter, persistence, metrics, configuration audit, log guidance, and
  OpenAPI details in an Advanced inspector;
- work on loopback without credentials and through an authenticated private
  connection without placing tokens in URLs;
- ship as no-build, first-party HTML/CSS/JavaScript assets with no external
  fonts, analytics, CDNs, or frontend framework.

Two narrow gateway additions are part of this design:

1. an authenticated read-only workspace-context endpoint, because the current
   public status response intentionally does not expose the user's local path;
2. a task-bound interaction endpoint that validates both `taskId` and
   `interactionRequestId` before resolving an approval or question.

Browser WebSocket authentication will accept a bearer value through a
dedicated WebSocket subprotocol. Existing Authorization and
`X-TraeCN-Token` header support remains unchanged for non-browser clients. A
token must never be put in the WebSocket URL or echoed as the selected
subprotocol.

## Goals and acceptance outcome

The v1 outcome is a human control surface that answers five questions without
opening developer diagnostics:

1. Is this gateway local, live or mock, connected, and ready?
2. Which workspace, model, mode, and conversation will receive the next task?
3. What work is active, what state is each task in, and which result belongs to
   which task?
4. Does a specific task need a question answered, a command decision, a review,
   or cancellation?
5. What recently completed, and where can an operator inspect deeper runtime
   evidence?

Acceptance requires:

- one responsive console at `/` with no competing chat or diagnostics product;
- durable task identity preserved across reload and WebSocket reconnect;
- no fabricated progress, completion, recovery, or ownership state;
- safe local and authenticated-private-network operation;
- keyboard, focus, contrast, reduced-motion, and narrow-screen acceptance;
- mock browser acceptance for the complete lifecycle and strict live readiness
  acceptance against the supported TraeCN adapter;
- one real send/result path only when quota-consuming delegation is separately
  authorized.

## Non-goals

The following are deliberately outside v1:

- changing the MCP v5 contract or its exact 20-tool order;
- adding MCP wait, poll, recovery, proof, process, or generic command tools;
- implementing Streamable HTTP, hosted TraeCN, multi-user cloud accounts, or a
  marketplace-specific runtime;
- duplicating CLI setup, service lifecycle, release, recovery, or full log-tail
  workflows in the browser;
- exposing arbitrary editor, terminal, file, Git, extension, or command-driver
  endpoints through the normal console;
- designing a second persistent session/history store in the browser;
- adding rich Markdown execution, file uploads, voice, theming, plugins,
  notifications, analytics, or a dark mode;
- conversation deletion or history clearing in the normal v1 workflow;
- publishing launch posts or claiming a real-task demo before real evidence is
  recorded and reviewed.

## Current baseline and replacement boundary

The current `src/http/chat-ui.js` is a single 632-line HTML string. It:

- renders a dark left status column, synchronous chat center, and permanent
  developer console on the right;
- stores a gateway token in `localStorage` and writes it back into a password
  input;
- creates a new logical session for every submitted message;
- waits for one synchronous delegate response instead of presenting the
  gateway's durable task lifecycle;
- refreshes eight diagnostic endpoints on a timer;
- does not expose workspace, model, mode, or conversation intent;
- does not show active tasks, task-bound cancellation, approvals, review,
  timeline, durable history, or WebSocket reconnect state.

The new console replaces that presentation and client behavior. Gateway task,
history, queue, conversation, model, mode, approval, persistence, and WebSocket
owners remain authoritative.

## Experience modes

### Local live

The console is opened from the loopback gateway. The status header says
`Local · Live`; readiness and adapter state come from the gateway. If no token
is configured, the page works without a credential prompt.

### Authenticated private connection

The console is reached through a deliberately configured private network or
HTTPS tunnel. It says `Private · Live`, requires a gateway token, and shows a
short reminder that tokenless public exposure is unsupported. CORS and Origin
checks remain gateway-owned.

### Local mock

The mock bridge says `Local · Mock` in an amber, text-labelled state. Mock
results are never styled or described as live TraeCN evidence.

### Offline or not ready

The last successful snapshot stays visible with a `Stale` label and timestamp.
An offline/readiness banner explains the gateway-provided blocker and next
action. The console does not auto-restart TraeCN or manufacture recovery work.

## Visual system

The visual direction is native macOS light, not a replica of a macOS window.
There are no fake traffic-light controls.

- Canvas: warm porcelain `#F4F4F2`.
- Primary surface: `#FFFFFF`.
- Raised surface: translucent white used only in the top status rail and
  temporary sheets.
- Primary text: graphite `#1D1D1F`.
- Secondary text: `#6E6E73`.
- Hairline: `rgba(60, 60, 67, 0.18)`.
- Primary action: restrained cobalt `#0A66D8`.
- Ready/success: mint green `#2A9D55`.
- Attention: amber `#A96300`.
- Destructive/error: `#C9342F`.
- Typography: `-apple-system`, `BlinkMacSystemFont`, `SF Pro Text`, then
  platform sans-serif fallbacks.
- Corners: 8 px for controls, 12 px for task cards, 16 px for sheets.
- Shadows: one subtle elevation level for sheets and floating exceptional
  cards; normal sections use hairlines rather than shadows.
- Motion: opacity and 4-8 px transforms no longer than 180 ms. All nonessential
  motion is disabled by `prefers-reduced-motion`.

Color is never the only state indicator. Every status dot is paired with text
and, where useful, an icon. Body text and controls meet WCAG AA contrast.

## Information architecture

At widths of 1180 px and above, the console has a persistent context rail,
one operations workspace, and an on-demand inspector drawer:

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ TRAECNclaw  Local · Live  Ready  v0.5.9  TRAECNclaw     Advanced  Connect│
├────────────────┬─────────────────────────────────────────┬───────────────┤
│ Context        │ Operations                              │ Inspector     │
│ Workspace      │ [Instruction composer                 ] │ Adapter       │
│ Model          │ [Send]                                  │ Persistence   │
│ Mode           │                                         │ Metrics       │
│ Conversation   │ Needs attention                         │ Config audit  │
│                │ Active task cards and result timelines  │ Log guidance  │
│                │                                         │ OpenAPI       │
│                │ Recent history                          │               │
└────────────────┴─────────────────────────────────────────┴───────────────┘
```

The inspector is closed by default. Between 760 and 1179 px, both Context and
Advanced are independent overlay drawers. Below 760 px, the page is one column:
status, a compact context summary, composer, attention cards, active tasks,
history. Drawers occupy the viewport and return focus to their trigger when
closed.

The operations column is the visual priority. It has a maximum readable width
but task result text may expand to the available viewport. The composer remains
visible after task submission but does not cover task actions on short screens.

## Components and behavior

### 1. Readiness/status rail

The rail shows:

- `Local` or `Private` from the current origin;
- `Live` or `Mock` from `mockBridge`;
- connected/disconnected and TraeCN running/CDP state;
- ready/not-ready plus the gateway blocker;
- server version and verified/degraded adapter;
- current workspace folder when authenticated context is available;
- the last successful refresh timestamp when data is stale.

Clicking the rail opens a compact detail popover. It never exposes a full token,
authorization header, or raw local profile data.

### 2. Context rail

The context rail contains four labelled controls:

- **Workspace:** current folder and path, plus `Open workspace…`. Submission is
  disabled when the selected path is not verified against the current TraeCN
  workspace.
- **Model:** offered models and current selection. Unsupported listing shows a
  disabled field with an actionable explanation.
- **Mode:** `Solo` or `IDE`, reflecting the driver's current state.
- **Conversation:** Solo conversations with the active conversation marked.
  In IDE mode this field is disabled with `Conversation context is Solo-only`.

Workspace, model, mode, and conversation mutations are explicit user actions
through existing gateway APIs. The submit body also includes the selected
values, so the gateway can reject drift instead of silently targeting another
workspace or conversation.

Conversation creation is available next to the conversation selector. Permanent
conversation deletion is not exposed in v1.

### 3. Instruction composer

The composer accepts one plain-text instruction. `Enter` submits and
`Shift+Enter` inserts a newline. It has:

- an explicit context summary immediately above the input;
- a character count only near the server limit;
- a primary `Send task` action;
- disabled and explanatory states for missing instruction, unverified
  workspace, unavailable gateway, blocker, active interaction, or rate limit;
- a generated `Idempotency-Key` retained until the request is accepted or the
  instruction materially changes.

The normal composer does not expose follow-up chains, completion-check syntax,
auto-approval policy, fallback-model probing, or generic command execution.

### 4. Active task board

Every accepted task becomes a card keyed by the gateway `taskId`. Cards are
ordered newest first and never merged merely because their text matches.

Each card contains:

- instruction summary and immutable task ID copy control;
- submitted context: workspace, model, mode, and conversation;
- textual state chip and elapsed time;
- server-derived queue details when present;
- a status timeline;
- final result or error;
- exact actions appropriate to the current state.

The console maps server states as follows:

| Gateway state     | Human label     | Card behavior                                        |
| ----------------- | --------------- | ---------------------------------------------------- |
| accepted/queued   | Queued          | Show queue facts; allow exact cancellation           |
| executing         | Running         | Show submitted state; allow confirmed cancellation   |
| approval_required | Needs attention | Render task-bound question or command card           |
| awaiting_review   | Review result   | Render result plus approve/continue/reject controls  |
| done              | Completed       | Render final result and move into recent history     |
| error             | Failed          | Preserve actionable gateway error and retry guidance |
| queue_timeout     | Queue timed out | Preserve task identity; do not auto-resubmit         |
| review_rejected   | Review rejected | Show notes and terminal state                        |
| cancelled         | Cancelled       | Show whether TraeCN stop succeeded when reported     |

No percentage bar is shown because the current fixed WebSocket percentages are
state markers, not measured task progress.

The timeline is built from gateway status transitions and durable replay steps.
On reload it is rehydrated from the queue and history APIs, not from browser
storage.

### 5. Cancellation

Cancel always originates inside one task card. A confirmation popover repeats
the instruction summary and task ID. Cancelling an executing submitted task
also explains that TraeCN generation will be stopped when supported.

The console calls only `POST /api/task/:taskId/cancel`. It never uses the
untracked global stop-generation route for a gateway-owned task.

### 6. Exceptional interaction cards

Exceptional interactions sort above normal active cards and receive keyboard
focus only when they first appear.

Question cards show the exact question and server-provided options. Command
approval cards show the exact command, risk classification, and reason codes.
Approving a command requires:

- unchanged `taskId` and `interactionRequestId`;
- exact expected command text;
- an explicit risk acknowledgement;
- an audit reason between 1 and 500 characters.

Deny and dismiss remain explicit actions. If the visible interaction changes,
the server returns a conflict; the card becomes stale and refreshes instead of
acting on the replacement dialog.

Review cards call the existing task-bound review route and support approve,
continue, or reject with optional notes.

### 7. Recent history

Recent history shows the newest 20 durable records with status, instruction
summary, timestamps, and context. Selecting a row opens read-only detail and
replay steps. Pagination or `Load more` requests additional server pages.

History is not cached as authoritative browser state. Clearing history and
one-click task re-run are outside v1.

### 8. Advanced inspector

Advanced remains closed during normal work and contains:

- **Adapter:** detected product/version/platform, adapter ID, verification and
  degraded status;
- **Persistence:** active queue, event store, history health and degradation;
- **Metrics:** a compact snapshot from `/metrics.json`, not a replacement for a
  monitoring system;
- **Configuration audit:** sanitized current config, diff, and recent config
  audit records;
- **Logs:** fixed local log paths and a copyable `traecnclaw logs 100` command.
  The browser does not tail arbitrary files or duplicate CLI log lifecycle;
- **OpenAPI:** authenticated link and current API version/path count.

Raw driver endpoints and arbitrary commands are not exposed here.

### 9. Connection sheet

The sheet opens after an authenticated request returns 401/403, when a private
origin is detected, or when the user selects `Connect`.

- The password field is never populated with an existing token.
- A successful token is held in memory and `sessionStorage` only, so reloads in
  the same tab work but closing the tab clears it.
- The legacy `traecn_bridge_token` localStorage value is removed and ignored;
  the user is asked to reconnect once.
- The token is sent as an HTTP Authorization header and through the dedicated
  WebSocket bearer subprotocol.
- The token is never placed in a URL, DOM text, toast, error, telemetry, or
  selected WebSocket subprotocol.
- `Disconnect` clears in-memory/session credentials, closes sockets, and
  returns protected panels to a locked state.

The sheet explains that remote use requires a token, allowed origin, and a
private network or deliberate HTTPS tunnel. It explicitly rejects public,
tokenless gateway exposure.

## Client state and ownership

The client may keep only a disposable projection:

```text
connection  = auth state, socket state, last successful refresh
runtime     = status, readiness, workspace, adapter, durability
context     = selected workspace/model/mode/conversation
tasks       = Map keyed by gateway taskId
history     = current server page and filters
ui          = open drawer/sheet, focus return target, transient form state
```

Task status, results, history, conversations, and approvals are always
rehydrated from the gateway. Browser storage is not a recovery source and never
changes a server task from one state to another.

Pure normalization/reducer functions remain separate from DOM rendering so
state transitions can be tested under Node.js without adding a browser DOM
dependency.

## API and event mapping

### Existing contracts used directly

| Purpose              | Contract                                                                |
| -------------------- | ----------------------------------------------------------------------- |
| Basic service state  | `GET /api/status`                                                       |
| Readiness/blocker    | `GET /api/readiness` and authenticated `POST /api/preflight`            |
| Model context        | `GET /api/models`, `POST /api/switch-model`                             |
| Mode context         | `GET /api/detect-mode`, `POST /api/switch-mode`                         |
| Conversation context | `GET /api/conversations`, `POST /api/conversations/manage`              |
| Open workspace       | `POST /api/open-project`                                                |
| Submit work          | `POST /api/tasks/submit` with `Idempotency-Key`                         |
| Active task detail   | `GET /api/task/:taskId`                                                 |
| Active task summary  | `GET /api/queue/status`                                                 |
| Exact cancellation   | `POST /api/task/:taskId/cancel`                                         |
| Result review        | `POST /api/task/:taskId/review`                                         |
| Durable history      | `GET /api/tasks/history`, `GET /api/tasks/:taskId/replay`               |
| Diagnostics          | `GET /api/config`, `/api/config/diff`, `/metrics.json`, `/openapi.json` |
| Events               | `/ws/events`, then task subscriptions by `taskId`                       |

The old create-session-then-synchronous-delegate flow is not used by the new
console.

### New authenticated workspace contract

`GET /api/workspace` calls the existing driver workspace-context owner and
returns:

```json
{
  "folderName": "TRAECNclaw",
  "rootPath": "/path/to/TRAECNclaw",
  "selectedPath": "/path/to/TRAECNclaw",
  "title": "设置 — TRAECNclaw",
  "hasExplorer": true,
  "verified": true
}
```

`selectedPath` is the gateway's current selected-workspace guard. `verified` is
true only after that selected path passes the existing gateway workspace
assertion against the current TraeCN surface; a title or folder inference by
itself is not presented as an exact path match. Missing or unavailable values
are `null`; no profile path, token, or raw DOM is returned. The route is
authenticated because a local workspace path is private operator context. Mock
mode returns a deterministic fixture.

### New task-bound interaction contract

`POST /api/task/:taskId/interaction` requires:

```json
{
  "interactionRequestId": "interaction-...",
  "action": "approve | deny | answer | dismiss",
  "answer": "optional exact option label",
  "expectedCommand": "required for approve",
  "acknowledgeRisk": true,
  "reason": "required for approve, 1-500 characters"
}
```

Before touching TraeCN, the gateway verifies:

- the task exists and is `approval_required`;
- the task's current `interactionRequestId` exactly matches;
- the visible dialog still belongs to the expected interaction;
- command-approval context matches the visible command.

The handler runs the driver action under the existing UI action lock and reuses
the existing interaction resolver and task-resume owner. It does not add
another approval state machine. A mismatch returns HTTP 409 and no UI action is
performed.

### Browser WebSocket authentication

When a gateway token exists, the browser offers two subprotocol values:

```text
traecnclaw.v1
traecnclaw.bearer.<base64url-token>
```

The server authenticates the bearer value with the existing constant-time
comparison and selects only `traecnclaw.v1`. It never echoes the bearer
subprotocol. Header authentication remains supported for Node and other
non-browser clients. Query-string authentication is rejected.

Origin checks, connection caps, upgrade rate limits, payload limits, and
heartbeats remain in force.

### Event and reconnect flow

1. Hydrate status, authenticated context, active queue, and recent history.
2. Connect to `/ws/events` and subscribe to every active task ID.
3. On `taskStatusChanged`, `taskUpdate`, `approvalRequired`, or reconnect,
   fetch the exact task when fuller state is required.
4. On socket loss, retain the last projection as stale and reconnect with
   bounded backoff: 1, 2, 5, 10, then 15 seconds while the page is visible.
5. While disconnected and active tasks exist, call the single active-task
   summary endpoint every 5 seconds, then fetch only changed task IDs. After
   five minutes the fallback interval becomes 15 seconds.
6. Stop reconnect and fallback polling while the page is hidden; refresh once
   when it becomes visible.

This is event-first with bounded fallback, not a second waiting or recovery
system.

## Error handling

- **401/403:** lock protected panels and open the Connection sheet. Never place
  the rejected credential in the error.
- **409 context or interaction conflict:** keep the action unapplied, mark the
  control stale, refresh exact server state, and explain what changed.
- **429:** respect `Retry-After`, disable only the affected action, and retain
  other console state.
- **503/CDP unavailable:** show the gateway message and next action; never
  auto-restart TraeCN.
- **501 unsupported capability:** disable only that control and explain the
  active adapter limitation.
- **Network/socket loss:** keep last data with timestamp and `Stale`; do not
  reinterpret an active task as failed.
- **Task error/queue timeout/review rejection:** remain attached to the exact
  task card and durable history.
- **Malformed or unknown event:** ignore it, record a bounded client diagnostic,
  and rehydrate from the task endpoint.

Errors are shown inline near the affected control. Toasts are reserved for
short successful acknowledgements and never carry task results or secrets.

## Security and privacy

- Root and static assets contain no user data and may remain unauthenticated.
- Workspace, task, history, context, configuration, audit, and OpenAPI requests
  remain authenticated when a gateway token is configured.
- A strict console Content Security Policy allows only same-origin scripts,
  styles, fetches, and WebSockets; objects, frames, external assets, and base
  URL changes are denied.
- No inline executable script is required, enabling `script-src 'self'` without
  `unsafe-inline`.
- All user/task/result text is assigned through `textContent`; it is not
  interpolated as HTML or executed as Markdown.
- Task command approval is identity-bound and fail-closed.
- Client diagnostics are bounded and redact Authorization, token, password,
  secret, credential, and cookie values.
- The console does not read `.env`, browser cookies, TraeCN profile contents,
  or arbitrary filesystem logs.
- Private-network guidance prefers Tailscale or a deliberate HTTPS tunnel and
  never recommends a tokenless public bind.

## Accessibility and responsive behavior

- Semantic `header`, `nav`, `main`, `section`, `article`, `dialog`, and form
  landmarks are used.
- Every icon-only control has an accessible name and visible tooltip.
- All functions are keyboard reachable with a visible cobalt focus ring.
- Dialogs trap focus, close with Escape when safe, and return focus to the
  trigger. A destructive confirmation cannot be dismissed by an accidental
  background click.
- New attention cards use a polite live-region announcement; full results do
  not repeatedly announce on every refresh.
- State never relies on color alone.
- Touch targets are at least 40 by 40 px on narrow screens.
- Text zoom to 200 percent and widths down to 390 px do not hide task identity,
  cancellation, or exceptional actions.
- Reduced-motion preference removes drawer and card transitions.

## Source ownership and packaging

The implementation remains build-free and splits the current monolithic string
into explicit owners:

- `src/http/web-console/index.html`: semantic shell;
- `src/http/web-console/styles.css`: native light visual system and responsive
  layout;
- `src/http/web-console/state.js`: browser/CommonJS-compatible pure state
  normalization and reducers;
- `src/http/web-console/app.js`: API client, WebSocket connection, DOM rendering,
  and event wiring;
- `src/http/chat-ui.js`: fixed asset loading/render compatibility boundary;
- `src/http/handlers/project.js`: authenticated workspace read contract;
- `src/http/handlers/task-actions.js`: task-bound interaction contract;
- `src/http/websocket-handler.js`: browser subprotocol authentication;
- `src/http/openapi.js` and `src/http/route-table.js`: public contract and route
  registration.

Only fixed, known console asset paths are served; request paths are never mapped
to arbitrary filesystem reads. `package.json` and package tests must include the
HTML/CSS/JS assets in npm, MCPB, and Homebrew-installed copies.

The existing CLI remains the owner of service installation, lifecycle, and
full log viewing. The gateway remains the owner of all task and interaction
state.

## Test design

### Focused Node.js tests

- rendered HTML references only fixed same-origin assets and contains the
  required landmarks;
- root/static responses use correct content types, cache policy, nosniff, and
  Content Security Policy;
- console assets are included by package and release scanners;
- pure state reducers cover initial hydration, concurrent tasks, reconnect,
  stale data, every terminal state, and unknown events;
- workspace route is authenticated, sanitized, deterministic in mock mode, and
  does not leak profile data;
- task-bound interaction rejects missing/stale task or interaction identity and
  applies no driver action on mismatch;
- command approval requires exact command, acknowledgement, and audit reason;
- WebSocket subprotocol auth accepts a valid token, rejects invalid/query tokens,
  and never selects or echoes the bearer value;
- existing WebSocket header clients and exact MCP 20-tool behavior remain
  unchanged;
- OpenAPI and route-table tests cover every new route.

### Mock system/browser acceptance

Run the real gateway with `TRAECN_ENABLE_MOCK_BRIDGE=1` and exercise:

- unauthenticated loopback load;
- token-protected HTTP and WebSocket connection;
- context hydration and changes;
- task submit, queued, running, question, command approval, review, completed,
  failed, cancelled, and reload/reconnect paths;
- history detail/replay and Advanced inspector;
- 1440x900, 1024x768, and 390x844 layouts;
- keyboard-only operation, focus return, live announcements, 200 percent zoom,
  and reduced motion;
- no console errors, horizontal overflow, secret reflection, or external
  network requests.

### Repository and live gates

Run the focused tests first, then:

```sh
npm run verify:static
npm run test:system
npm run verify
npm run test:release
npm run doctor
npm run inspect:verify
node scripts/live-uat.js --strict --require-ready --require-verified-adapter
```

Strict live UAT without delegation proves current desktop readiness, not a real
task result. A real send/result browser path requires separate quota-spend
authorization and must record the exact task ID, workspace, model, final state,
and reviewed result before it becomes launch evidence.

## Completion criteria

Web Control Console v1 is complete only when:

1. the old synchronous session-per-message page is fully replaced;
2. the normal UI exposes status, explicit context, composer, active tasks,
   exceptional interactions, exact cancellation, results, and recent history;
3. Advanced contains adapter, persistence, metrics, configuration audit, log
   guidance, and OpenAPI without exposing raw driver controls;
4. browser and gateway state remain identity-consistent across concurrent tasks,
   reload, disconnect, and restart;
5. local, mock, and authenticated-private states are visibly distinct;
6. token handling, WebSocket authentication, CSP, Origin checks, approval
   identity, and sanitization tests pass;
7. focused, static, system, full repository, and release gates pass;
8. mock browser acceptance passes at all selected widths and accessibility
   settings;
9. strict live readiness passes on the supported TraeCN adapter;
10. documentation describes the Web Console as the single human product and
    does not claim an unexecuted real-task or remote-host result.

No implementation work begins until this written specification is reviewed and
approved by the repository owner.
