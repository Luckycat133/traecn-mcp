#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const PUBLIC_EXTENSIONS = new Set(['.md', '.json', '.yaml', '.yml']);
const RULES = Object.freeze([
  { name: 'local-macos-user-path', pattern: /\/Users\/[A-Za-z0-9._-]+\// },
  { name: 'local-volume-path', pattern: /\/Volumes\// },
  { name: 'local-windows-user-path', pattern: /[A-Za-z]:\\Users\\[^\\\s]+\\/i },
  { name: 'local-linux-user-path', pattern: /\/home\/[A-Za-z0-9._-]+\// },
  { name: 'removed-mcp-profile-config', pattern: /TRAECN_MCP_TOOL_PROFILE\s*=/ },
  { name: 'stale-0.3-install', pattern: /traecnclaw@0\.3(?:\.\d+)?/i }
]);

function lineNumber(content, index) {
  return content.slice(0, index).split('\n').length;
}

function findViolations(files) {
  const violations = [];
  for (const file of files) {
    for (const rule of RULES) {
      const match = String(file.content || '').match(rule.pattern);
      if (!match) continue;
      violations.push({
        path: file.path,
        line: lineNumber(file.content, match.index),
        rule: rule.name,
        match: match[0]
      });
    }
  }
  return violations;
}

function collectFiles(rootPath, relativePath, files) {
  const absolutePath = path.join(rootPath, relativePath);
  if (!fs.existsSync(absolutePath)) return;
  const stat = fs.statSync(absolutePath);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(absolutePath).sort()) {
      collectFiles(rootPath, path.join(relativePath, entry), files);
    }
    return;
  }
  if (!PUBLIC_EXTENSIONS.has(path.extname(relativePath)) && path.basename(relativePath) !== '.env.example') {
    return;
  }
  files.push({
    path: relativePath.split(path.sep).join('/'),
    content: fs.readFileSync(absolutePath, 'utf8')
  });
}

function scanPublicFiles(rootPath = repoRoot) {
  const files = [];
  for (const relativePath of [
    'README.md',
    'CHANGELOG.md',
    '.env.example',
    'package.json',
    'docs',
    'distribution',
    'src/skill/README.md',
    'skills',
    'integrations/openclaw-traecn-plugin'
  ]) {
    collectFiles(rootPath, relativePath, files);
  }
  return findViolations(files);
}

function main() {
  const violations = scanPublicFiles();
  if (violations.length === 0) {
    console.log('[release-scan] Public release surfaces are clean.');
    return;
  }
  for (const violation of violations) {
    console.error(`${violation.path}:${violation.line} [${violation.rule}] ${violation.match}`);
  }
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  RULES,
  findViolations,
  scanPublicFiles
};
