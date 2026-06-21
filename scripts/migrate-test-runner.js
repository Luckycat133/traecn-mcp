#!/usr/bin/env node
'use strict';

/**
 * One-shot migration helper: rewrite the inline test-runner template in
 * legacy *.test.js files to use src/shared/test-runner#createRunner.
 *
 * Handles the three most common shapes used in this repo:
 *
 *   Shape A — sync-only:
 *     let passed = 0;
 *     let failed = 0;
 *     function test(name, fn) { ... passed++ ... }
 *
 *   Shape B — sync-only with combined declaration:
 *     let passed = 0, failed = 0;
 *     function test(name, fn) { ... }
 *
 *   Shape C — sync + promise-returning (counts promise as passed eagerly,
 *     increments failed on later rejection):
 *     let passed = 0, failed = 0;
 *     function test(name, fn) {
 *       try {
 *         const r = fn();
 *         if (r && typeof r.then === 'function') { r.then(...); return; }
 *         passed++; ...
 *       } catch (err) { ... }
 *     }
 *
 * Does NOT touch files that already use createRunner. Idempotent.
 *
 * Usage: node scripts/migrate-test-runner.js [files...]
 *        (no args = all *.test.js under src/ and scripts/)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function walk(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, results);
    else if (entry.name.endsWith('.test.js')) results.push(full);
  }
  return results;
}

function findSuiteName(text) {
  // Match `[foo.test.js]` in either the "Running tests" or "Results" line.
  const m = text.match(/\[([\w.-]+\.test\.js)\]\s*Running tests/);
  if (m) return m[1];
  const m2 = text.match(/\[([\w.-]+\.test\.js)\]\s*Results:/);
  if (m2) return m2[1];
  return null;
}

function stripCountersAndTest(text) {
  // Remove the counter declarations and the test() function body. The two
  // common shapes:
  //   "let passed = 0;\nlet failed = 0;\n\nfunction test(name, fn) { ... }"
  //   "let passed = 0, failed = 0;\n\nfunction test(name, fn) { ... }"
  //
  // We delete the entire block from the first `let passed =` (or similar)
  // up to and including the closing `}` of the test() function. We detect
  // the end by counting braces from `function test(`.

  const startRe = /let passed = 0[,;\s]*\n?\s*let failed = 0[;\s]*|let passed = 0,\s*failed = 0[;\s]*/;
  const startMatch = text.match(startRe);
  if (!startMatch) return null;
  const startIdx = startMatch.index;

  // Find the function test( ... ) block. We look for `function test(` after
  // startIdx, then count braces from there.
  const fnIdx = text.indexOf('function test(', startIdx);
  if (fnIdx === -1) return null;

  // Walk from fnIdx, skipping past `(name, fn)` signature, then count braces.
  let i = fnIdx;
  // Find opening brace of the function body.
  while (i < text.length && text[i] !== '{') i++;
  if (i >= text.length) return null;
  let depth = 0;
  let end = -1;
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) return null;

  return text.slice(0, startIdx) + text.slice(end);
}

function stripRunningLog(text) {
  return text.replace(/console\.log\(`\\n\[[\w.-]+\.test\.js\] Running tests\.\.\.\\n`\);\s*\n?/, '');
}

function stripResultsLogAndExit(text) {
  text = text.replace(/console\.log\(`\\n\[[\w.-]+\.test\.js\] Results: \$\{passed\} passed, \$\{failed\} failed\\n`\);\s*\n?/, '');
  text = text.replace(/\n\s*process\.exit\(failed > 0 \? 1 : 0\);\s*\n?/, '\n');
  // `setTimeout(() => { ... Results: ${passed}/${failed} ... [process.exit(...)] }, N);`
  // — both variants with and without the trailing process.exit line.
  text = text.replace(
    /\s*setTimeout\(\(\) => \{\s*\n\s*console\.log\(`\\n\s+Results: \$\{passed\} passed, \$\{failed\} failed\\n`\);\s*\n(?:\s*process\.exit\(failed > 0 \? 1 : 0\);\s*\n)?\s*\}, \d+\);\s*\n?/,
    '\n'
  );
  // `Promise.all(asyncTests).then(() => { console.log(...Results...) })`
  text = text.replace(
    /\s*Promise\.all\(asyncTests\)\.then\(\(\) => \{\s*\n\s*console\.log\(`\\n\s+Results: \$\{passed\} passed, \$\{failed\} failed\\n`\);\s*\n\s*\}\);?\s*\n?/,
    '\n'
  );
  // Orphan `asyncTests` array declaration that referenced the old manual
  // queue (e.g. `const asyncTests = [];` at the top of some files). Strip
  // it because we now use the runner's internal queue.
  text = text.replace(/^const asyncTests = \[\];\s*\n/m, '');
  return text;
}

