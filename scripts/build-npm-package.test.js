'use strict';

const assert = require('assert');
const {
  PUBLIC_PACKAGE_NAME,
  PUBLIC_REPOSITORY,
  PUBLIC_SCRIPT_NAMES,
  publicPackageJson,
  publicReadme
} = require('./build-npm-package');

const source = require('../package.json');
const published = publicPackageJson(source);

assert.strictEqual(source.private, true, 'canonical source package must remain private');
assert.strictEqual(published.name, PUBLIC_PACKAGE_NAME);
assert.strictEqual(Object.hasOwn(published, 'private'), false);
assert.strictEqual(published.mcpName, 'io.github.Luckycat133/traecnclaw');
assert.deepStrictEqual(published.publishConfig, { access: 'public' });
assert.deepStrictEqual(published.os, ['darwin']);
assert.strictEqual(published.repository.url, `${PUBLIC_REPOSITORY}.git`);
assert.strictEqual(published.bugs.url, `${PUBLIC_REPOSITORY}/issues`);
assert.deepStrictEqual(published.bin, source.bin);
assert.deepStrictEqual(published.exports, source.exports);
assert.deepStrictEqual(Object.keys(published.scripts), PUBLIC_SCRIPT_NAMES);
assert.strictEqual(Object.hasOwn(published.scripts, 'test'), false);
assert.ok(published.files.includes('!docs/CHANNEL-LEDGER.md'));
assert.ok(published.files.includes('!docs/DISTRIBUTION.md'));
assert.ok(published.files.includes('!docs/LAUNCH-KIT.md'));

const readme = publicReadme({
  packageInfo: source,
  revision: 'a'.repeat(40)
});
assert.ok(readme.includes(`@luckycat133/traecnclaw@${source.version}`));
assert.ok(readme.includes(`Generated from canonical TRAECNclaw ${source.version}`));
assert.match(readme, new RegExp('`' + 'a'.repeat(40) + '`'));
assert.doesNotMatch(readme, /\{\{/);
assert.doesNotMatch(readme, /Luckycat133\/TRAECNclaw/);

console.log('[build-npm-package.test.js] PASS');
