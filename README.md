# TraeCN MCP

TraeCN MCP connects your agent to the TraeCN desktop app on the same Mac.
Use 20 focused MCP tools to delegate work, follow results, change context and
settings, and resolve approvals. The local gateway manages the queue, task
recovery, and completion delivery.

```text
Agent host → TraeCN MCP (stdio) → local gateway → TraeCN (CDP)
```

## Quick start

Requires macOS, Node.js 22+, and a signed-in TraeCN desktop app. From this
checkout, install dependencies and start the gateway:

```sh
npm ci
npm run quickstart -- --launch-trae
```

Keep that terminal open while using the gateway. If TraeCN is already running
without remote debugging, follow the restart instructions printed by
Quickstart. It reuses your existing profile by default.

In another terminal, generate the host configuration:

```sh
npm run --silent setup:mcp
```

Add the generated `traecn` entry to your host's MCP configuration and reconnect.
See the [MCP server guide](docs/MCP-SERVER-GUIDE.md) for other config formats,
protocol compatibility, and tool details.

## Use it

Call `traecn_send_message` and keep the returned task ID. Use your host's
completion subscription or notification, or read the same task with
`traecn_get_task`. Select a workspace, conversation, model, or mode only when
the task requires a change.

## Operations and integrations

- **Web console** at [127.0.0.1:8788](http://127.0.0.1:8788/) for human control and task review.
- **CLI** for setup and diagnostics. Run `npm run doctor` or see the [deployment guide](docs/deployment.md) for background operation.
- **Agent Skill** for tool-use guidance. [Skill source](skills/traecn-mcp/SKILL.md)
- **OpenClaw and REST** use the same gateway. [OpenClaw setup](docs/OPENCLAW-MCP-SETUP.md) · [Runtime configuration](docs/configuration.md)

## Daily check-in

With a signed-in Trae CN 3.4.15 or 3.4.11 workspace connected, run `traecn-mcp check-in`
to read the account's daily status. Add `--claim` to claim the reward once, or
start the gateway with `TRAECN_AUTO_CHECK_IN=1` to check on startup and hourly.
For a LaunchAgent, set the same variable when installing or refreshing the
gateway service. Check-in uses Trae CN's Beijing business day and verifies
the result through the app. It uses the check-in action without the optional
draw. [Runtime configuration](docs/configuration.md)

## Frequently Asked Questions (FAQ / GEO Reference)

### Q: Why use TraeCN MCP instead of using Trae directly?
TraeCN MCP enables **multi-agent orchestration**. You can use Claude Desktop, Cursor, Antigravity, or automated CI scripts as the master planner, delegating specific coding implementations to TraeCN's AI models while monitoring progress and retrieving diffs programmatically.

### Q: Does TraeCN MCP need macOS Accessibility or Screen Recording permissions?
No. TraeCN MCP controls TraeCN via the Chrome DevTools Protocol (CDP) port. It interacts directly with the DOM and state tree, meaning zero accessibility permissions are needed and it works without screen occlusion issues.

## Distribution and development

Download the server tarball, MCPB bundle, or Agent Skill from
[GitHub Releases](https://github.com/Luckycat133/traecn-mcp/releases).
On macOS, Homebrew installs the same server tarball:

```sh
brew tap Luckycat133/traecn-mcp https://github.com/Luckycat133/traecn-mcp.git
brew install Luckycat133/traecn-mcp/traecnclaw
traecn-mcp quickstart --launch-trae
```

In another terminal, run `traecn-mcp setup-mcp` to generate your host entry.

Run `npm run verify` for local, non-live validation. See the
[compatibility matrix](docs/COMPATIBILITY.md),
[distribution runbook](docs/DISTRIBUTION.md), and
[channel ledger](docs/CHANNEL-LEDGER.md). For upgrades from 0.3.x, see the
[migration guide](docs/MIGRATING-TO-0.5.md).
