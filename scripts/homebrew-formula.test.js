'use strict';

const assert = require('assert');
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
assert.match(formula, /releases\/download\/v1\.2\.3\/traecnclaw-1\.2\.3\.tgz/);
assert.match(formula, new RegExp(`sha256 "${digest}"`));
assert.match(formula, /traecnclaw doctor/);
assert.match(formula, /traecnclaw service start/);
assert.match(formula, /traecnclaw setup-mcp/);
assert.match(formula, /assert_equal 20, tools\.length/);
assert.match(formula, /formula_opt_bin\("node"\)/);
assert.match(formula, /depends_on "node"\n/);
assert.match(formula, /pipe_output\(bin\/"traecnclaw-mcp"/);
assert.doesNotMatch(formula, /\[:build, :run\]/);
assert.doesNotMatch(formula, /Formula\["node"\]\.opt_bin/);
assert.doesNotMatch(formula, /\btraecn help\b|\btraecn quickstart\b/);
assert.throws(() => renderFormula({ manifest: { ...manifest, version: 'latest' } }), /version is invalid/);
assert.throws(() => renderFormula({
  manifest: { ...manifest, serverPackage: { ...manifest.serverPackage, name: 'traecnclaw' } }
}), /scoped public package/);

console.log('[homebrew-formula.test.js] PASS');
