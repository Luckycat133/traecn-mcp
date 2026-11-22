#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { renderFormula } = require('./homebrew-formula');
const { sha256File } = require('./build-npm-package');

function stageCandidate(manifest, canonical, archivePath) {
  const rendered = renderFormula({ manifest });
  if (canonical !== rendered) throw new Error('Canonical formula differs from verified manifest');
  const archive = manifest.serverPackage.artifact;
  if (sha256File(archivePath) !== archive.sha256) throw new Error('Candidate archive SHA-256 mismatch');
  const expected = `https://github.com/Luckycat133/traecn-mcp/releases/download/v${manifest.version}/traecnclaw-${manifest.version}.tgz`;
  const url = `  url "${expected}"`;
  if (!canonical.includes(url)) throw new Error('Missing canonical release URL');
  return canonical.replace(url, `  url "${pathToFileURL(archivePath).href}"`);
}

if (require.main === module) {
  const [formula, output] = process.argv.slice(2);
  if (!formula || !output) throw new Error('Pass canonical and local-formula paths');
  const manifest = require('../dist/traecn-mcp-release.json');
  const archivePath = path.resolve(__dirname, '..', manifest.serverPackage.artifact.path);
  const staged = stageCandidate(manifest, fs.readFileSync(formula, 'utf8'), archivePath);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, staged, { flag: 'wx' });
}

module.exports = { stageCandidate };
