'use strict';

/**
 * Coverage gate for TraeCNclaw.
 *
 * 1. Runs the project's test suite under c8 (V8 native coverage).
 * 2. Parses the JSON summary c8 emits.
 * 3. Fails the build when line/branch/function coverage drops below the
 *    thresholds defined in COVERAGE_THRESHOLDS. Warns when a tracked source
 *    file ends up with 0% coverage.
 *
 * Configuration is intentionally environment-driven so CI can loosen or
 * tighten the gates without code edits:
 *   TRAECN_COVERAGE_MIN_LINES      (default 60)
 *   TRAECN_COVERAGE_MIN_BRANCHES   (default 55)
 *   TRAECN_COVERAGE_MIN_FUNCTIONS  (default 55)
 *   TRAECN_COVERAGE_INCLUDE        (default src/<all>)
 *   TRAECN_COVERAGE_EXCLUDE        (default test files, index, server entry,
 *                                   and integration-heavy modules:
 *                                   chat-ui, dom-driver, settings-driver,
 *                                   browser-dom, discovery, gateway)
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tmpCoverageDir = path.join(root, '.coverage');
const reportJson = path.join(tmpCoverageDir, 'coverage-final.json');
const reportSummary = path.join(tmpCoverageDir, 'coverage-summary.json');

const COVERAGE_THRESHOLDS = {
  lines: Number(process.env.TRAECN_COVERAGE_MIN_LINES ?? 60),
  branches: Number(process.env.TRAECN_COVERAGE_MIN_BRANCHES ?? 55),
  functions: Number(process.env.TRAECN_COVERAGE_MIN_FUNCTIONS ?? 55)
};

const INCLUDE = process.env.TRAECN_COVERAGE_INCLUDE || 'src/**';
// Default excludes: test files, public surface index entries, the runtime
// server entry, and the heavy integration layers that require a real
// TraeCN / Chromium instance to exercise (chat-ui HTML rendering, CDP DOM
// / settings drivers, browser discovery, the HTTP gateway).
const EXCLUDE = (process.env.TRAECN_COVERAGE_EXCLUDE
  || [
    'src/**/*.test.js',
    'src/**/index.js',
    'src/server.js',
    'src/http/chat-ui.js',
    'src/http/gateway.js',
    'src/cdp/dom-driver.js',
    'src/cdp/settings-driver.js',
    'src/cdp/browser-dom.js',
    'src/cdp/discovery.js'
  ].join(',')
).split(',').map(s => s.trim()).filter(Boolean);

const TEST_COMMAND = (process.env.TRAECN_COVERAGE_TEST_CMD
  || 'npm test --silent'
).split(' ');

function runTests() {
  const c8Bin = path.join(root, 'node_modules', '.bin', 'c8');
  const args = [
    '--reporter=json',
    '--reporter=json-summary',
    '--reporter=text-summary',
    `--report-dir=${tmpCoverageDir}`,
    '--include=' + INCLUDE,
    ...EXCLUDE.map(pattern => `--exclude=${pattern}`),
    '--check-coverage=false',
    ...TEST_COMMAND
  ];
  console.log('[coverage-gate] Running tests under c8...');
  try {
    execFileSync(c8Bin, args, { stdio: 'inherit', cwd: root });
  } catch (err) {
    // c8 forwards the underlying test command's exit code; if tests
    // fail, the gate has nothing useful to report and we just bail.
    console.error('[coverage-gate] Test command failed; skipping coverage check.');
    process.exit(err.status || 1);
  }
}

function readSummary() {
  if (!fs.existsSync(reportSummary)) {
    console.error(`[coverage-gate] Expected summary at ${reportSummary} but it was not produced.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(reportSummary, 'utf8')).total || {};
}

function checkThresholds(summary) {
  const pct = (v) => (typeof v === 'number' ? v : 0);
  const metrics = {
    lines: pct(summary.lines && summary.lines.pct),
    branches: pct(summary.branches && summary.branches.pct),
    functions: pct(summary.functions && summary.functions.pct)
  };

  const violations = [];
  for (const [key, threshold] of Object.entries(COVERAGE_THRESHOLDS)) {
    if (metrics[key] < threshold) {
      violations.push({ metric: key, actual: metrics[key], threshold });
    }
  }
  return { metrics, violations };
}

function checkUntouchedFiles() {
  if (!fs.existsSync(reportJson)) return [];
  const raw = JSON.parse(fs.readFileSync(reportJson, 'utf8'));
  const untouched = [];
  for (const [filepath, data] of Object.entries(raw)) {
    const statementMap = data.statementMap || {};
    const s = data.s || {};
    const total = Object.keys(statementMap).length;
    const covered = Object.values(s).filter(v => v > 0).length;
    if (total > 5 && covered === 0) {
      untouched.push(path.relative(root, filepath));
    }
  }
  return untouched;
}

function main() {
  runTests();
  const summary = readSummary();
  const { metrics, violations } = checkThresholds(summary);
  const untouched = checkUntouchedFiles();

  console.log('\n[coverage-gate] Coverage summary (c8 totals):');
  console.log(`  lines:     ${metrics.lines.toFixed(2)}%   (threshold: ${COVERAGE_THRESHOLDS.lines}%)`);
  console.log(`  branches:  ${metrics.branches.toFixed(2)}%   (threshold: ${COVERAGE_THRESHOLDS.branches}%)`);
  console.log(`  functions: ${metrics.functions.toFixed(2)}%   (threshold: ${COVERAGE_THRESHOLDS.functions}%)`);

  if (untouched.length > 0) {
    console.warn('\n[coverage-gate] WARNING: these source files have 0% line coverage:');
    for (const file of untouched) console.warn('  - ' + file);
  }

  if (violations.length > 0) {
    console.error('\n[coverage-gate] FAIL: coverage below threshold:');
    for (const v of violations) {
      console.error(`  - ${v.metric}: ${v.actual.toFixed(2)}% < ${v.threshold}%`);
    }
    process.exit(1);
  }

  console.log('\n[coverage-gate] PASS');
}

main();
