# Handler Dead-Code Audit — settings / config / dialog / preflight

**Date:** 2026-07-22
**Scope:** `src/http/handlers/{config,dialog,settings,preflight}.js` and their wiring in `src/http/gateway.js`
**Question:** Are these 4 handlers "wired" or "dead"? → Decide **wire** or **delete**.

---

## Verdict (tl;dr)

All four modules are **dead code today** — required by `gateway.js` but never invoked, never
referenced by any test, and fully duplicated by inline `_handle*` methods that actually serve
live traffic.

However, the surrounding architecture proves the **intended** design was to wire them: every
other handler group follows the pattern *"gateway `_handle*` = thin delegating shim → module
`handleXxx(req, res, this)`"*. These 4 are a **half-finished migration** — the modules were
extracted but the matching shims were never added.

→ Two clean end-states, pick one (details below):

| Option | What it means | Risk | Behavior change |
|--------|---------------|------|-----------------|
| **DELETE** (recommended) | Remove the 4 modules; keep the working inline implementations | None | **Zero** — modules never ran |
| **WIRE** | Convert the 4 inline gateway methods into thin shims delegating to the modules | Low–Med (needs per-pair re-verify) | Zero *if* modules are still 1:1 |

---

## Evidence

### 1. The 4 modules are required but never used
`gateway.js` requires them (lines 63–66):
```js
const configHandlers   = require('./handlers/config');
const dialogHandlers   = require('./handlers/dialog');
const settingsHandlers = require('./handlers/settings');
const preflightHandlers = require('./handlers/preflight');
```
A repo-wide grep for `configHandlers|dialogHandlers|settingsHandlers|preflightHandlers` and for
`handlers/(config|dialog|settings|preflight)` returns **only those four require lines**. The
bound identifiers are never referenced again. (`cdp/dom-driver.js`'s `dialogsModule` is an
unrelated file.)

### 2. Every *other* handler group IS wired via a thin shim — proving the pattern
Grep for `Handlers.` in `gateway.js` shows the canonical pattern repeated 30+ times:
```js
_handleTasksHistory(req, res)        { return tasksHandlers.handleTasksHistory(req, res, this); }
_handleStatus(req, res)              { return statusHandlers.handleStatus(req, res, this); }
_handleCreateSession(req, res)       { return sessionsHandlers.handleCreateSession(req, res, this); }
_handleDelegateAsync(req, res)       { return delegateHandlers.handleDelegateAsync(req, res, this); }
_handleBatchSubmit(req, res)         { return batchHandlers.handleBatchSubmit(req, res, this); }
_handleDriverAction(req, res, name)  { return driverDispatchHandlers.handleDriverAction(req, res, this, name); }
// … status, soloChat, traeControl, queue, project, taskActions — all 11 groups wired
```
The 4 audit targets are the **only** handler groups whose `XxxHandlers` symbol is never called.
Their gateway `_handle*` methods are instead **full inline implementations** (e.g.
`_handleGetConfig` at 2009, `_handleDialogApprove` at 2508, `_handleSettingsReadAll` at 2408,
`_handlePreflight` at 1877) — i.e. the migration was started (extract) but never finished
(convert-to-shim).

### 3. Live traffic is served by the inline methods, not the modules
`route-table.js` maps each URL to a `_handle*` **method name**. `resolveHandler(gateway, name)`
returns `gateway[name]` → the inline methods. The modules also export their own `ROUTES` arrays,
but those arrays are **never merged** into the gateway's table. So the modules' `handle*`
functions never execute on any request.

### 4. No test references the modules
Grep across `**/*.test.js` for `handlers/(config|dialog|settings|preflight)` → **no matches**.
Deleting them cannot break any test.

### 5. The modules are 1:1 duplicates of the inline methods
Each module header states: *"Moved verbatim from src/http/gateway.js … Behavior is preserved
1:1."* Spot-check — `_handleConfigDiff` (gateway 2064–2099) vs `handleConfigDiff`
(config.js 112–147): **byte-for-byte identical** logic and response shape. `settings.js`'s own
header even admits it: *"this group is currently NOT wired into the Gateway … kept for a future
migration."*

---

## Option A — DELETE (recommended)

**Do:**
1. Delete `src/http/handlers/config.js`, `dialog.js`, `settings.js`, `preflight.js`.
2. Remove the now-dangling require lines 63–66 in `gateway.js`.

**Why this is the safe default:**
- The modules carry **no unique logic** — pure verbatim duplicates.
- They are **never executed**, so removal is a guaranteed **zero-behavior-change** cleanup.
- It directly serves the readability/maintainability goal (kills dead scaffolding + the
  misleading "kept for a future migration" comment).
- Leaves the 4 groups running on their (already-correct) inline implementations — no
  dispatch change.

**Caveat:** after deletion, these 4 groups remain the only ones using the *inline* style while
11 groups use the *module* style. That is a cosmetic inconsistency, not a defect.

---

## Option B — WIRE (architectural consistency)

**Do:** convert the 4 inline gateway methods into thin delegating shims, exactly like the other
11 groups:
```js
_handleGetConfig(req, res)        { return configHandlers.handleGetConfig(req, res, this); }
_handleDialogApprove(req, res)    { return dialogHandlers.handleDialogApprove(req, res, this); }
_handleSettingsReadAll(req, res)  { return settingsHandlers.handleSettingsReadAll(req, res, this); }
_handlePreflight(req, res)        { return preflightHandlers.handlePreflight(req, res, this); }
// … and the rest of each group
```
The modules already call the gateway via `ctx.*` (`_json`, `_confirmationFailure`,
`_ensureConnection`, `_statusSnapshot`, `_probe`, `_compact*`, `_withUiActionLock`,
`_resumeApprovalRequiredTasksAfterDialogAnswer`, `_setTimeout`/`_clearTimeout`, etc.) — all of
which exist on `gateway`, so the interface matches and wiring is technically feasible.

**Why not the default:**
- It is a larger refactor with real (if low) risk: the inline methods are the *live* code and
  may have been patched since the verbatim extraction, so each inline-vs-module pair must be
  re-verified before swap.
- It yields **no functional benefit** — the code is identical. It only buys uniformity.
- Under the standing "zero behavior change" mandate, an unforced rewrite of working dispatch
  paths is not justified unless consistency is an explicit goal.

---

## Risk summary

| Dimension | DELETE | WIRE |
|-----------|--------|------|
| Runtime behavior | unchanged (modules never ran) | unchanged *if* pairs re-verified |
| Tests | unchanged (none reference modules) | unchanged (shim preserves behavior) |
| `handlers/helpers.js` exports used by modules (`rejectBadRequest`, `requireDriverCapability`) | still used by other live handlers → no orphans | same |
| Effort | trivial | moderate (4 groups, ~14 methods) |

## Recommendation
**DELETE** unless architectural uniformity is an explicit priority, in which case **WIRE** with
per-pair verification. Do not leave them as-is — dead, misleadingly-commented scaffolding is
exactly the cruft this refactor exists to remove.
