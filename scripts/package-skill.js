#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const skillName = 'traecnclaw-mcp';
const skillRoot = path.join(repoRoot, 'skills');
const skillDir = path.join(skillRoot, skillName);
const distDir = path.join(repoRoot, 'dist');

function fail(message) {
  console.error(`[package-skill] ERROR ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  if (result.error && result.error.code === 'ENOENT') {
    return { available: false };
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed\n${result.stderr || result.stdout}`);
  }
  return { available: true, stdout: result.stdout.trim() };
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function artifact(filePath) {
  return {
    path: path.relative(repoRoot, filePath),
    bytes: fs.statSync(filePath).size,
    sha256: sha256(filePath)
  };
}

function treeSha256(rootPath) {
  const hash = crypto.createHash('sha256');
  const visit = (currentPath, relativePath = '') => {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childRelative = path.join(relativePath, entry.name);
      const childPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        visit(childPath, childRelative);
      } else if (entry.isFile()) {
        hash.update(childRelative.split(path.sep).join('/'));
        hash.update('\0');
        hash.update(fs.readFileSync(childPath));
        hash.update('\0');
      }
    }
  };
  visit(rootPath);
  return hash.digest('hex');
}

function gitOutput(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) fail(`git ${args.join(' ')} failed\n${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) {
  fail(`missing ${path.relative(repoRoot, path.join(skillDir, 'SKILL.md'))}`);
}

fs.mkdirSync(distDir, { recursive: true });

const tgzPath = path.join(distDir, `${skillName}-skill.tgz`);
const zipPath = path.join(distDir, `${skillName}-skill.zip`);

run('tar', ['-czf', tgzPath, '-C', skillRoot, skillName]);

const zipResult = run('zip', ['-qr', zipPath, skillName], { cwd: skillRoot });
const artifacts = [artifact(tgzPath)];
if (zipResult.available && fs.existsSync(zipPath)) {
  artifacts.push(artifact(zipPath));
}

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const serverPackResult = run(npmCommand, ['pack', '--pack-destination', distDir, '--json']);
let serverPackInfo;
try {
  [serverPackInfo] = JSON.parse(serverPackResult.stdout);
} catch {
  fail(`could not parse npm pack output\n${serverPackResult.stdout}`);
}
if (!serverPackInfo?.filename) fail('npm pack did not report an artifact filename');
const serverArchivePath = path.join(distDir, serverPackInfo.filename);
const serverPackageArtifact = artifact(serverArchivePath);

const manifest = {
  name: skillName,
  version: require('../package.json').version,
  generatedAt: new Date().toISOString(),
  sourceRevision: gitOutput(['rev-parse', 'HEAD']),
  sourceDirty: Boolean(gitOutput(['status', '--porcelain'])),
  skillPath: path.relative(repoRoot, skillDir),
  skillTreeSha256: treeSha256(skillDir),
  artifacts,
  serverPackage: {
    name: require('../package.json').name,
    version: require('../package.json').version,
    artifact: serverPackageArtifact
  },
  install: {
    codexGlobal: `mkdir -p "\${CODEX_HOME:-$HOME/.codex}/skills" && tar -xzf ${path.relative(repoRoot, tgzPath)} -C "\${CODEX_HOME:-$HOME/.codex}/skills"`,
    serverPackage: `npm install ${serverPackageArtifact.path}`,
    sourceCheckout: 'Use the MCP config examples in README.md or docs/DISTRIBUTION.md with an absolute path to mcp-server.js.'
  }
};

const manifestPath = path.join(distDir, `${skillName}-release.json`);
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`[package-skill] wrote ${path.relative(repoRoot, tgzPath)}`);
if (artifacts.some(item => item.path.endsWith('.zip'))) {
  console.log(`[package-skill] wrote ${path.relative(repoRoot, zipPath)}`);
} else {
  console.log('[package-skill] zip command not available; skipped zip artifact');
}
console.log(`[package-skill] wrote ${path.relative(repoRoot, manifestPath)}`);
console.log(`[package-skill] wrote ${serverPackageArtifact.path}`);
