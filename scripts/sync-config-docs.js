#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  renderEnvDefaultsBlock,
  renderReadmeDefaultsBlock,
  renderConfigurationDocument
} = require('../src/config/runtime-schema');

const repoRoot = path.resolve(__dirname, '..');

function replaceBlock(content, replacement, beginMarker, endMarker) {
  const start = content.indexOf(beginMarker);
  const end = content.indexOf(endMarker, start + beginMarker.length);
  if (start === -1 || end === -1) {
    throw new Error(`Generated block markers are missing: ${beginMarker}`);
  }
  return content.slice(0, start) + replacement + content.slice(end + endMarker.length);
}

function expectedFiles() {
  const envPath = path.join(repoRoot, '.env.example');
  const readmePath = path.join(repoRoot, 'README.md');
  const env = replaceBlock(
    fs.readFileSync(envPath, 'utf8'),
    renderEnvDefaultsBlock(),
    '# BEGIN GENERATED: core runtime defaults',
    '# END GENERATED: core runtime defaults'
  );
  const readme = replaceBlock(
    fs.readFileSync(readmePath, 'utf8'),
    renderReadmeDefaultsBlock(),
    '<!-- BEGIN GENERATED: runtime defaults -->',
    '<!-- END GENERATED: runtime defaults -->'
  );
  return new Map([
    [envPath, env],
    [readmePath, readme],
    [path.join(repoRoot, 'docs', 'configuration.md'), renderConfigurationDocument()]
  ]);
}

function main() {
  const check = process.argv.includes('--check');
  let stale = false;
  for (const [filePath, expected] of expectedFiles()) {
    const actual = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    if (actual === expected) continue;
    if (check) {
      stale = true;
      console.error(`[sync-config-docs] Stale: ${path.relative(repoRoot, filePath)}`);
    } else {
      fs.writeFileSync(filePath, expected, 'utf8');
      console.log(`[sync-config-docs] Wrote ${path.relative(repoRoot, filePath)}`);
    }
  }
  if (stale) process.exitCode = 1;
  if (check && !stale) console.log('[sync-config-docs] Generated configuration docs are current.');
}

if (require.main === module) main();

module.exports = { expectedFiles, replaceBlock };
