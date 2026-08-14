'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildPublicMirror,
  compareTrees,
  verifyPublicMirror
} = require('./public-mirror');

const repoRoot = path.resolve(__dirname, '..');
const canonicalSkill = path.join(repoRoot, 'skills/traecnclaw-mcp');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'traecn-public-mirror-'));
const revision = '0123456789abcdef0123456789abcdef01234567';

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
  assert.doesNotMatch(readme, /TRAECN_MCP_TOOL_PROFILE/);
  assert.strictEqual(fs.existsSync(path.join(tempRoot, 'smithery.yaml')), false);

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
