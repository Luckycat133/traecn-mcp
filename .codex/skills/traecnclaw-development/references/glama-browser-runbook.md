# Glama registration and quality-score browser runbook

Use this runbook only after the public repository preflight is green. The goal
is to register and verify the local-first TRAECNclaw MCP server on Glama without
misrepresenting a cloud container as a user's local TraeCN runtime.

## Scope

Selected in this pass:

- submit or locate `Luckycat133/traecnclaw-mcp-skill`;
- authenticate with GitHub;
- claim authorship/maintainer ownership;
- force metadata sync;
- verify README, LICENSE, Release, language, local transport, and tool schema;
- inspect the quality/security score;
- optionally run a private build test for schema introspection;
- record every actionable finding.

Not selected in this pass:

- publishing a public Glama-hosted connector that claims to control the user's Mac;
- putting a gateway token in Glama metadata, build files, screenshots, or logs;
- enabling TRAECNclaw mock mode to make marketplace tool calls appear successful;
- changing the private canonical repository visibility;
- creating a new runtime transport solely for Glama.

## Repository preflight

Before opening Glama, verify the public repository in the browser or GitHub:

1. Repository is public:
   `https://github.com/Luckycat133/traecnclaw-mcp-skill`.
2. Root `glama.json` exists and includes maintainer `Luckycat133`.
3. Root `LICENSE` is detected by GitHub.
4. Root README describes a **local stdio** server requiring TraeCN and the gateway on the user's Mac.
5. The public Release matching `package.json` (currently target `v0.5.9`) exists with:
   - `traecnclaw-0.5.9.tgz`;
   - `traecnclaw-mcp-0.5.9.mcpb`;
   - Skill archive(s);
   - release manifest.
6. Root Dockerfile installs the current public release and contains none of:
   - `0.3.0`;
   - `TRAECN_MCP_TOOL_PROFILE`;
   - legacy `TRAECN_HOST`;
   - legacy `TRAECN_PORT`.
7. `SOURCE_REVISION` and `release-manifest.json` still identify the exact canonical release revision.
8. No secret, token, `.env`, user path, or private repository credential is present.

If any preflight item fails, stop browser registration and report the exact file.
Do not work around canonical defects in the Glama dashboard.

## Sign in and submit

1. Open `https://glama.ai/`.
2. Choose **Sign Up** or **Sign In** and authenticate with the GitHub account
   `Luckycat133`.
3. Find the MCP server submission flow. Current Glama copy describes it as
   **Submit a GitHub repo**, **List your server**, or similar.
4. Enter exactly:

   ```text
   https://github.com/Luckycat133/traecnclaw-mcp-skill
   ```

5. If Glama reports that the repository is already indexed, open the existing
   server page instead of creating a duplicate.
6. Save the resulting listing URL.

Do not submit the private `Luckycat133/TRAECNclaw` repository.

## Claim ownership

Claim and manual sync mutate a public listing. Show the exact target listing
and obtain action-time confirmation before clicking the final Claim or Sync
control.

1. Open the server page's **Score** tab or click **Claim** / **Claim authorship**.
2. Complete GitHub authorization using `Luckycat133`.
3. Confirm Glama recognizes the root `glama.json` maintainer.
4. If claim fails:
   - verify the authenticated GitHub username;
   - verify `glama.json` syntax;
   - verify the repository is public;
   - retry the claim flow once after metadata sync.
5. Record whether the page shows **Maintainer verified**, **Author verified**, or
   equivalent.

After `glama.json` changes, Glama's documented behavior requires running the
claim flow again so the service reloads the file.

## Sync metadata

1. Open the server admin interface.
2. Click **Sync Server** or the current equivalent.
3. Wait until the sync completes.
4. Reload the Overview and Score tabs.
5. Record the observed sync time and repository commit if Glama shows it.

Glama also performs periodic syncs, but the manual sync is required for this
verification pass.

## Verify the listing

Check and record:

- Name: `TRAECNclaw MCP`.
- Repository: the public mirror.
- Maintainer: `Luckycat133`.
- License: MIT.
- Language/runtime: JavaScript or Node.js 22.
- Transport/type: local stdio, not a native hosted remote connector.
- Current public Release: the exact target version from `package.json`
  (0.5.9 for this campaign).
- Tool count: exactly 20.
- Tool names: match contract v5.
- No tool profiles.
- README/install instructions point to the public mirror Release and MCP-first setup.
- Description states that TraeCN and the gateway run on the user's Mac.
- Categories/tags emphasize developer tools, desktop automation, coding agents,
  local-first, macOS, MCP, and Agent Skills.

If Glama shows a different tool count or old tool/profile descriptions, capture
that evidence and stop. The public build input is stale.

