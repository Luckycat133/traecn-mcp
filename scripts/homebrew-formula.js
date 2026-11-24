#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const TEMPLATE_PATH = path.join(REPO_ROOT, 'distribution', 'homebrew', 'traecnclaw.rb.template');

function renderFormula({ manifest, template = fs.readFileSync(TEMPLATE_PATH, 'utf8') }) {
  const version = String(manifest?.version || '');
  const serverPackage = manifest?.serverPackage;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('release manifest version is invalid');
  if (serverPackage?.name !== '@luckycat133/traecnclaw') {
    throw new Error('release manifest does not describe the scoped public package');
  }
  if (serverPackage.version !== version) throw new Error('server package version does not match release');
  if (serverPackage.artifact?.path !== `dist/traecnclaw-${version}.tgz`) {
    throw new Error('server package artifact path is not the stable release filename');
  }
  const digest = String(serverPackage.artifact.sha256 || '');
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('server package SHA-256 is invalid');
  return template.replaceAll('{{VERSION}}', version).replaceAll('{{SHA256}}', digest);
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] || null;
}

function main(argv = process.argv.slice(2)) {
  const manifestPath = path.resolve(option(argv, '--manifest') || path.join(REPO_ROOT, 'dist', 'traecn-mcp-release.json'));
  const outputPath = option(argv, '--out');
  if (!outputPath) throw new Error('Pass --out <Formula/traecnclaw.rb>');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const rendered = renderFormula({ manifest });
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outputPath), rendered, 'utf8');
  console.log(`[homebrew-formula] Wrote ${path.resolve(outputPath)}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[homebrew-formula] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { TEMPLATE_PATH, renderFormula };
