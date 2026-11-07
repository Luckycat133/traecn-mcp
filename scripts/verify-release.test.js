'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { verifyManifest } = require('./verify-release');
const { createRunner } = require('../src/shared/test-runner');

const r = createRunner('verify-release.test.js');
const { test, summary } = r;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'traecn-release-verify-'));
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'traecnclaw', version: '0.5.4' })
  );
  const skill = Buffer.from('skill archive');
  const server = Buffer.from('server archive');
  fs.writeFileSync(path.join(root, 'dist', 'skill.tgz'), skill);
  fs.writeFileSync(path.join(root, 'dist', 'server.tgz'), server);
  const manifest = {
    name: 'traecn-mcp',
    version: '0.5.4',
    sourceRevision: 'a'.repeat(40),
    sourceDirty: false,
    artifacts: [{ path: 'dist/skill.tgz', bytes: skill.length, sha256: sha256(skill) }],
    serverPackage: {
      name: 'traecnclaw',
      version: '0.5.4',
      artifact: { path: 'dist/server.tgz', bytes: server.length, sha256: sha256(server) },
    },
  };
  const manifestPath = path.join(root, 'dist', 'release.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  return { root, manifestPath, manifest };
}

test('verifyManifest accepts a clean manifest whose artifacts match exactly', () => {
  const fixture = createFixture();
  try {
    assert.deepStrictEqual(
      verifyManifest({
        repoRoot: fixture.root,
        manifestPath: fixture.manifestPath,
        revision: fixture.manifest.sourceRevision,
        version: fixture.manifest.version,
      }),
      []
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('verifyManifest reports artifact checksum drift and source mismatch', () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(path.join(fixture.root, 'dist', 'skill.tgz'), 'tampered');
    const errors = verifyManifest({
      repoRoot: fixture.root,
      manifestPath: fixture.manifestPath,
      revision: 'b'.repeat(40),
      version: '0.5.5',
    });
    assert.ok(errors.some((error) => error.includes('sourceRevision')));
    assert.ok(errors.some((error) => error.includes('version')));
    assert.ok(errors.some((error) => error.includes('sha256')));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

summary();
if (r.failed > 0) process.exit(1);
