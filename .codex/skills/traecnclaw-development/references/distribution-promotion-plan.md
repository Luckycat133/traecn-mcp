# TRAECNclaw distribution and promotion plan

Use this plan for public packaging, directory submission, browser-Agent handoff,
launch content, and post-publication verification. Recheck every channel before
acting; marketplace requirements and public versions change independently.

## Principles

1. **Install truth before listing count.** Every listing must point to a public,
   exact-version server and the matching Skill.
2. **One canonical source.** Fix source or generated public-mirror templates in
   the private canonical repository, then regenerate the public mirror.
3. **Separate channel types.** A package host, MCP registry, Skill directory,
   curated list, newsletter, and social post prove different things.
4. **Local-first honesty.** TRAECNclaw runs beside the user's TraeCN on macOS.
   A marketplace container or directory page is not the runtime.
5. **Evidence after submission.** Record URL, version, detected tools, install
   result, scan/score, owner status, and date.
6. **No shotgun spam.** Prefer a few high-signal channels, then syndicate the
   same verified metadata to lower-maintenance directories.
7. **No secret transfer.** Never put gateway tokens, private canonical access,
   `.env` contents, raw user paths, or TraeCN profile data into listings,
   Dockerfiles, screenshots, or browser-Agent reports.

## Canonical public identity

Use these identities unless a later release deliberately changes them:

```text
Product: TRAECNclaw MCP
Public repository: https://github.com/Luckycat133/traecnclaw-mcp-skill
Canonical source: private Luckycat133/TRAECNclaw
Current selected public version: 0.5.6 (recheck)
Runtime: local stdio MCP server + local HTTP gateway
Platform: macOS; verified TraeCN 1.107.x (recheck compatibility evidence)
Contract: MCP tool contract v5, exactly 20 tools
License: MIT for public repository/server; runtime Skill metadata as published
```

Do not submit the private canonical repository to public directories. Use the
public mirror and its Release assets, while preserving `SOURCE_REVISION` and the
release manifest as provenance.

## Channel taxonomy

### Installation channels

These deliver runnable bytes or a one-command install:

- Public GitHub mirror Release — selected and existing.
- ClawHub — selected and existing for the Skill.
- MCPB bundle — selected next for one-click local MCP installation.
- Smithery local/MCPB publication — selected after the bundle is verified.
- Homebrew tap — selected after the public archive/install script is stable.
- Current public npm package — selected only after package-name/version and old
  `traecnclaw@0.3.1` handling are deliberate.

### Authority and aggregation channels

These establish machine-readable identity and feed other indexes:

- Official MCP Registry — selected after a current public package exists.
- PulseMCP — normally ingested from the Official Registry; manually submit only
  if ingestion does not occur.
- Glama — selected for claim, schema inspection, score, and directory listing.

### Skill discovery channels

- skills.sh — selected immediately; installation from the public GitHub repo
  automatically creates usage/install evidence.
- AwesomeSkills.dev — selected immediately.
- MCP.Directory Skill listing — selected immediately.
- Additional Skill directories may be syndicated later when submission is free,
  transparent, and does not require maintaining duplicate code.

### MCP directory channels

- MCP.Directory Server listing — selected immediately.
- punkpeye/awesome-mcp-servers — selected after Glama listing/score and exact
  install copy are ready.
- mcp.so — selected as a secondary directory.
- MCP Server Hub (`mcpserver.dev`) — selected as a secondary directory.
- mcpservers.org and AllMCPs — low-cost syndication after higher-signal listings.

### Channels deliberately deferred or rejected

- `mcpub`: designed around live public remote endpoints; TRAECNclaw is local
  stdio, so do not submit unless a real remote product is selected.
- Glama public hosted release: not selected; cloud hosting cannot transparently
  access the user's Mac.
- Smithery URL publication: requires a public Streamable HTTP endpoint; use
  local MCPB publication instead.
- Official MCP Registry pointing at npm 0.3.1: prohibited; that package is not
  the current server.
- Dozens of unverified SEO directories: defer unless they produce measurable
  installs or useful feedback.
- Paid featured placement: do not buy before organic install and retention data
  justify it.

