'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { generateOpenAPISpec } = require('../src/http/openapi');

const root = path.resolve(__dirname, '..');
const requiredDocs = [
  'README.md',
  'docs/user-manual.md',
  'docs/development.md',
  'docs/deployment.md',
  'CHANGELOG.md',
  '.env.example'
];

for (const docPath of requiredDocs) {
  const absolute = path.join(root, docPath);
  assert.ok(fs.existsSync(absolute), `${docPath} is missing`);
  assert.ok(fs.statSync(absolute).size > 200, `${docPath} is too small to be useful`);
}

const spec = generateOpenAPISpec();
for (const apiPath of [
  '/api/status',
  '/api/sessions',
  '/api/delegate',
  '/api/delegate-async',
  '/api/settings/read',
  '/api/settings/set',
  '/api/update-self'
]) {
  assert.ok(spec.paths[apiPath], `${apiPath} is missing from OpenAPI`);
}

console.log('[uat-checklist] PASS');
