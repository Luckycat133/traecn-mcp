# Curated Project Skill Routing

Load only the Skill whose trigger matches the task. Project instructions and the user's current request take priority. IDE-specific links resolve to one maintained project source.

| Skill | Use here for |
| --- | --- |
| `traecn-mcp-development` | Repository maintenance, naming migration, MCP contracts, recovery, workspace protection and evidence |
| `traecn-mcp` | Runtime operation for TraeCN MCP (canonical runtime skill synced from `skills/traecn-mcp`) |
| `github-actions` | Release and verification workflow work |
| `mcp-builder` (global) | General MCP protocol and server design via global skill (`~/.gemini/config/skills/mcp-builder`) |
| `playwright-best-practices` | Browser automation patterns |
| `architecture-patterns` | Opt-in integration-heavy structural work |
| `directory-submissions` | MCP Registry (`server.json`), Glama (`glama.json`), Cursor/Claude plugin manifests, `skills.sh`, and directory submissions |
| `clawhub` | ClawHub skill publishing, syncing, and verification workflows |
| `github-release` | GitHub Releases, SemVer tagging, and Keep a Changelog release workflows |

The maintainer source is `.codex/skills/traecn-mcp-development`. Both `.agents` and `.claude` discovery links must resolve to it. The former maintainer identity was migrated; do not resurrect a second active copy. Runtime Skill renaming is a separate atomic source/local-copy/package migration.

Keep project-specific implementation knowledge here rather than in a global Skill. Preserve unrelated Skills. For small changes use focused checks, expanding only for failures, new risk or changed scope.
