'use strict';

const crypto = require('crypto');

/**
 * Secret vault: encrypt/decrypt small string values (API keys, tokens) with
 * AES-256-GCM. The encryption key is derived from a passphrase via scrypt so
 * that operators can rotate it without touching the underlying data.
 *
 * Encrypted payload format (JSON):
 *   { v: 1, kdf: 'scrypt', salt: '<hex>', iv: '<hex>', tag: '<hex>', data: '<base64>' }
 *
 * The format is self-describing so future readers can pick the right KDF and
 * cipher. Tampering with any of the fields fails the GCM tag check.
 */

const PAYLOAD_VERSION = 1;
const KEY_BYTES = 32;       // 256-bit AES key
const IV_BYTES = 12;        // 96-bit IV recommended for GCM
const SALT_BYTES = 16;      // 128-bit salt
const TAG_BYTES = 16;       // 128-bit GCM auth tag
const SCRYPT_N = 16384;     // CPU/memory cost (2^14)
const SCRYPT_R = 8;
const SCRYPT_P = 1;

const ENCRYPTED_PREFIX = 'enc:v1:';

function deriveKey(passphrase, salt) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('Secret vault: passphrase is required');
  }
  if (typeof salt === 'string') {
    salt = Buffer.from(salt, 'hex');
  }
  if (!Buffer.isBuffer(salt) || salt.length !== SALT_BYTES) {
    throw new Error(`Secret vault: salt must be a ${SALT_BYTES}-byte buffer (or hex string)`);
  }
  return crypto.scryptSync(passphrase, salt, KEY_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
}

function encryptString(plaintext, options = {}) {
  if (typeof plaintext !== 'string') {
    throw new Error('Secret vault: plaintext must be a string');
  }
  const passphrase = options.passphrase;
  if (!passphrase) throw new Error('Secret vault: passphrase is required');

  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = {
    v: PAYLOAD_VERSION,
    kdf: 'scrypt',
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: ciphertext.toString('base64')
  };
  return ENCRYPTED_PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function decryptString(stored, options = {}) {
  if (typeof stored !== 'string' || !stored.startsWith(ENCRYPTED_PREFIX)) {
    // Pass-through: callers may store plaintext values until they rotate
    // them. This avoids bricking a deployment when the vault passphrase is
    // missing or the value is unencrypted.
    return stored;
  }
  const passphrase = options.passphrase;
  if (!passphrase) {
    throw new Error('Secret vault: passphrase is required to decrypt');
  }
  const wrapped = stored.slice(ENCRYPTED_PREFIX.length);
  let payload;
  try {
    payload = JSON.parse(Buffer.from(wrapped, 'base64').toString('utf8'));
  } catch (err) {
    throw new Error(`Secret vault: malformed encrypted payload (${err.message})`);
  }
  if (!payload || payload.v !== PAYLOAD_VERSION) {
    throw new Error(`Secret vault: unsupported payload version (${payload && payload.v})`);
  }
  const salt = Buffer.from(payload.salt || '', 'hex');
  const iv = Buffer.from(payload.iv || '', 'hex');
  const tag = Buffer.from(payload.tag || '', 'hex');
  const data = Buffer.from(payload.data || '', 'base64');
  if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Secret vault: invalid payload lengths');
  }
  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  return plain.toString('utf8');
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX);
}

/**
 * Recursively walk an object and encrypt every string leaf that lives in a
 * sensitive key. Returns a new object — the input is not mutated.
 */
const SENSITIVE_KEY_PATTERN = /(api[-_]?key|token|secret|password|credential|private)/i;

function encryptObject(obj, options) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    if (!options.fields || options.fields.has(obj) || isEncrypted(obj)) return obj;
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => encryptObject(item, options));
  }
  if (typeof obj === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(obj)) {
      if (SENSITIVE_KEY_PATTERN.test(key) && typeof value === 'string' && !isEncrypted(value)) {
        out[key] = encryptString(value, options);
      } else {
        out[key] = encryptObject(value, options);
      }
    }
    return out;
  }
  return obj;
}

function decryptObject(obj, options) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    if (isEncrypted(obj)) return decryptString(obj, options);
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => decryptObject(item, options));
  }
  if (typeof obj === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(obj)) {
      if (SENSITIVE_KEY_PATTERN.test(key) && typeof value === 'string' && isEncrypted(value)) {
        out[key] = decryptString(value, options);
      } else {
        out[key] = decryptObject(value, options);
      }
    }
    return out;
  }
  return obj;
}

module.exports = {
  encryptString,
  decryptString,
  encryptObject,
  decryptObject,
  isEncrypted,
  ENCRYPTED_PREFIX
};
