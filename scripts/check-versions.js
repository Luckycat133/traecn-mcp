#!/usr/bin/env node
'use strict';

const { readVersions } = require('./lib/version-surfaces');

const versions = readVersions();

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