## Recommended execution order

### Phase A — repair and verify the current public mirror

1. Merge the canonical Glama/public-mirror generator changes after tests.
2. Merge the generated public-mirror Glama/Dockerfile change.
3. Verify public Release assets and `SOURCE_REVISION`.
4. Confirm the root Dockerfile installs the current public server archive and
   exposes the exact 20 tools without mock mode.
5. Run the Glama browser runbook and record the listing and score.

### Phase B — immediate no-new-package discovery

These use the existing public repository and Skill:

1. **skills.sh**
   - Test discovery:
     `npx skills add https://github.com/Luckycat133/traecnclaw-mcp-skill --list`
   - Test a clean global install for a supported Agent.
   - Publish the exact install command in the public README.
   - Confirm a skills.sh page appears after real installs; do not fabricate
     install counts.

2. **AwesomeSkills.dev**
   - Submit the direct public Skill path if root auto-detection is ambiguous:
     `https://github.com/Luckycat133/traecnclaw-mcp-skill/tree/main/.codex/skills/traecnclaw-mcp`
   - Verify name, description, platforms, source, and install command.

3. **MCP.Directory — Skill**
   - Submit the same direct Skill URL.
   - Verify the parsed name, description, category, and source.

4. **MCP.Directory — Server**
   - Submit the public mirror repository.
   - Do not supply the old npm package.
   - Verify tool count, local stdio type, macOS requirement, and current Release.

5. **MCP Server Hub / mcp.so**
   - Submit only after the canonical listing copy is finalized.
   - Use the public mirror as the primary link.
   - Verify the listing does not manufacture an `npx` install using npm 0.3.1.

### Phase C — one-click local packaging

#### MCPB

MCPB is the best-fit next package for a local desktop automation server. Build a
bundle that contains the complete Node server and dependencies plus a valid
`manifest.json`.

Required implementation:

- create a canonical MCPB manifest template;
- package the current server archive/dependencies reproducibly;
- configure only the local gateway host, port, optional token, and stable client
  ID as user configuration;
- keep the local gateway and TraeCN dependency explicit;
- include version, license, repository, icons only when reproducible;
- run `mcpb pack` and manifest validation;
- install the bundle in at least one real MCPB-capable desktop host;
- verify discovery, exact 20 tools, one mock clean-room task, then one live task
  only when authorized;
- add the `.mcpb` filename, size, SHA-256, and source revision to release
  provenance.

Do not bundle a user token, logged-in Trae profile, or local persistence files.

#### Smithery local publication

After MCPB passes:

1. Publish the prebuilt `.mcpb` through Smithery's Local flow.
2. Verify configuration UI and metadata.
3. Install the downloaded artifact through Smithery into a clean host.
4. Verify the installed bundle resolves the local gateway and lists 20 tools.
5. Record Smithery page, bundle version/digest, install result, and any analytics
   setting.

Smithery Uplink may be tested for the maintainer's own private host when a real
local editor dependency is needed. Do not make Uplink a permanent public runtime
or imply the user's Mac stays available when the Uplink process is offline.

### Phase D — current public package and Official MCP Registry

This phase requires a product/package naming decision because public npm
`traecnclaw@0.3.1` is an older independent surface.

Preferred options, in order:

1. Publish a new scoped current package such as
   `@luckycat133/traecnclaw`, then deprecate or clearly redirect the old package.
2. Upgrade the existing unscoped package only if ownership, compatibility, and
   migration can be handled without surprising existing users.
3. Use another public artifact registry supported by the Official MCP Registry
   only when it improves installation rather than adding complexity.

Before publish:

- remove `private: true` only in the deliberate package source/build path;
- verify package contents from a clean tarball;
- require exact `mcpName` matching the intended registry namespace;
- run full audit, repository, release, and clean-room gates;
- install from the public registry, not a local tarball;
- confirm `traecnclaw-mcp` starts and lists 20 tools;
- deprecate or document the old package explicitly.

Then publish to the Official MCP Registry:

```text
mcp-publisher init
mcp-publisher login github
mcp-publisher publish
```

