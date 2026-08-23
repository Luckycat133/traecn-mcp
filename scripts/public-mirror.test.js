'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const packageInfo = require('../package.json');
const {
  buildPublicMirror,
  compareTrees,
  verifyPublicMirror
} = require('./public-mirror');

const repoRoot = path.resolve(__dirname, '..');
const canonicalSkill = path.join(repoRoot, 'skills/traecnclaw-mcp');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'traecn-public-mirror-'));
const revision = '0123456789abcdef0123456789abcdef01234567';
const escapedVersion = packageInfo.version.replace(/\./g, '\\.');

try {
  buildPublicMirror({ mirrorRoot: tempRoot, sourceRevision: revision });
  assert.deepStrictEqual(verifyPublicMirror({ mirrorRoot: tempRoot, sourceRevision: revision }), []);
  assert.deepStrictEqual(
    compareTrees(canonicalSkill, path.join(tempRoot, '.codex/skills/traecnclaw-mcp')),
    []
  );

  assert.match(fs.readFileSync(path.join(tempRoot, 'SOURCE_REVISION'), 'utf8'), new RegExp(revision));

  const readme = fs.readFileSync(path.join(tempRoot, 'README.md'), 'utf8');
  assert.match(readme, /contract version 5/i);
  assert.match(readme, /exactly 20/i);
  assert.match(readme, /local-first/i);
  assert.doesNotMatch(readme, /TRAECN_MCP_TOOL_PROFILE/);
  assert.doesNotMatch(readme, /npm\s+(?:install|i)\b[^\n]*\btraecnclaw@0\.3/i);

  const license = fs.readFileSync(path.join(tempRoot, 'LICENSE'), 'utf8');
  assert.match(license, /^MIT License/);
  assert.match(license, /Copyright \(c\) 2026 Luckycat133/);

  const glama = JSON.parse(fs.readFileSync(path.join(tempRoot, 'glama.json'), 'utf8'));
  assert.deepStrictEqual(glama.maintainers, ['Luckycat133']);
  assert.strictEqual(glama.tools, 20);
  assert.deepStrictEqual(glama.transport, ['stdio']);
  assert.strictEqual(glama.docker.file, 'Dockerfile');

  const releaseManifest = JSON.parse(
    fs.readFileSync(path.join(tempRoot, 'release-manifest.json'), 'utf8')
  );
  assert.strictEqual(releaseManifest.marketplaces.npm.package, '@luckycat133/traecnclaw');
  assert.strictEqual(releaseManifest.marketplaces.smithery.mode, 'local-mcpb');
  assert.strictEqual(
    releaseManifest.marketplaces.officialMcpRegistry.name,
    'io.github.Luckycat133/traecnclaw'
  );
  assert.strictEqual(
    releaseManifest.marketplaces.homebrew.formula,
    'Luckycat133/tap/traecnclaw'
  );

  const dockerfilePath = path.join(tempRoot, 'Dockerfile');
  const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
  assert.match(dockerfile, new RegExp(`/v${escapedVersion}/traecnclaw-${escapedVersion}\\.tgz`));
  assert.match(dockerfile, /ENTRYPOINT \["traecnclaw-mcp"\]/);
  assert.match(dockerfile, /TRAECN_GATEWAY_HOST=127\.0\.0\.1/);
  assert.doesNotMatch(dockerfile, /0\.3\.0|TRAECN_MCP_TOOL_PROFILE|TRAECN_ENABLE_MOCK_BRIDGE/);

  assert.strictEqual(fs.existsSync(path.join(tempRoot, 'smithery.yaml')), false);
  assert.strictEqual(fs.existsSync(path.join(tempRoot, 'server.json')), false);
  assert.strictEqual(fs.existsSync(path.join(tempRoot, 'Dockerfile.glama')), false);

  fs.appendFileSync(path.join(tempRoot, 'LICENSE'), '\nchanged\n', 'utf8');
  assert.ok(
    verifyPublicMirror({ mirrorRoot: tempRoot, sourceRevision: revision })
      .some(item => item.rule === 'public-license-stale')
  );
  buildPublicMirror({ mirrorRoot: tempRoot, sourceRevision: revision });

  fs.writeFileSync(
    dockerfilePath,
    'FROM node:22\nARG RELEASE_TAG=v0.3.0-mcp-skill.1\nENV TRAECN_MCP_TOOL_PROFILE=public\n',
    'utf8'
  );
  assert.ok(
    verifyPublicMirror({ mirrorRoot: tempRoot, sourceRevision: revision })
      .some(item => item.rule === 'glama-dockerfile-stale')
  );

  buildPublicMirror({ mirrorRoot: tempRoot, sourceRevision: revision });
  fs.appendFileSync(
    path.join(tempRoot, '.codex/skills/traecnclaw-mcp/SKILL.md'),
    '\nmirror drift\n',
    'utf8'
  );
  assert.ok(
    verifyPublicMirror({ mirrorRoot: tempRoot, sourceRevision: revision })
      .some(item => item.rule === 'skill-byte-mismatch')
  );
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log('[public-mirror.test.js] PASS');
