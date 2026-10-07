# Curated Project Skill Routing

This repository keeps task-specific Skills in .agents/skills plus existing project-owned skills. Codex and Claude entry directories point to the same project-owned copies where links are present.

This table records the Skills reviewed or added by the 2026-09-11 audit; it does not remove or replace other project-owned Skills already present in the repository.

Load only the Skill whose trigger matches the current task. A Skill may be reused by several projects, and this project may use several Skills. Existing repository instructions and the user's current request take priority over a Skill.

| Skill | Use here for |
|---|---|
| `traecnclaw-development` | Primary maintainer workflow; existing project source |
| `traecnclaw-mcp` | Public MCP operation skill; existing project source |
| `github-actions` | Release and verification workflow work |
| `mcp-builder` | General MCP protocol and server design |
| `playwright-best-practices` | Browser automation patterns; repaired project-local source |
| `architecture-patterns` | Opt-in boundaries for integration-heavy structural work |

## Maintenance rules

- Keep domain and implementation Skills in the project instead of the global Codex Skill directory.
- Preserve project-specific Skills as the source of truth; do not replace them with an archived global copy.
- Prefer links for IDE-specific discovery so Codex and Claude read the same maintained content.
- Add or expand a Skill only when it captures repeatable project knowledge that is not already clear from code or repository documentation.
- For small changes, run focused checks first and expand testing only when failures, risk, or new scope justify it.