Use a GitHub-authenticated `io.github.Luckycat133/...` namespace consistent
with the package `mcpName`. Validate the public Registry API result and install
metadata. Registry versions are immutable; publish a new version for corrections.

After Registry publication:

- wait for PulseMCP and other aggregators to ingest it;
- verify PulseMCP classification, package, transport, install instructions, and
  maintainer identity;
- use manual PulseMCP submission only if automatic ingestion fails after the
  documented interval;
- add Official Registry and PulseMCP URLs to the channel ledger.

### Phase E — Homebrew for Mac operators

Create `Luckycat133/homebrew-tap` only after the public package/archive is
stable.

The formula should:

- install the exact public archive with SHA-256;
- install Node dependencies reproducibly under `libexec` or install a prepared
  self-contained artifact;
- link `traecnclaw` and `traecnclaw-mcp` binaries;
- include a `test do` block that checks version/help and stdio discovery without
  requiring live TraeCN;
- document the third-party tap trust model;
- update automatically from verified Releases only after a release workflow is
  proven.

Recommended user command:

```sh
brew install Luckycat133/tap/traecnclaw
```

Homebrew installs the operator/server layer. It does not install the Skill into
every Agent host; pair it with `setup:mcp` or the skills.sh install command.

### Phase F — curated and secondary directories

1. **punkpeye/awesome-mcp-servers**
   - Reconcile the existing upstream PR rather than opening a duplicate.
   - Follow current contribution rules exactly.
   - Include the Glama listing/score if requested by maintainers.
   - Classify as local, Node, macOS, developer tools/desktop automation.

2. **mcpservers.org, AllMCPs, MCPSkills, MCP Server Hub**
   - Submit the same canonical listing copy.
   - Do not buy premium placement initially.
   - Verify generated install commands and request correction when they point to
     npm 0.3.1 or imply remote hosting.

3. **PulseMCP and downstream indexes**
   - Prefer official-registry ingestion.
   - Avoid maintaining separate divergent manifests.

Stop adding directories when the marginal channel produces no installs,
feedback, links, or indexing benefit.

## Canonical listing copy

Keep one source-controlled copy pack for all forms. A future implementation may
store it as generated JSON/YAML, but the content must include:

### Name

```text
TRAECNclaw MCP
```

### Short description

```text
Local-first MCP Skill and server that lets AI agents operate the TraeCN desktop app on a user's Mac through a durable gateway.
```

### Medium description

```text
TRAECNclaw connects MCP-capable agents to TraeCN on macOS. Its focused 20-tool contract covers tasks, workspace/model/mode/conversation selection, visible settings, and exceptional approvals, while the local gateway owns queueing, persistence, restart recovery, task identity, and completion delivery. The runtime stays on the user's Mac; directory and marketplace containers are for discovery or package inspection, not a hosted copy of TraeCN.
```

### Categories

Prefer:

```text
Developer Tools
Desktop Automation
Coding Agents
Local-First
macOS
Agent Skills
```

### Tags

```text
mcp
agent-skills
traecn
trae
coding-agent
desktop-automation
local-first
macos
stdio
```

### Links

- Public repository and downloads: public mirror.
- Skill path: `.codex/skills/traecnclaw-mcp`.
- Canonical provenance: `SOURCE_REVISION` and release manifest.
- Documentation: public README and setup guide.
- Issues: public mirror issues for install/distribution problems.

### Honest requirements

- macOS;
- TraeCN desktop;
- current verified version scope as recorded in compatibility docs;
- local gateway running on the same Mac;
- Node.js only when the selected package format does not bundle it;
- optional gateway token according to bind configuration.

## Browser-Agent submission protocol

For every directory form:

1. Search for an existing listing first.
2. Sign in only when required and use the maintainer's authorized account.
3. Submit the public mirror, never the private canonical repository.
4. Paste canonical listing copy; do not improvise package/install claims.
5. Select local/stdio/macOS when available.
6. Save the listing URL and capture screenshots of version, install, tool count,
   owner status, and score/scan.
7. Test the generated install command in a clean environment.
8. Record every incorrect generated field and the correction request.
9. Do not pay, create hosted releases, or grant new scopes without explicit
   authorization.
