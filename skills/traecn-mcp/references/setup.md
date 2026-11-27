# Connect a host to the local runtime

The local runtime requires macOS, Node.js 22+, and TraeCN. The Skill supplies a
launcher and client configuration; install the matching server separately.

1. Use a source checkout, release server archive, or current scoped package. The launcher checks the repository, `@luckycat133/traecnclaw`, the legacy installed `traecnclaw` package, then `traecn-mcp` on `PATH`. It resolves symlinks to the server's directory and never accepts an environment-selected JavaScript entry point. Historical `traecnclaw@0.3.1` is not a current install target.
2. Run `traecn-mcp doctor` and `traecn-mcp setup-mcp` for an installed server; a checkout uses `npm run doctor` and `npm run --silent setup:mcp`. Alternatively, run `node scripts/setup-mcp.js` from this Skill directory. Setup locates the server and prints an absolute launcher entry. `--output FILE` atomically creates a mode-0600 file and refuses existing files. [Client templates](../assets) are manual fallbacks; a printed config does not prove a running gateway or host connection.
3. Start/check the installed gateway with `traecn-mcp quickstart`, or run `npm run start:gateway` in the checkout, then reconnect the MCP client.

