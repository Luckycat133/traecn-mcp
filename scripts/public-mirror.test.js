'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const packageInfo = require('../package.json');
const {
  buildPublicMirror,
  compareTrees,
  synchronizeLocalSkill,
  verifyPublicMirror
} = require('./public-mirror');

const repoRoot = path.resolve(__dirname, '..');
const canonicalSkill = path.join(repoRoot, 'skills/traecn-mcp');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'traecn-public-mirror-'));
const revision = '0123456789abcdef0123456789abcdef01234567';
const escapedVersion = packageInfo.version.replace(/\./g, '\\.');

try {
  const localSkill = path.join(tempRoot, 'local-skill');
  assert.deepStrictEqual(synchronizeLocalSkill({ destinationRoot: localSkill, check: true })
    .filter(item => item.path === 'SKILL.md'), [{ path: 'SKILL.md', reason: 'missing' }]);
  assert.strictEqual(fs.existsSync(localSkill), false);
  assert.deepStrictEqual(synchronizeLocalSkill({ destinationRoot: localSkill }), []);
  assert.deepStrictEqual(compareTrees(canonicalSkill, localSkill), []);
  assert.strictEqual(
    fs.statSync(path.join(localSkill, 'scripts/start-mcp.js')).mode & 0o777,
    fs.statSync(path.join(canonicalSkill, 'scripts/start-mcp.js')).mode & 0o777
  );
  assert.strictEqual(fs.existsSync(path.join(localSkill, 'agents/openai.yaml')), true);

  fs.appendFileSync(path.join(localSkill, 'SKILL.md'), '\nlocal drift\n');
  fs.unlinkSync(path.join(localSkill, 'references/mcp-tool-contracts.json'));
  fs.writeFileSync(path.join(localSkill, 'obsolete.md'), 'stale resource\n');
  const drift = synchronizeLocalSkill({ destinationRoot: localSkill, check: true });
  assert.deepStrictEqual(drift, [
    { path: 'SKILL.md', reason: 'bytes-differ' },
    { path: 'obsolete.md', reason: 'unexpected' },
    { path: 'references/mcp-tool-contracts.json', reason: 'missing' }
  ]);
  assert.match(fs.readFileSync(path.join(localSkill, 'SKILL.md'), 'utf8'), /local drift/);
  assert.deepStrictEqual(synchronizeLocalSkill({ destinationRoot: localSkill }), []);
  assert.deepStrictEqual(synchronizeLocalSkill({ destinationRoot: localSkill, check: true }), []);
  assert.strictEqual(fs.existsSync(path.join(localSkill, 'obsolete.md')), false);
  for (const destinationRoot of [canonicalSkill, path.dirname(canonicalSkill), path.join(canonicalSkill, 'nested')]) {
    assert.throws(() => synchronizeLocalSkill({ destinationRoot }), /separate trees/);
  }
  assert.throws(() => synchronizeLocalSkill({ sourceRoot: path.join(tempRoot, 'absent'), destinationRoot: localSkill }), /missing SKILL.md/);
  assert.deepStrictEqual(compareTrees(canonicalSkill, localSkill), []);

  const formerSkill = path.join(tempRoot, '.codex/skills/traecnclaw-mcp');
  fs.mkdirSync(formerSkill, { recursive: true });
  fs.writeFileSync(path.join(formerSkill, 'SKILL.md'), '# Previous generated Skill\n');
  buildPublicMirror({ mirrorRoot: tempRoot, sourceRevision: revision });
  assert.strictEqual(fs.existsSync(formerSkill), false);
  assert.deepStrictEqual(verifyPublicMirror({ mirrorRoot: tempRoot, sourceRevision: revision }), []);
  assert.deepStrictEqual(
    compareTrees(canonicalSkill, path.join(tempRoot, '.codex/skills/traecn-mcp')),
    []
  );

  assert.match(fs.readFileSync(path.join(tempRoot, 'SOURCE_REVISION'), 'utf8'), new RegExp(revision));

  const readme = fs.readFileSync(path.join(tempRoot, 'README.md'), 'utf8');
  assert.match(readme, /^# TraeCN MCP\n/);
  assert.match(readme, /contract version 5/i);
  assert.match(readme, /exactly 20/i);
  assert.match(readme, /local-first/i);
  assert.doesNotMatch(readme, /TRAECN_MCP_TOOL_PROFILE/);
  assert.doesNotMatch(readme, /npm\s+(?:install|i)\b[^\n]*\btraecnclaw@0\.3/i);

  const license = fs.readFileSync(path.join(tempRoot, 'LICENSE'), 'utf8');
  assert.match(license, /^MIT License/);
  assert.match(license, /Copyright \(c\) 2026 Luckycat133/);

  const glama = JSON.parse(fs.readFileSync(path.join(tempRoot, 'glama.json'), 'utf8'));
  assert.strictEqual(glama.name, 'TraeCN MCP');
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
    'Luckycat133/traecn-mcp/traecnclaw'
  );

  const dockerfilePath = path.join(tempRoot, 'Dockerfile');
  const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
  assert.match(dockerfile, new RegExp(`github\\.com/Luckycat133/traecn-mcp/releases/download/v${escapedVersion}/traecnclaw-${escapedVersion}\\.tgz`));
  assert.ok(dockerfile.includes('ENTRYPOINT ["node", "/usr/local/lib/node_modules/@luckycat133/traecnclaw/mcp-server.js"]'));
  assert.match(dockerfile, /TRAECN_GATEWAY_HOST=127\.0\.0\.1/);
  assert.match(dockerfile, /npm install -g --ignore-scripts --force \/tmp\/traecnclaw\.tgz/);
  assert.match(dockerfile, /without changing the package metadata or claiming Linux support/);
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
    path.join(tempRoot, '.codex/skills/traecn-mcp/SKILL.md'),
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