10. Update the channel ledger and relevant public issue.

Return:

```text
Channel:
Listing URL:
Submitted/claimed account:
Observed version:
Repository/package/install command:
Transport/platform:
Tool count:
Owner/verification status:
Security/quality result:
Clean install tested:
Actionable problems:
Screenshots:
Next action:
```

## Promotion strategy

Distribution makes the project installable; promotion explains why someone
should care. Use a single launch narrative and adapt its depth to each community.

## Audience and message

### Agent users

Promise:

```text
Give your coding Agent a durable, focused way to operate TraeCN without making the Agent babysit queues, UI recovery, or completion polling.
```

### Human TraeCN users

Promise:

```text
Operate and monitor your own TraeCN from agents today, and from one remote Web Control Console as the human interface matures.
```

### MCP developers

Technical story:

- local desktop bridge rather than cloud API wrapper;
- stable intent-level tools;
- durable tasks and terminal idempotency;
- exact conversation/result ownership;
- legacy and modern host interoperability;
- honest local/marketplace boundary.

## Launch asset kit

Do not promote broadly until these assets exist:

1. **60–90 second demo video**
   - install/configure;
   - Agent sends one task;
   - TraeCN visibly performs it;
   - task survives background execution;
   - result returns to the host;
   - show the web console briefly only when it is usable.

2. **Five-minute tutorial**
   - public download;
   - `setup:mcp`;
   - start/check gateway;
   - configure a named host;
   - send a safe example task;
   - troubleshoot with doctor.

3. **Architecture diagram**

```text
Agent Host -> MCP stdio -> Local Gateway -> TraeCN CDP/DOM
Human Browser -> Web Control Console -> same Local Gateway
```

4. **Three reproducible use cases**
   - ask TraeCN to inspect or change a small repository;
   - switch context/model then delegate a task;
   - monitor/recover a long task and retrieve the exact result.

5. **Honest limitations card**
   - macOS and verified TraeCN version;
   - local runtime required;
   - marketplace hosting is not the desktop runtime;
   - approvals remain explicit.

6. **README media**
   - concise hero;
   - current install commands;
   - short GIF or video thumbnail;
   - channel badges only after verified listings exist.

## High-priority promotional channels

### Chinese launch

1. **TRAE official Chinese community**
   - Highest-fit audience and feedback channel.
   - Publish in `案例与作品` with a complete demo, architecture, installation,
     limitations, and request for real Mac/TraeCN feedback.
   - Publish a separate `技巧分享` post only when it teaches a reusable workflow,
     not as a duplicate advertisement.
   - Route bugs and product suggestions to the community's designated support
     categories.

2. **Bilibili**
   - Primary Chinese visual demo.
   - Produce one concise “Agent 操作 TraeCN 全流程” video and one detailed setup
     tutorial rather than many shallow clips.
   - Put exact public links and version in the description and pinned comment.

3. **V2EX / 掘金 / 知乎**
   - Choose two initially.
   - V2EX: engineering story and request for testers.
   - 掘金: implementation article about local MCP, durable tasks, and desktop
     automation.
   - 知乎: explanatory comparison of “让 Agent 操作 TraeCN” versus another coding
     agent, without unsupported benchmark claims.

4. **TRAE Friends / meetup/demo day**
   - Submit a short real demo when a relevant city or online event is available.
   - Use it to collect observed onboarding problems, not just exposure.

### Global launch

1. **GitHub owned media**
   - Release notes, README demo, social preview, Discussions/Issues, and a clear
     public roadmap are the permanent source.

2. **YouTube**
   - English version of the short demo and setup tutorial.
   - Use chapters and show real host + real TraeCN, not only slides.

3. **Show HN**
   - Only after public users can actually download and try the project.
   - Title begins with `Show HN`.
   - Explain why it was built, local architecture, hard reliability problems,
     limitations, and what feedback is sought.
   - Do not ask for upvotes or post a marketing landing page.

