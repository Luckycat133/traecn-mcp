#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const TEMPLATE_PATH = path.join(
  REPO_ROOT,
  'distribution',
  'public-mirror',
  'server.json.template'
);

function renderRegistryMetadata({
  packageInfo = require('../package.json'),
  template = fs.readFileSync(TEMPLATE_PATH, 'utf8')
} = {}) {
  if (packageInfo.mcpName !== 'io.github.Luckycat133/traecnclaw') {
    throw new Error('package mcpName does not match the Official Registry identity');
  }
  if (!/^\d+\.\d+\.\d+$/.test(packageInfo.version || '')) {
    throw new Error('package version is not a release version');
  }

  const rendered = template.replaceAll('{{VERSION}}', packageInfo.version);
  if (rendered.includes('{{')) throw new Error('registry metadata still contains template markers');

  const metadata = JSON.parse(rendered);
  const npmPackage = metadata.packages?.find((entry) => entry.registryType === 'npm');
  if (metadata.name !== packageInfo.mcpName) throw new Error('server name does not match package mcpName');
  if (metadata.version !== packageInfo.version) throw new Error('server version does not match package version');
  if (npmPackage?.identifier !== '@luckycat133/traecnclaw') {
    throw new Error('registry metadata does not use the scoped public package');
  }
  if (npmPackage.version !== packageInfo.version) {
    throw new Error('registry package version does not match source version');
  }
  if (npmPackage.transport?.type !== 'stdio') throw new Error('registry transport must remain stdio');

  return `${JSON.stringify(metadata, null, 2)}\n`;
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] || null;
}

function main(argv = process.argv.slice(2)) {
  const outputPath = path.resolve(option(argv, '--out') || path.join(REPO_ROOT, 'dist', 'server.json'));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, renderRegistryMetadata(), 'utf8');
  console.log(`[render-registry-metadata] Wrote ${outputPath}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[render-registry-metadata] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  TEMPLATE_PATH,
  renderRegistryMetadata
};
