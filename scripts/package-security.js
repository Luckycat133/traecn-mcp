'use strict';

const fs = require('fs');
const path = require('path');

const SECRET_FILE_PATTERN = /(^|\/)\.env(?!\.example$)([^/]*$)/;
const SECRET_CONTENT_PATTERN = /\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|(?:api[-_]?key|token|password)\s*[:=]\s*["'][^"'\s]{16,}["'])/i;

function assertNoSecrets(stagingRoot) {
  const offenders = [];
  function visit(currentPath, relativePath = '') {
    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      const childRelative = path.join(relativePath, entry.name);
      const childPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        visit(childPath, childRelative);
        continue;
      }
      if (!entry.isFile()) continue;
      if (SECRET_FILE_PATTERN.test(childRelative)) {
        offenders.push(`${childRelative} (credential-looking filename)`);
        continue;
      }
      const stat = fs.statSync(childPath);
      if (stat.size > 4 * 1024 * 1024) continue;
      const content = fs.readFileSync(childPath, 'utf8');
      if (SECRET_CONTENT_PATTERN.test(content)) {
        offenders.push(`${childRelative} (credential-looking content)`);
      }
    }
  }
  visit(stagingRoot);
  if (offenders.length) {
    throw new Error(`Package staging contains credential-looking files:\n${offenders.join('\n')}`);
  }
}

module.exports = {
  SECRET_CONTENT_PATTERN,
  SECRET_FILE_PATTERN,
  assertNoSecrets
};