4. **Product Hunt**
   - Defer until the Web Control Console and onboarding feel like a complete
     product rather than only repository metadata.
   - Prepare a direct product URL, concise description, thumbnail, at least two
     gallery assets, demo video, and a personal first comment.
   - Ask for feedback, never upvotes.

5. **X / LinkedIn**
   - One launch thread/post with the short video, architecture, and exact
     limitations.
   - Follow up with technical findings and user stories, not repeated install
     spam.

6. **Relevant Reddit communities**
   - Use only where self-promotion rules allow it.
   - Provide the full technical value in the post and engage with criticism.
   - Do not cross-post identical copy to many subreddits on one day.

### Ecosystem editorial

- PulseMCP visibility follows Official Registry publication; request editorial
  attention only after the listing and install are accurate.
- Curated awesome lists are discovery, not a launch by themselves.
- MCP contributor Discord is for technical collaboration, not product marketing.

## Promotion cadence

### Before launch

- Recruit 3–10 real macOS testers from the TRAE community.
- Fix first-run failures.
- Capture one successful Codex/host task and one remote web-console flow when
  available.
- Finalize the launch asset kit and canonical copy.

### Launch week

Day 1:

- GitHub Release/README refresh;
- TRAE community case post;
- Bilibili and YouTube demo;
- X/LinkedIn announcement.

Day 2–4:

- respond to issues and comments;
- publish the technical article;
- verify directory listings and install commands;
- update FAQ from real problems.

Day 5–7:

- Show HN only if the project is easy to try and the maintainer can participate;
- summarize learnings rather than reposting the same announcement.

Product Hunt happens as a separate later campaign after Web Control Console v1.

## Measurement without invasive telemetry

Track public, aggregate evidence:

- public Release asset downloads;
- ClawHub version/install data when available;
- skills.sh installs;
- Glama listing/score and visits when available;
- Smithery bundle installs/calls when explicitly enabled;
- Homebrew install analytics when available and appropriate;
- GitHub stars, clones where visible, issues, discussions, and returning
  contributors;
- setup success/failure reports;
- number of real hosts and TraeCN versions proven;
- time from install to first successful task;
- top onboarding failure categories.

Do not add product telemetry merely to improve launch metrics. Prefer opt-in,
aggregate, and user-submitted evidence.

## Channel ledger

Maintain a table in the current project audit or a generated release record:

| Channel | Type | Version | Status | URL | Last verified | Install tested | Findings |
| --- | --- | --- | --- | --- | --- | --- | --- |

Allowed statuses:

```text
planned
preflight-failed
submitted
pending-review
listed
claimed
verified
superseded
rejected
paused
```

A channel is not `verified` until its public page and generated install path have
been inspected after publication.

## Best-practice completion criteria

The expanded distribution milestone is complete when:

1. Existing GitHub/ClawHub/Glama surfaces agree on version and local-first scope.
2. skills.sh, AwesomeSkills.dev, and MCP.Directory installs/listings are verified.
3. A clean MCPB bundle is built and installed; Smithery local publication is
   verified or precisely blocked.
4. A current public package and Official MCP Registry entry exist, or the package
   naming decision is explicitly deferred without misusing npm 0.3.1.
5. PulseMCP or another downstream registry reflects the official metadata.
6. Homebrew installation is available when selected and tested on a clean Mac.
7. Curated and secondary listings reuse canonical copy and correct install data.
8. The launch asset kit exists and at least one Chinese and one global channel
   have produced real feedback.
9. The channel ledger contains evidence and no duplicate stale listings.
10. No channel implies that a cloud container is the user's local TraeCN runtime.

## Primary references

- Official MCP Registry: https://modelcontextprotocol.io/registry/about
- Official Registry publishing: https://modelcontextprotocol.io/registry/quickstart
- MCPB: https://github.com/modelcontextprotocol/mcpb
- Smithery local/MCPB publishing: https://smithery.ai/docs/build/publish
- skills.sh: https://www.skills.sh/docs
- Homebrew taps: https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap
- Show HN: https://news.ycombinator.com/showhn.html
- Product Hunt launch guide: https://www.producthunt.com/launch
- TRAE Chinese community: https://forum.trae.cn/
