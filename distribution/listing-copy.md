# Canonical Listing Copy

Use this source for public forms and issues. Preserve local-first scope and
tested-platform limits; shorten fields without adding claims.

## Identity

- Name: `TRAECNclaw MCP`
- Repository: `https://github.com/Luckycat133/traecnclaw-mcp-skill`
- Skill path: `.codex/skills/traecnclaw-mcp`
- Category: `Developer Tools` or `MCP Servers`
- Tags: `mcp`, `agent-skills`, `codex`, `openclaw`, `traecn`, `automation`,
  `macos`, `stdio`

## Short descriptions

80 characters:

> Local MCP and Agent Skill for controlling TraeCN coding tasks on your Mac.

160 characters:

> Local-first MCP server and Agent Skill that lets AI agents operate TraeCN coding tasks on the user's Mac through a durable 20-tool interface.

## Full description

> TRAECNclaw connects MCP-capable agents to the TraeCN desktop app running on
> the same Mac. Its focused contract exposes exactly 20 tools for workspace,
> model, mode, conversation, task, and exceptional-dialog intents, while the
> local gateway owns queues, persistence, recovery, and completion delivery.
> It uses local stdio, requires Node.js 22 and TraeCN, and does not claim a
> cloud-hosted runtime. Install the matching server and Agent Skill from the
> public GitHub Release or the verified scoped npm/Homebrew channels.

## Requirements and limitations

- Runs on macOS beside the user's TraeCN desktop app.
- Verified TraeCN adapter evidence covers 1.107.x; unknown versions run in a
  clearly reported degraded fallback and are not claimed as verified.
- Node.js 22 is the release/test baseline.
- MCP transport is local stdio. The loopback gateway is not a public hosted MCP
  endpoint.
- Non-loopback gateway access requires authentication and an explicitly trusted
  network path.
- The tool contract is v5 with exactly 20 ordered, single-intent tools.
- The independently negotiated Tasks extension does not add tools.

## Install copy

Server through npm:

```sh
npm install --global @luckycat133/traecnclaw@<version>
traecnclaw doctor
traecnclaw setup-mcp
```

Server through Homebrew:

```sh
brew install Luckycat133/tap/traecnclaw
traecnclaw doctor
traecnclaw setup-mcp
```

Agent Skill:

```sh
npx skills add https://github.com/Luckycat133/traecnclaw-mcp-skill \
  --skill traecnclaw-mcp \
  -g
```

Do not generate or accept an install command using unscoped
`traecnclaw@0.3.1`.

## Site-specific payloads

### AwesomeSkills.dev

- GitHub URL:
  `https://github.com/Luckycat133/traecnclaw-mcp-skill/tree/main/.codex/skills/traecnclaw-mcp`
- Expected result: one Skill entry sourced from the public mirror, not a fork.

### MCP Server Hub

- URL: `https://github.com/Luckycat133/traecnclaw-mcp-skill`
- Title: `TRAECNclaw MCP`
- Category: `Developer Tools`
- Keywords: `mcp, trae, traecn, coding agent, macos, local, stdio`
- Description: use the 160-character copy above.

### mcp.so issue

Title:

> Add TRAECNclaw MCP — local TraeCN desktop automation

Body:

> Please add TRAECNclaw MCP from
> https://github.com/Luckycat133/traecnclaw-mcp-skill. It is a local stdio MCP
> server and Agent Skill for TraeCN desktop automation on macOS, with exactly 20
> focused tools. It requires Node.js 22 and a local TraeCN installation; it is
> not a hosted cloud endpoint. Please use the scoped
> `@luckycat133/traecnclaw` package and do not generate an install command from
> historical unscoped `traecnclaw@0.3.1`.

### Glama correction

> Sync the current public mirror and list TRAECNclaw as a local stdio server on
> the user's Mac. The current MCP contract has exactly 20 tools. Do not present
> the inspection container as a hosted connection to the user's TraeCN app, and
> do not use the historical unscoped npm package.
