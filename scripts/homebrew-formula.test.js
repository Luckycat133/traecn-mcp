'use strict';

const assert = require('assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { sha256File } = require('./build-npm-package');
const { stageCandidate } = require('./stage-homebrew-candidate');
const { renderFormula } = require('./homebrew-formula');

const digest = 'a'.repeat(64);
const manifest = {
  version: '1.2.3',
  serverPackage: {
    name: '@luckycat133/traecnclaw',
    version: '1.2.3',
    artifact: { path: 'dist/traecnclaw-1.2.3.tgz', sha256: digest }
  }
};

const formula = renderFormula({ manifest });
assert.match(formula, /github\.com\/Luckycat133\/traecn-mcp\/releases\/download\/v1\.2\.3\/traecnclaw-1\.2\.3\.tgz/);
assert.match(formula, new RegExp(`sha256 "${digest}"`));
assert.match(formula, /traecn-mcp doctor/);
assert.match(formula, /traecn-mcp quickstart --launch-trae/);
assert.match(formula, /traecn-mcp setup-mcp/);
assert.match(formula, /assert_equal 20, tools\.length/);
assert.match(formula, /formula_opt_bin\("node"\)/);
assert.match(formula, /depends_on "node"\n/);
assert.match(formula, /pipe_output\(bin\/"traecn-mcp"/);
assert.doesNotMatch(formula, /\[:build, :run\]/);
assert.doesNotMatch(formula, /Formula\["node"\]\.opt_bin/);
assert.doesNotMatch(formula, /\btraecn help\b|\btraecn quickstart\b/);
assert.throws(() => renderFormula({ manifest: { ...manifest, version: 'latest' } }), /version is invalid/);
assert.throws(() => renderFormula({
  manifest: { ...manifest, serverPackage: { ...manifest.serverPackage, name: 'traecnclaw' } }
}), /scoped public package/);

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'traecn homebrew test '));
try {
  const archive = path.join(fixture, 'traecnclaw-1.2.3.tgz');
  fs.writeFileSync(archive, 'synthetic staged artifact');
  const pinned = {
    ...manifest,
    serverPackage: {
      ...manifest.serverPackage,
      artifact: { ...manifest.serverPackage.artifact, sha256: sha256File(archive) }
    }
  };
  const canonical = renderFormula({ manifest: pinned });
  const local = stageCandidate(pinned, canonical, archive);
  assert.ok(local.includes(pathToFileURL(archive).href));
  assert.strictEqual(
    local.replace(pathToFileURL(archive).href,
      'https://github.com/Luckycat133/traecn-mcp/releases/download/v1.2.3/traecnclaw-1.2.3.tgz'),
    canonical
  );
  assert.throws(() => stageCandidate(pinned, canonical + '\n', archive), /formula differs/);
  fs.appendFileSync(archive, 'changed');
  assert.throws(() => stageCandidate(pinned, canonical, archive), /SHA-256 mismatch/);
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}

console.log('[homebrew-formula.test.js] PASS');
