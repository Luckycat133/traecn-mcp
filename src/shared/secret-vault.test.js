'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const secretVault = require('./secret-vault');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`        ${err.message}`);
  }
}

console.log('\n[secret-vault.test.js] Running tests...\n');

const PASSPHRASE = 'correct horse battery staple';

test('encryptString produces opaque ciphertext prefixed with enc:v1:', () => {
  const out = secretVault.encryptString('hello', { passphrase: PASSPHRASE });
  assert.ok(typeof out === 'string');
  assert.ok(out.startsWith(secretVault.ENCRYPTED_PREFIX));
  assert.ok(!out.includes('hello'));
});

test('decryptString roundtrips plaintext', () => {
  const out = secretVault.encryptString('sk-12345', { passphrase: PASSPHRASE });
  const back = secretVault.decryptString(out, { passphrase: PASSPHRASE });
  assert.strictEqual(back, 'sk-12345');
});

test('decryptString fails with wrong passphrase', () => {
  const out = secretVault.encryptString('sk-12345', { passphrase: PASSPHRASE });
  assert.throws(() => secretVault.decryptString(out, { passphrase: 'wrong' }), /unsupported|auth|invalid/i);
});

test('decryptString fails with tampered ciphertext', () => {
  const out = secretVault.encryptString('sk-12345', { passphrase: PASSPHRASE });
  // Flip a character in the base64 portion to mutate the ciphertext.
  const idx = out.length - 5;
  const badChar = out[idx] === 'A' ? 'B' : 'A';
  const tampered = out.slice(0, idx) + badChar + out.slice(idx + 1);
  assert.throws(() => secretVault.decryptString(tampered, { passphrase: PASSPHRASE }));
});

test('decryptString passes through non-encrypted strings', () => {
  // Plaintext values are valid input (allows mixed-state configs during
  // migration). They should pass through untouched.
  assert.strictEqual(secretVault.decryptString('plain', { passphrase: PASSPHRASE }), 'plain');
  assert.strictEqual(secretVault.decryptString('', { passphrase: PASSPHRASE }), '');
});

test('isEncrypted detects the prefix', () => {
  assert.strictEqual(secretVault.isEncrypted('enc:v1:abc'), true);
  assert.strictEqual(secretVault.isEncrypted('plain'), false);
  assert.strictEqual(secretVault.isEncrypted(''), false);
  assert.strictEqual(secretVault.isEncrypted(null), false);
});

test('encryptObject encrypts only sensitive keys', () => {
  const obj = {
    apiKey: 'sk-secret-1',
    apiToken: 'tok-secret-2',
    password: 'pw-secret-3',
    label: 'public-value',
    nested: { clientSecret: 'nested-secret', description: 'public' }
  };
  const out = secretVault.encryptObject(obj, { passphrase: PASSPHRASE });
  assert.ok(secretVault.isEncrypted(out.apiKey));
  assert.ok(secretVault.isEncrypted(out.apiToken));
  assert.ok(secretVault.isEncrypted(out.password));
  assert.strictEqual(out.label, 'public-value');
  assert.ok(secretVault.isEncrypted(out.nested.clientSecret));
  assert.strictEqual(out.nested.description, 'public');
});

test('decryptObject inverts encryptObject', () => {
  const obj = {
    apiKey: 'sk-secret-1',
    nested: { token: 'tok-2' },
    description: 'public'
  };
  const encrypted = secretVault.encryptObject(obj, { passphrase: PASSPHRASE });
  const decrypted = secretVault.decryptObject(encrypted, { passphrase: PASSPHRASE });
  assert.strictEqual(decrypted.apiKey, 'sk-secret-1');
  assert.strictEqual(decrypted.nested.token, 'tok-2');
  assert.strictEqual(decrypted.description, 'public');
});

test('encryptObject leaves already-encrypted values alone', () => {
  const already = secretVault.encryptString('sk-x', { passphrase: PASSPHRASE });
  const out = secretVault.encryptObject({ apiKey: already }, { passphrase: PASSPHRASE });
  assert.strictEqual(out.apiKey, already, 'idempotent on already-encrypted values');
});

test('encryptObject handles arrays', () => {
  const obj = {
    tokens: ['a-secret', 'b-secret']
  };
  const out = secretVault.encryptObject(obj, { passphrase: PASSPHRASE });
  // Array values aren't matched against the sensitive-key regex; they are
  // passed through. This is the expected behavior — secrets are typically
  // stored as named values, not as positional lists.
  assert.deepStrictEqual(out.tokens, ['a-secret', 'b-secret']);
});

test('encryptString rejects non-string plaintext', () => {
  assert.throws(() => secretVault.encryptString(123, { passphrase: PASSPHRASE }));
  assert.throws(() => secretVault.encryptString(null, { passphrase: PASSPHRASE }));
});

test('encryptString requires passphrase', () => {
  assert.throws(() => secretVault.encryptString('x', {}), /passphrase/);
  assert.throws(() => secretVault.encryptString('x', { passphrase: '' }), /passphrase/);
});

console.log(`\n[secret-vault.test.js] Results: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
