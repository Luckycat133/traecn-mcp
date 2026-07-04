#!/usr/bin/env node
'use strict';

/**
 * Migrate Promise.all(asyncTests)-style test files to use
 * src/shared/test-runner#createRunner.
 *
 * Pattern replaced:
 *
 *     let passed = 0, failed = 0;
 *     const asyncTests = [];
 *     function test(name, fn) { ... asyncTests.push(...) ... }
 *     // ... test cases ...
 *     Promise.all(asyncTests).then(() => {
 *       console.log(\`\n  Results: ${passed} passed, ${failed} failed\n\`);
 *       process.exit(failed > 0 ? 1 : 0);
 *     });
 *
 * Replaced with:
 *
 *     const { createRunner } = require('<rel>/shared/test-runner');
 *     const runner = createRunner('<file>.test.js');
 *     const { test, asyncTest, pendingAsyncTests, summary } = runner;
 *     // ... test cases ...
 *     Promise.resolve().then(async () => {
 *       await pendingAsyncTests();
 *       summary();
 *       if (runner.failed > 0) process.exit(1);
 *     });
 *
 * Usage: node scripts/migrate-async-tests.js <file> [file...]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function relativeRequire(file) {
  const dir = path.dirname(file);
  const fromSrc = path.posix.relative(dir, 'src/shared');
  const posixPath = fromSrc.split(path.sep).join('/');
  return `${posixPath}/test-runner`;
}

function findSuiteName(text) {
  // The Promise.all(asyncTests) variant typically puts the suite name in
  // the path of the file itself (not in a [name] bracket). Derive from
  // the filename.
  const filenameMatch = text.match(/Promise\.all\(asyncTests\)\.then/);
  if (!filenameMatch) return null;
  // Try to find a console.log block that mentions the suite.
  const logMatch = text.match(/console\.log\(`\\n\s+Results: /);
  if (!logMatch) return null;
  // Walk forward to find a hint; otherwise we fall back to the basename.
  const before = text.slice(0, logMatch.index);
  const suiteHint = before.match(/([\w.-]+\.test\.js)/g);
  if (suiteHint && suiteHint.length) return suiteHint[suiteHint.length - 1];
  return null;
}

function stripTemplateAndInject(text, file, suiteName) {
  // Step 1: strip the trailing Promise.all(asyncTests) block first. This
  // works because it's the LAST block in the file.
  const promiseAllRe = /Promise\.all\(asyncTests\)\.then\(\(\) => \{\s*\n\s*console\.log\(`\\n\s+Results: \$\{passed\} passed, \$\{failed\} failed\\n`\);\s*\n\s*process\.exit\(failed > 0 \? 1 : 0\);\s*\n\s*\}\);\s*\n?/;
  text = text.replace(promiseAllRe, '');

  // Step 2: remove the inline counter + test() function definition.
  // The block to remove starts at `let passed = 0` and ends at the closing
  // `}` of `function test(name, fn) { ... }`. We use brace counting.
  const lines = text.split('\n');
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^let passed = 0/.test(lines[i].trim())) { startIdx = i; break; }
  }
  if (startIdx === -1) return null;

  let i = startIdx;
  while (i < lines.length && !/^function test\(/.test(lines[i].trim())) i++;
  if (i >= lines.length) return null;
  while (i < lines.length && !lines[i].includes('{')) i++;
  if (i >= lines.length) return null;
  let depth = 0;
  let end = -1;
  for (; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end !== -1) break;
  }
  if (end === -1) return null;

  // Also strip `const asyncTests = [];` if present after the test block.
  let extraStripEnd = end + 1;
  while (extraStripEnd < lines.length && lines[extraStripEnd].trim() === '') extraStripEnd++;
  if (extraStripEnd < lines.length && /^const asyncTests = \[\];/.test(lines[extraStripEnd].trim())) {
    extraStripEnd++;
    while (extraStripEnd < lines.length && lines[extraStripEnd].trim() === '') extraStripEnd++;
  }

  // Step 3: insert the runner setup after the last require, before the
  // function/block declarations we stripped out.
  const requirePath = relativeRequire(path.relative(ROOT, file));
  const runnerSetup = [
    `const { createRunner } = require('${requirePath}');`,
    `const runner = createRunner('${suiteName}');`,
    `const { test, asyncTest, pendingAsyncTests, summary } = runner;`,
  ].join('\n');

  let newText = lines.slice(0, startIdx).join('\n');
  newText += '\n' + runnerSetup + '\n';
  newText += lines.slice(extraStripEnd).join('\n');

  // Step 4: append the drain block at the end.
  newText = newText.replace(/\s*$/, '');
  newText += `\n\nPromise.resolve().then(async () => {\n  await pendingAsyncTests();\n  summary();\n  if (runner.failed > 0) process.exit(1);\n});\n`;

  return newText;
}

const targets = process.argv.slice(2);
if (!targets.length) {
  console.error('usage: node scripts/migrate-async-tests.js <file> [...]');
  process.exit(1);
}

for (const file of targets) {
  const absFile = path.resolve(file);
  const rel = path.relative(ROOT, absFile);
  const text = fs.readFileSync(absFile, 'utf8');

  if (text.includes('createRunner')) {
    console.log(`SKIP (already migrated): ${rel}`);
    continue;
  }
  if (!text.includes('Promise.all(asyncTests)')) {
    console.log(`SKIP (no Promise.all(asyncTests) pattern): ${rel}`);
    continue;
  }

  const suiteName = findSuiteName(text);
  if (!suiteName) {
    console.log(`SKIP (no suite name): ${rel}`);
    continue;
  }

  const newText = stripTemplateAndInject(text, absFile, suiteName);
  if (!newText) {
    console.log(`SKIP (template not found): ${rel}`);
    continue;
  }

  fs.writeFileSync(absFile, newText);
  console.log(`MIGRATED: ${rel}`);
}