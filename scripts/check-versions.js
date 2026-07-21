#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const readJson = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const packageJson = readJson('package.json');
const lock = readJson('package-lock.json');
const pluginPackage = readJson('integrations/openclaw-traecn-plugin/package.json');
const pluginManifest = readJson('integrations/openclaw-traecn-plugin/openclaw.plugin.json');
const skill = fs.readFileSync(path.join(root, 'skills/traecnclaw-mcp/SKILL.md'), 'utf8');
const skillVersion = skill.match(/^\s*version:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1];

const versions = {
  package: packageJson.version,
  lockfile: lock.version,
  lockfileRoot: lock.packages?.['']?.version,
  skill: skillVersion,
  pluginPackage: pluginPackage.version,
  pluginManifest: pluginManifest.version,
};

const expected = versions.package;
const mismatches = Object.entries(versions).filter(([, value]) => value !== expected);
if (mismatches.length) {
  console.error('Version mismatch:', versions);
  process.exit(1);
}

if (process.env.GITHUB_REF_TYPE === 'tag') {
  const tagVersion = String(process.env.GITHUB_REF_NAME || '').replace(/^v/, '');
  if (tagVersion !== expected) {
    console.error(`Tag version ${tagVersion} does not match package version ${expected}`);
    process.exit(1);
  }
}

console.log(`All distribution surfaces use version ${expected}`);
