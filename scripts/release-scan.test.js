'use strict';

const assert = require('assert');
const { findViolations, scanPublicFiles } = require('./release-scan');

const unsafe = findViolations([
  { path: 'docs/a.md', content: 'workspace: /Users/alice/projects/demo' },
  { path: 'docs/b.md', content: 'drive: /Volumes/Private Data/demo' },
  { path: 'docs/c.md', content: 'TRAECN_MCP_TOOL_PROFILE=public' },
  { path: 'docs/d.md', content: 'npm install traecnclaw@0.3.1' }
]);
assert.deepStrictEqual(unsafe.map(item => item.rule), [
  'local-macos-user-path',
  'local-volume-path',
  'removed-mcp-profile-config',
  'stale-0.3-install'
]);

assert.deepStrictEqual(findViolations([
  {
    path: 'docs/safe.md',
    content: '<workspace>/TRAECNclaw and ~/Library/Application Support/TRAECNclaw\nHistorical traecnclaw@0.3.1 is not current.'
  }
]), []);

const actual = scanPublicFiles();
assert.deepStrictEqual(actual, [], actual.map(item => `${item.path}: ${item.rule}`).join('\n'));
console.log('[release-scan.test.js] PASS');
