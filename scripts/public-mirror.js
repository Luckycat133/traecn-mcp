#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const packageInfo = require('../package.json');
const { MCP_CONTRACT_VERSION, MCP_TOOL_NAMES } = require('../src/mcp/contract');

const repoRoot = path.resolve(__dirname, '..');
const canonicalSkillRoot = path.join(repoRoot, 'skills/traecnclaw-mcp');
const distributionRoot = path.join(repoRoot, 'distribution/public-mirror');
const mirrorSkillPath = '.codex/skills/traecnclaw-mcp';
const obsoleteRootFiles = ['smithery.yaml', 'server.json', 'Dockerfile.glama'];

function listTree(rootPath) {
  const files = [];
  function visit(currentPath, relativePath = '') {
    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRelative = path.join(relativePath, entry.name);
      const childPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) visit(childPath, childRelative);
      else if (entry.isFile()) files.push(childRelative.split(path.sep).join('/'));
    }
  }
  if (fs.existsSync(rootPath)) visit(rootPath);
  return files;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function compareTrees(expectedRoot, actualRoot) {
  const expectedFiles = listTree(expectedRoot);
  const actualFiles = listTree(actualRoot);
  const allFiles = Array.from(new Set([...expectedFiles, ...actualFiles])).sort();
  const differences = [];
  for (const relativePath of allFiles) {
    const expectedPath = path.join(expectedRoot, relativePath);
    const actualPath = path.join(actualRoot, relativePath);
    if (!fs.existsSync(expectedPath)) {
      differences.push({ path: relativePath, reason: 'unexpected' });
    } else if (!fs.existsSync(actualPath)) {
      differences.push({ path: relativePath, reason: 'missing' });
    } else if (sha256(expectedPath) !== sha256(actualPath)) {
      differences.push({ path: relativePath, reason: 'bytes-differ' });
    }
  }
  return differences;
}

function copyTree(sourceRoot, destinationRoot) {
  fs.rmSync(destinationRoot, { recursive: true, force: true });
  for (const relativePath of listTree(sourceRoot)) {
    const sourcePath = path.join(sourceRoot, relativePath);
    const destinationPath = path.join(destinationRoot, relativePath);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
    fs.chmodSync(destinationPath, fs.statSync(sourcePath).mode & 0o777);
  }
}

function assertRevision(sourceRevision) {
  if (!/^[a-f0-9]{40}$/i.test(String(sourceRevision || ''))) {
    throw new Error('Public mirror source revision must be a full 40-character Git commit');
  }
}

function sourceRevisionDocument(sourceRevision) {
  return [
    'Canonical repository: https://github.com/Luckycat133/TRAECNclaw',
    `Canonical commit: ${sourceRevision}`,
    `Canonical release: v${packageInfo.version}`,
    'Canonical path: skills/traecnclaw-mcp',
    'Generated mirror: do not edit the mirrored Skill by hand.',
    ''
  ].join('\n');
}

function renderReadme(sourceRevision) {
  return fs.readFileSync(path.join(distributionRoot, 'README.md.template'), 'utf8')
    .replaceAll('{{VERSION}}', packageInfo.version)
    .replaceAll('{{SOURCE_REVISION}}', sourceRevision);
}

function renderGlamaDockerfile() {
  return fs.readFileSync(path.join(distributionRoot, 'Dockerfile.glama.template'), 'utf8')
    .replaceAll('{{VERSION}}', packageInfo.version);
}

function releaseManifest(sourceRevision) {
  return {
    name: 'traecnclaw-mcp-skill',
    version: packageInfo.version,
    contractVersion: MCP_CONTRACT_VERSION,
    toolCount: MCP_TOOL_NAMES.length,
    repository: 'https://github.com/Luckycat133/traecnclaw-mcp-skill',
    canonicalRepository: 'https://github.com/Luckycat133/TRAECNclaw',
    sourceRevision,
    skillPath: mirrorSkillPath,
    marketplaces: {
      glama: {
        status: 'listing-ready',
        file: 'glama.json',
        dockerfile: 'Dockerfile',
        runtime: 'local-gateway-required',
        hostedConnector: false
      },
      smithery: { status: 'requires-mcpb-publication', legacySmitheryYaml: false },
      officialMcpRegistry: {
        status: 'requires-public-package-publication',
        schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json'
      },
      npm: { status: 'not-asserted-until-published' }
    }
  };
}

function buildPublicMirror({ mirrorRoot, sourceRevision }) {
  assertRevision(sourceRevision);
  fs.mkdirSync(mirrorRoot, { recursive: true });
  copyTree(canonicalSkillRoot, path.join(mirrorRoot, mirrorSkillPath));
  fs.writeFileSync(path.join(mirrorRoot, 'SOURCE_REVISION'), sourceRevisionDocument(sourceRevision), 'utf8');
  fs.writeFileSync(path.join(mirrorRoot, 'README.md'), renderReadme(sourceRevision), 'utf8');
  fs.copyFileSync(path.join(distributionRoot, 'glama.json'), path.join(mirrorRoot, 'glama.json'));
  fs.writeFileSync(path.join(mirrorRoot, 'Dockerfile'), renderGlamaDockerfile(), 'utf8');
  fs.writeFileSync(
    path.join(mirrorRoot, 'release-manifest.json'),
    `${JSON.stringify(releaseManifest(sourceRevision), null, 2)}\n`,
    'utf8'
  );
  for (const obsolete of obsoleteRootFiles) {
    fs.rmSync(path.join(mirrorRoot, obsolete), { force: true });
  }
}

