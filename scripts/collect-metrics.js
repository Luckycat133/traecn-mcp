'use strict';

/**
 * Metrics snapshot for OPTIMIZATION-REPORT.md.
 *
 * Prints a machine-readable summary of:
 *   - top 10 largest source files (LOC)
 *   - total source LOC
 *   - total test LOC
 *   - test case count across all *.test.js
 *   - top 10 largest test files (LOC)
 *   - error-mapping test cases
 *
 * Run: `node scripts/collect-metrics.js`
 * Used by the post-team verification step.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function walk(dir, exts, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, exts, results);
    } else if (exts.some(ext => entry.name.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

function lineCount(file) {
  return fs.readFileSync(file, 'utf8').split('\n').length;
}

function countTestCases(file) {
  const text = fs.readFileSync(file, 'utf8');
  const matches = text.match(/^\s*(test|asyncTest)\s*\(\s*['"`]/gm);
  return matches ? matches.length : 0;
}

const sourceFiles = [
  ...walk(path.join(ROOT, 'src'), ['.js']).filter(f => !f.endsWith('.test.js')),
  ...walk(path.join(ROOT, 'scripts'), ['.js']).filter(f => !f.endsWith('.test.js')),
];
const testFiles = [
  ...walk(path.join(ROOT, 'src'), ['.test.js']),
  ...walk(path.join(ROOT, 'scripts'), ['.test.js']),
  ...walk(path.join(ROOT, 'mcp-server.test.js').replace(/[^/]+$/, ''), ['.test.js']),
];

const sourceByLoc = sourceFiles
  .map(f => ({ file: path.relative(ROOT, f), loc: lineCount(f) }))
  .sort((a, b) => b.loc - a.loc);

const testByLoc = testFiles
  .map(f => ({ file: path.relative(ROOT, f), loc: lineCount(f) }))
  .sort((a, b) => b.loc - a.loc);

const totalSourceLoc = sourceByLoc.reduce((s, f) => s + f.loc, 0);
const totalTestLoc = testByLoc.reduce((s, f) => s + f.loc, 0);
const totalTestCases = testFiles.reduce((s, f) => s + countTestCases(f), 0);

console.log('=== source LOC top 10 ===');
sourceByLoc.slice(0, 10).forEach(f => console.log(`${f.loc}\t${f.file}`));
console.log(`total_source_loc=${totalSourceLoc}`);
console.log();
console.log('=== test LOC top 10 ===');
testByLoc.slice(0, 10).forEach(f => console.log(`${f.loc}\t${f.file}`));
console.log(`total_test_loc=${totalTestLoc}`);
console.log(`total_test_files=${testFiles.length}`);
console.log(`total_test_cases=${totalTestCases}`);