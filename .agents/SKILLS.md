# Curated Project Skill Routing

Load only the Skill whose trigger matches the task. Project instructions and the user's current request take priority. IDE-specific links resolve to one maintained project source.

| Skill | Use here for |
| --- | --- |
| `traecn-mcp-development` | Repository maintenance, naming migration, MCP contracts, recovery, workspace protection and evidence |
| `traecnclaw-mcp` | Runtime operation; retained compatibility identity in the reviewed source, not the preferred project name |
| `github-actions` | Release and verification workflow work |
| `mcp-builder` | General MCP protocol and server design |
| `playwright-best-practices` | Browser automation patterns |
| `architecture-patterns` | Opt-in integration-heavy structural work |

The maintainer source is `.codex/skills/traecn-mcp-development`. Both `.agents` and `.claude` discovery links must resolve to it. The former maintainer identity was migrated; do not resurrect a second active copy. Runtime Skill renaming is a separate atomic source/local-copy/package migration.

Keep project-specific implementation knowledge here rather than in a global Skill. Preserve unrelated Skills. For small changes use focused checks, expanding only for failures, new risk or changed scope.