function verifyPublicMirror({ mirrorRoot, sourceRevision }) {
  assertRevision(sourceRevision);
  const violations = compareTrees(canonicalSkillRoot, path.join(mirrorRoot, mirrorSkillPath))
    .map(detail => ({ rule: 'skill-byte-mismatch', ...detail }));

  const sourcePath = path.join(mirrorRoot, 'SOURCE_REVISION');
  const source = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, 'utf8') : '';
  const commitMatches = source.match(/^Canonical commit:\s*([a-f0-9]{40})\s*$/mi);
  if (!commitMatches || commitMatches[1].toLowerCase() !== sourceRevision.toLowerCase()) {
    violations.push({ rule: 'source-revision-mismatch', path: 'SOURCE_REVISION' });
  }

  const readmePath = path.join(mirrorRoot, 'README.md');
  const readme = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf8') : '';
  if (!readme.includes(`TRAECNclaw ${packageInfo.version}`)
      || !/contract version 5/i.test(readme)
      || !/exactly 20/i.test(readme)
      || !/local-first/i.test(readme)
      || /TRAECN_MCP_TOOL_PROFILE|traecnclaw@0\.3/i.test(readme)) {
    violations.push({ rule: 'mirror-readme-stale', path: 'README.md' });
  }

  const manifestPath = path.join(mirrorRoot, 'release-manifest.json');
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.version !== packageInfo.version
        || manifest.contractVersion !== MCP_CONTRACT_VERSION
        || manifest.toolCount !== MCP_TOOL_NAMES.length
        || manifest.sourceRevision !== sourceRevision
        || manifest.marketplaces?.glama?.status !== 'listing-ready'
        || manifest.marketplaces?.glama?.hostedConnector !== false) {
      violations.push({ rule: 'mirror-manifest-stale', path: 'release-manifest.json' });
    }
  } catch {
    violations.push({ rule: 'mirror-manifest-invalid', path: 'release-manifest.json' });
  }

  const expectedGlama = path.join(distributionRoot, 'glama.json');
  const actualGlama = path.join(mirrorRoot, 'glama.json');
  if (!fs.existsSync(actualGlama) || sha256(expectedGlama) !== sha256(actualGlama)) {
    violations.push({ rule: 'glama-metadata-stale', path: 'glama.json' });
  }

  const dockerfilePath = path.join(mirrorRoot, 'Dockerfile');
  const dockerfile = fs.existsSync(dockerfilePath) ? fs.readFileSync(dockerfilePath, 'utf8') : '';
  if (!dockerfile.includes(`/v${packageInfo.version}/traecnclaw-${packageInfo.version}.tgz`)
      || !dockerfile.includes('ENTRYPOINT ["traecnclaw-mcp"]')
      || !dockerfile.includes('TRAECN_GATEWAY_HOST=127.0.0.1')
      || /0\.3\.0|TRAECN_MCP_TOOL_PROFILE|ENV TRAECN_HOST=|ENV TRAECN_PORT=|TRAECN_ENABLE_MOCK_BRIDGE/.test(dockerfile)) {
    violations.push({ rule: 'glama-dockerfile-stale', path: 'Dockerfile' });
  }

  for (const obsolete of obsoleteRootFiles) {
    if (fs.existsSync(path.join(mirrorRoot, obsolete))) {
      violations.push({ rule: 'obsolete-marketplace-metadata', path: obsolete });
    }
  }
  return violations;
}

function argValue(name) {
  const inline = process.argv.slice(2).find(arg => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function currentRevision() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'git rev-parse HEAD failed');
  return result.stdout.trim();
}

function main() {
  const mirrorRoot = path.resolve(argValue('--mirror') || process.env.TRAECN_PUBLIC_MIRROR_PATH || '');
  if (!argValue('--mirror') && !process.env.TRAECN_PUBLIC_MIRROR_PATH) {
    throw new Error('Pass --mirror <checkout> or set TRAECN_PUBLIC_MIRROR_PATH');
  }
  const sourceRevision = argValue('--revision') || currentRevision();
  if (!process.argv.includes('--check')) {
    buildPublicMirror({ mirrorRoot, sourceRevision });
  }
  const violations = verifyPublicMirror({ mirrorRoot, sourceRevision });
  if (violations.length > 0) {
    for (const violation of violations) console.error(`[public-mirror] ${violation.rule}: ${violation.path}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[public-mirror] Mirror matches ${sourceRevision}.`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`[public-mirror] ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildPublicMirror,
  compareTrees,
  verifyPublicMirror,
  releaseManifest,
  sourceRevisionDocument,
  renderGlamaDockerfile
};