function relativeRequire(file) {
  // file is a relative path from ROOT. We need the require path that, when
  // evaluated from `file`'s directory, lands at shared/test-runner.js.
  //
  // Examples (with ROOT containing src/ and scripts/):
  //   src/cdp/foo.test.js              -> ../shared/test-runner
  //   src/shared/sub/foo.test.js       -> ../shared/test-runner
  //   scripts/foo.test.js              -> ../src/shared/test-runner
  //
  // Implementation: walk from file's directory to src/shared/, then append
  // /test-runner. Using path.posix for stable separators on Windows.
  const dir = path.dirname(file);
  const fromSrc = path.posix.relative(dir, 'src/shared');
  const posixPath = fromSrc.split(path.sep).join('/');
  return `${posixPath}/test-runner`;
}

function injectRunner(text, file, suiteName) {
  const requirePath = relativeRequire(path.relative(ROOT, file));
  // Insert the runner block AFTER the last top-level require/const line,
  // but BEFORE any function/class/IIFE/IIFE-arrow declaration. The mock
  // helpers and other module-scope declarations can stay; the runner must
  // sit at the top level so test/asyncTest are visible to the test bodies.
  const lines = text.split('\n');
  let insertAt = 0;
  let lastTopLevel = 0;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i];
    const trimmed = t.trim();
    // Track brace depth to know when we're inside a function body.
    for (const ch of t) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (depth > 0) continue;
    if (trimmed === '' || trimmed.startsWith("'use strict'") || trimmed.startsWith('"use strict"') || trimmed.startsWith('//')) {
      lastTopLevel = i + 1;
      continue;
    }
    if (
      trimmed.startsWith('require(') ||
      trimmed.startsWith('const ') ||
      trimmed.startsWith('let ') ||
      trimmed.startsWith('var ') ||
      trimmed.startsWith('module.exports')
    ) {
      lastTopLevel = i + 1;
      continue;
    }
    // Stop at first non-top-level line.
    break;
  }
  insertAt = lastTopLevel;

  const block = [
    '',
    `const { createRunner } = require('${requirePath}');`,
    `const runner = createRunner('${suiteName}');`,
    `const { test, asyncTest, pendingAsyncTests, summary } = runner;`,
  ];
  lines.splice(insertAt, 0, ...block);
  text = lines.join('\n');

  // Append the summary at the end of the file.
  text = text.replace(/\s*$/, '');
  text += '\n\nsummary();\nif (runner.failed > 0) process.exit(1);\n';
  return text;
}

const targets = process.argv.slice(2).length
  ? process.argv.slice(2).map(p => path.resolve(p))
  : [
      ...walk(path.join(ROOT, 'src')),
      ...walk(path.join(ROOT, 'scripts')),
    ];

let migrated = 0;
let skipped = 0;

for (const file of targets) {
  const rel = path.relative(ROOT, file);
  let text = fs.readFileSync(file, 'utf8');

  if (text.includes('createRunner')) {
    skipped++;
    continue;
  }

  const suiteName = findSuiteName(text);
  if (!suiteName) {
    skipped++;
    console.log(`SKIP (no suite name): ${rel}`);
    continue;
  }

  // Skip files that have dual-counter (`asyncPassed` / `asyncFailed`)
  // or use `asyncTest` directly — those need a careful hand migration.
  if (/\basyncPassed\b|\basyncFailed\b/.test(text) || /\basyncTest\s*\(/.test(text)) {
    skipped++;
    console.log(`SKIP (async pattern, hand-migrate): ${rel}`);
    continue;
  }

  text = stripCountersAndTest(text);
  if (text === null) {
    skipped++;
    console.log(`SKIP (no counter block): ${rel}`);
    continue;
  }
  text = stripRunningLog(text);
  text = stripResultsLogAndExit(text);
  text = injectRunner(text, file, suiteName);

  fs.writeFileSync(file, text);
  migrated++;
  console.log(`MIGRATED: ${rel}`);
}

console.log(`\n${migrated} migrated, ${skipped} skipped`);