## Score and security review

Open the **Score** tab and record each visible item, including:

- README detected;
- LICENSE detected;
- Release detected;
- server inspectable;
- tools detected;
- author/maintainer verified;
- vulnerability result;
- tool-definition quality;
- server-coherence quality;
- usage or review observations;
- related-server suggestions.

The quality score is useful diagnostic evidence. It is not proof that a cloud
container can reach a user's TraeCN desktop.

For every negative finding:

1. Capture the exact text.
2. Identify the canonical owning file.
3. Fix canonical source or `distribution/public-mirror` templates.
4. Regenerate/sync the public mirror.
5. Re-run Claim if `glama.json` changed.
6. Click Sync Server again.

Do not patch generated Skill bytes manually in the public mirror.

## Private build test

Glama's current release flow uses the Dockerfile admin page:

```text
/mcp/servers/{owner}/{repo}/admin/dockerfile
```

A build test is allowed only for package boot and tool-schema inspection.
Glama's 2026-08-24 admin does not select the repository Dockerfile directly;
it generates one from form fields. Keep the root Dockerfile as the canonical
local preflight, then enter the equivalent inspection-only form values below.

1. Open the Dockerfile admin page after **Sync Server** reports the current
   public commit.
2. Set Node.js to `22`. The selected Debian base may remain the current Glama
   default; Python is unused and may remain at the form default if the field
   cannot be empty.
3. Set **Build steps** to the current public Release archive, replacing the
   version only after its downloaded digest has been verified:

   ```json
   ["npm install --global --ignore-scripts --force https://github.com/Luckycat133/traecnclaw-mcp-skill/releases/download/v0.5.9/traecnclaw-0.5.9.tgz"]
   ```

   `--force` bypasses only the package's intentional Darwin platform guard for
   Linux schema inspection. It does not make Linux a supported runtime.
4. Set **CMD arguments** to:

   ```json
   ["mcp-proxy", "--", "traecnclaw-mcp"]
   ```

   `mcp-proxy` is Glama's inspection wrapper; the upstream remains local stdio.
5. Set **Environment variables JSON schema** to an empty object schema and
   **Placeholder parameters** to an empty object:

   ```json
   {"type":"object","properties":{}}
   ```

   ```json
   {}
   ```

   Do not enter a gateway token, legacy tool profile, or mock-mode variable.
6. Pin the full current public-mirror commit SHA. For 0.5.9 this is
   `5ad3a3e18aac63cffa8f61ba792c427a2fd897b5`; do not use the stale dashboard
   placeholder.
7. Obtain action-time confirmation, then click **Build**. Never click
   **Build & Release** for this inspection pass.
8. Verify the image builds, the MCP process starts, reports release 0.5.9, and
   Glama lists exactly 20 tools.
9. If Glama calls a tool, the expected honest result without a user gateway is
   a clear connection/setup failure such as `ECONNREFUSED 127.0.0.1:8788`—not
   a mock TraeCN answer.
10. Capture build logs with secrets redacted.

## Public Glama release guard

A Glama release is a containerized deployable release, not the same as the
public GitHub Release.

Do **not** click **Make Release** / **Create & Publish Release** in this pass if
it would cause users to believe Glama's cloud container can automatically reach
their local Mac.

A future Glama hosted release is allowed only after all of these are true:

- the product deliberately supports a secured reachable user gateway;
- authentication and TLS/tunnel instructions are complete;
- the listing makes the local-Mac dependency explicit;
- a real end-to-end hosted-to-Mac task succeeds;
- no token is baked into an image;
- the maintainer explicitly selects that product scope.

Until then, Glama is a directory, claim, schema inspection, score, and discovery
channel.

## Post-registration evidence

Return a compact report containing:

```text
Listing URL:
Authenticated GitHub user:
Claim status:
Sync status/time:
Detected release:
Detected license:
Detected language/transport:
Detected tool count:
Schema inspection:
Quality score:
Security result:
Build-test status:
Hosted release created: no
Actionable findings:
Screenshots captured:
```

Do not include tokens, authorization headers, private repository URLs with
credentials, or raw environment values.

## Repository cleanup

After successful registration:

1. Update or close public mirror issue #1 when listing, claim, build inspection,
   score review, and upstream follow-up are complete.
2. Update issue #2 only for the tasks actually completed. Leave sync-token or
   GitHub Actions credential work open until those secrets are configured.
3. Add the Glama listing URL and observed score to the canonical project audit.
4. Add a Glama badge to the public README only after the listing URL is stable
   and the badge accurately represents the scanned repository.
5. Do not create a new release solely to add a badge or score text.
