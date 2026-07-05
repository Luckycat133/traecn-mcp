# Continuous Development Loop State

This file is the durable handoff state for the recurring Codex development
loop. Every scheduled development run must read it before choosing work and
update it before finishing.

## Update Rules

- Read this file before selecting the run objective.
- Update `Active Run` at the start of each run with the selected objective.
- Append one concise `Run Log` entry before the run finishes.
- Update `Current Focus`, `Priority Backlog`, and `Next Recommended Work` when
  new evidence changes the plan.
- Record verification commands and results, including failures or skips.
- Record commit hashes when the automation creates a commit.
- Keep entries short enough to be useful as context. Prefer facts over status
  prose.
- Do not store secrets, tokens, raw TraeCN profile data, logs, or local output.

## Product Direction

TRAECNclaw should become a reliable TraeCN automation gateway, MCP server, and
OpenClaw integration that any AI agent can use through a simple developer
interface. The project is still considered incomplete. Large changes are
acceptable when they produce a coherent, verified improvement.

## Automation Contract

- Automation name: `TRAECNclaw continuous development loop`
- Schedule: hourly, starting from 2026-07-04 14:00 Asia/Shanghai
- Model posture: high-effort recurring development in an isolated worktree
- Default safety boundary: no real TraeCN task submission, quota spend, push, or
  external UI operation without explicit user approval
- Expected output per run: code/docs/tests improvement, verification evidence,
  durable state update, and optionally a conventional commit in the automation
  worktree

## Observed Automation Outputs

The loop has produced multiple clean worktree commits that are not merged to
`main` yet:

- 2026-07-04 23:10, `/Users/jack/.codex/worktrees/4d60/TRAECNclaw`,
  `54a085f feat(skill): expose recovery helpers in node api`
- 2026-07-05 00:12, `/Users/jack/.codex/worktrees/3553/TRAECNclaw`,
  `d082303 feat(skill): add node recovery api parity`
- 2026-07-05 01:09, `/Users/jack/.codex/worktrees/0d94/TRAECNclaw`,
  `db92f76 feat(agent): expose unattended status handoff`
- 2026-07-05 02:06, `/Users/jack/.codex/worktrees/f801/TRAECNclaw`,
  `1cb046e test(repo): discover maintained test and syntax surfaces`
- 2026-07-05 03:09, `/Users/jack/.codex/worktrees/aaa5/TRAECNclaw`,
  `70a1022 feat(mcp): generate agent client configs`
- 2026-07-05 04:15, `/Users/jack/.codex/worktrees/be86/TRAECNclaw`,
  `ee0cdae feat(mcp): add agent connection manifest`
- 2026-07-05 05:12, `/Users/jack/.codex/worktrees/61bf/TRAECNclaw`,
  `001f6b2 feat(cli): expose unattended status report`
- 2026-07-05 06:13, `/Users/jack/.codex/worktrees/7888/TRAECNclaw`,
  `6b5b463 feat(mcp): expose unattended status diagnostic`
- 2026-07-05 07:16, `/Users/jack/.codex/worktrees/7b82/TRAECNclaw`,
  `93ee252 feat(agent): expose unattended status surfaces`
- 2026-07-05 08:12, `/Users/jack/.codex/worktrees/7bb6/TRAECNclaw`,
  `9f1e579 feat(skill): expose unattended status helper`

All observed worktrees were clean when inspected. The automation-local memory
reported broad verification passing for the 05:12 through 08:12 runs, including
lint, focused tests, `npm test`, `npm run acceptance:audit -- --require-complete`,
and other relevant gates. None of the observed commits were merged to `main`
at inspection time.

## Current Focus

Build compounding product maturity around:

- real agent-facing APIs and low-friction developer entrypoints
- executable MCP and OpenClaw surfaces
- gateway readiness, recovery, and diagnostics
- dialog and task-state recovery
- unattended workflow acceptance evidence
- queue cleanup reliability
- deterministic prompt layers and live/mock parity
- tests and documentation for installation, configuration, API behavior, and
  workflows

## Priority Backlog

1. Verify that public agent entrypoints remain executable and documented:
   simple API, HTTP gateway, MCP server, CLI, and OpenClaw plugin.
2. Strengthen unattended acceptance coverage so failures explain the missing
   evidence instead of reporting generic incomplete status.
3. Improve gateway recovery paths around stale processes, disconnected CDP, and
   readiness blockers.
4. Improve queue cleanup and long-queue status reporting without submitting live
   prompts or spending quota by default.
5. Keep OpenAPI, README, development docs, and plugin command docs synchronized
   with implementation behavior.
6. Expand tests for changed behavior using the existing plain Node test style.

## Active Run

- Status: idle
- Objective: none
- Started: none
- Notes: next automation run should choose from `Priority Backlog` unless new
  repo evidence points to a higher-value target.

## Next Recommended Work

Reconcile the unmerged automation outputs before starting unrelated new feature
work. Prefer building one coherent integration branch from the latest compatible
commits, deduplicating overlapping unattended-status changes, then running broad
verification before merge.

## Run Log

### 2026-07-05 - Import observed automation output state

- Objective: record the actual scheduled loop outputs so future runs can avoid
  duplicating sibling work.
- Why it mattered: the durable state file was added after the first observed
  automation runs, so those runs could not update this file themselves.
- Files changed: `docs/CONTINUOUS-DEVELOPMENT-LOOP.md`.
- Verification: `git diff --check` and `git diff --cached --check` passed
  before commit.
- Commit: `docs(loop): add continuous development state`.
- Remaining risk: unmerged worktree commits still need review, deduplication,
  and integration.
- Next: reconcile automation outputs into a coherent branch before starting
  unrelated new feature work.

### 2026-07-05 - Seed continuous development state

- Objective: create a versioned state file for the recurring development loop.
- Change: added this durable context file and update protocol.
- Verification: `git diff --check` passed; automation configuration now
  references this file as mandatory durable context.
- Commit: none yet.
- Next: run a repo orientation pass and choose the first substantial objective
  from `Priority Backlog`.

## Run Log Entry Template

```md
### YYYY-MM-DD - short objective

- Objective:
- Why it mattered:
- Files changed:
- Verification:
- Commit:
- Remaining risk:
- Next:
```
