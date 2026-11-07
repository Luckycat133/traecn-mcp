'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Readable } = require('node:stream');
const { readBodyWithLimit, readJsonBody, validateSchema, DEFAULT_MAX_BODY_BYTES } = require('./http-body');

function mockReq(headers, chunks) {
  const r = new Readable({ read() {} });
  Object.assign(r, { headers });
  // Stream the chunks asynchronously.
  setImmediate(() => {
    for (const c of chunks) r.push(c);
    r.push(null);
  });
  return r;
}

test('readBodyWithLimit returns text for small bodies', async () => {
  const req = mockReq({ 'content-length': '5' }, [Buffer.from('hello')]);
  const res = await readBodyWithLimit(req, 100);
  assert.equal(res.ok, true);
  assert.equal(res.text, 'hello');
});

test('readBodyWithLimit rejects oversized Content-Length header', async () => {
  const req = mockReq({ 'content-length': '999999999' }, []);
  const res = await readBodyWithLimit(req, 100);
  assert.equal(res.ok, false);
  assert.equal(res.status, 413);
});

test('readBodyWithLimit enforces limit mid-stream when header lies', async () => {
  // Header claims small, but actual stream sends more.
  const req = mockReq({ 'content-length': '5' }, [
    Buffer.alloc(50, 'a'),
    Buffer.alloc(60, 'b')
  ]);
  const res = await readBodyWithLimit(req, 100);
  assert.equal(res.ok, false);
  assert.equal(res.status, 413);
});

test('readJsonBody requires application/json content type', async () => {
  const req = mockReq({ 'content-type': 'text/plain' }, [Buffer.from('{}')]);
  const res = await readJsonBody(req, { maxBytes: 1000 });
  assert.equal(res.ok, false);
  assert.equal(res.status, 415);
});

test('readJsonBody rejects non-object body', async () => {
  const req = mockReq({ 'content-type': 'application/json' }, [Buffer.from('"hello"')]);
  const res = await readJsonBody(req, { maxBytes: 1000 });
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
});

test('readJsonBody rejects empty body', async () => {
  const req = mockReq({ 'content-type': 'application/json' }, []);
  const res = await readJsonBody(req, { maxBytes: 1000 });
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
});

test('readJsonBody rejects invalid JSON', async () => {
  const req = mockReq({ 'content-type': 'application/json' }, [Buffer.from('{not json}')]);
  const res = await readJsonBody(req, { maxBytes: 1000 });
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.match(res.error, /Invalid JSON/);
});

test('readJsonBody returns parsed body on success', async () => {
  const req = mockReq({ 'content-type': 'application/json' }, [
    Buffer.from(JSON.stringify({ task: 'do thing' }))
  ]);
  const res = await readJsonBody(req, { maxBytes: 1000 });
  assert.equal(res.ok, true);
  assert.deepEqual(res.body, { task: 'do thing' });
});

test('readJsonBody enforces schema when provided', async () => {
  const req = mockReq({ 'content-type': 'application/json' }, [
    Buffer.from(JSON.stringify({ task: '' }))
  ]);
  const schema = {
    type: 'object',
    required: ['task'],
    properties: { task: { type: 'string', minLength: 1, maxLength: 10 } }
  };
  const res = await readJsonBody(req, { maxBytes: 1000, schema });
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
});

test('validateSchema: strings with pattern + length', () => {
  assert.equal(validateSchema('abc', { type: 'string', minLength: 1, maxLength: 5 }).ok, true);
  assert.equal(validateSchema('', { type: 'string', minLength: 1 }).ok, false);
  assert.equal(validateSchema('hello', { type: 'string', maxLength: 3 }).ok, false);
  assert.equal(validateSchema('req-123', { type: 'string', pattern: '^req-' }).ok, true);
  assert.equal(validateSchema('nope', { type: 'string', pattern: '^req-' }).ok, false);
});

test('validateSchema: numbers with min/max and integer flag', () => {
  assert.equal(validateSchema(5, { type: 'number', min: 0, max: 10 }).ok, true);
  assert.equal(validateSchema(-1, { type: 'number', min: 0 }).ok, false);
  assert.equal(validateSchema(11, { type: 'number', max: 10 }).ok, false);
  assert.equal(validateSchema(1.5, { type: 'number', integer: true }).ok, false);
  assert.equal(validateSchema(2, { type: 'number', integer: true }).ok, true);
});

test('validateSchema: arrays with items', () => {
  const schema = {
    type: 'array',
    minItems: 1,
    maxItems: 3,
    items: { type: 'string', minLength: 1 }
  };
  assert.equal(validateSchema(['a', 'b'], schema).ok, true);
  assert.equal(validateSchema([], schema).ok, false);
  assert.equal(validateSchema(['a', 'b', 'c', 'd'], schema).ok, false);
  assert.equal(validateSchema(['', 'b'], schema).ok, false);
});

test('validateSchema: nested objects with required', () => {
  const schema = {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 1 },
      age: { type: 'number', min: 0, integer: true }
    }
  };
  assert.equal(validateSchema({ name: 'foo' }, schema).ok, true);
  assert.equal(validateSchema({ name: 'foo', age: 30 }, schema).ok, true);
  assert.equal(validateSchema({ name: 'foo', age: -1 }, schema).ok, false);
  assert.equal(validateSchema({}, schema).ok, false);
});

test('DEFAULT_MAX_BODY_BYTES defaults to 1 MiB', () => {
  assert.equal(DEFAULT_MAX_BODY_BYTES, 1024 * 1024);
});