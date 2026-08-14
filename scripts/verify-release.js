#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function gitRevision(repoRoot) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr || 'git rev-parse HEAD failed');
  return result.stdout.trim();
}

function isInside(rootPath, candidatePath) {
  const root = `${path.resolve(rootPath)}${path.sep}`;
  return path.resolve(candidatePath).startsWith(root);
}

function checkArtifact(repoRoot, entry, label) {
  const errors = [];
  if (!entry || typeof entry !== 'object') return [`${label} is missing`];
  if (typeof entry.path !== 'string' || !entry.path.trim()) return [`${label}.path is missing`];
  const filePath = path.resolve(repoRoot, entry.path);
  if (!isInside(repoRoot, filePath)) {
    return [`${label}.path escapes the repository: ${entry.path}`];
  }
  if (!fs.existsSync(filePath)) return [`${label} is missing: ${entry.path}`];
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return [`${label} is not a file: ${entry.path}`];
  if (Number(entry.bytes) !== stat.size) {
    errors.push(`${label}.bytes mismatch: manifest=${entry.bytes} actual=${stat.size}`);
  }
  const expectedDigest = String(entry.sha256 || '').toLowerCase();
  const actualDigest = sha256(filePath);
  if (!/^[a-f0-9]{64}$/.test(expectedDigest) || expectedDigest !== actualDigest) {
    errors.push(`${label}.sha256 mismatch: manifest=${entry.sha256} actual=${actualDigest}`);
  }
  return errors;
}

function verifyManifest({
  repoRoot = DEFAULT_REPO_ROOT,
  manifestPath = path.join(repoRoot, 'dist', 'traecnclaw-mcp-release.json'),
  revision = null,
  version = null,
  allowDirty = false,
} = {}) {
  const errors = [];
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return [`could not read release manifest: ${error.message}`];
  }

  const expectedRevision = revision || gitRevision(repoRoot);
  const packagePath = path.join(repoRoot, 'package.json');
  let packageVersion = version;
  if (!packageVersion) {
    try {
      packageVersion = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version;
    } catch (error) {
      errors.push(`could not read package version: ${error.message}`);
    }
  }

  if (manifest.sourceRevision !== expectedRevision) {
    errors.push(
      `sourceRevision mismatch: manifest=${manifest.sourceRevision} expected=${expectedRevision}`
    );
  }
  if (!allowDirty && manifest.sourceDirty !== false) {
    errors.push('manifest sourceDirty must be false for a release artifact');
  }
  if (packageVersion && manifest.version !== packageVersion) {
    errors.push(`version mismatch: manifest=${manifest.version} package=${packageVersion}`);
  }
  if (manifest.serverPackage?.version !== manifest.version) {
    errors.push(
      `serverPackage.version mismatch: ${manifest.serverPackage?.version} != ${manifest.version}`
    );
  }

  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  if (artifacts.length === 0) errors.push('manifest.artifacts is empty');
  artifacts.forEach((entry, index) => {
    errors.push(...checkArtifact(repoRoot, entry, `artifacts[${index}]`));
  });
  errors.push(
    ...checkArtifact(repoRoot, manifest.serverPackage?.artifact, 'serverPackage.artifact')
  );
  return errors;
}

function readOption(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] || null;
}

function main(argv = process.argv.slice(2)) {
  const errors = verifyManifest({
    manifestPath: readOption(argv, '--manifest') || undefined,
    revision: readOption(argv, '--revision'),
    version: readOption(argv, '--version'),
    allowDirty: argv.includes('--allow-dirty'),
  });
  if (errors.length > 0) {
    errors.forEach((error) => console.error(`[verify-release] ERROR ${error}`));
    process.exitCode = 1;
    return;
  }
  console.log(
    '[verify-release] Release manifest matches the current source revision and artifact bytes.'
  );
}

if (require.main === module) main();

module.exports = {
  checkArtifact,
  sha256,
  verifyManifest,
};
