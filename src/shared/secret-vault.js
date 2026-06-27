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

// LRU cache for scrypt-derived keys, keyed by `${passphrase}:${saltHex}`.
// scryptSync (~100ms at N=16384) is the dominant cost in encrypt/decrypt; a
// single decryptObject call with N secrets would otherwise block the event
// loop for N*100ms. Caching makes repeated load/decrypt of the same config
// effectively free while still deriving on first use.
const KEY_CACHE_MAX = 128;
const _keyCache = new Map();

/**
 * Derive an AES-256 key from a passphrase and salt using scrypt.
 * Results are cached by `passphrase:saltHex` to avoid repeated ~100ms
 * scrypt derivations for the same inputs (e.g. config reloads).
 *
 * @param {string} passphrase - Human-readable passphrase.
 * @param {Buffer|string} salt - 16-byte buffer or hex string.
 * @returns {Buffer} 32-byte derived key.
 * @throws {Error} If passphrase is empty or salt is invalid.
 */
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
  const cacheKey = passphrase + ':' + salt.toString('hex');
  const cached = _keyCache.get(cacheKey);
  if (cached) {
    // Move to end (most-recently-used) for LRU eviction order.
    _keyCache.delete(cacheKey);
    _keyCache.set(cacheKey, cached);
    return cached;
  }
  const key = crypto.scryptSync(passphrase, salt, KEY_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  _keyCache.set(cacheKey, key);
  if (_keyCache.size > KEY_CACHE_MAX) {
    // Evict oldest entry (first key in insertion order).
    const oldest = _keyCache.keys().next().value;
    _keyCache.delete(oldest);
  }
  return key;
}

/**
 * Clear the derived-key cache. Useful when the passphrase rotates or in tests.
 */
function clearKeyCache() {
  _keyCache.clear();
}

/**
 * Encrypt a plaintext string with AES-256-GCM using a passphrase-derived key.
 *
 * @param {string} plaintext - The value to encrypt.
 * @param {Object} options - Options.
 * @param {string} options.passphrase - Passphrase used to derive the key.
 * @returns {string} Opaque ciphertext prefixed with `enc:v1:`.
 * @throws {Error} If plaintext is not a string or passphrase is missing.
 */
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

/**
 * Decrypt a value produced by {@link encryptString}.
 *
 * Non-encrypted strings are passed through unchanged so callers can handle
 * mixed plaintext/ciphertext states during passphrase rotation.
 *
 * @param {string} stored - The stored value (ciphertext or plaintext).
 * @param {Object} options - Options.
 * @param {string} options.passphrase - Passphrase used to derive the key.
 * @returns {string} The decrypted plaintext, or the input if not encrypted.
 * @throws {Error} If the value is encrypted but the passphrase is missing,
 *   the payload is malformed, or GCM authentication fails (tampering).
 */
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

/**
 * Check whether a value is an encrypted payload produced by this vault.
 *
 * @param {*} value - Any value to test.
 * @returns {boolean} True if the value is an encrypted string.
 */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX);
}

/**
 * Recursively walk an object and encrypt every string leaf that lives in a
 * sensitive key. Returns a new object — the input is not mutated.
 *
 * Sensitive keys are matched by `SENSITIVE_KEY_PATTERN` (api key/token/secret/
 * password/credential/private). Top-level strings and array elements are
 * passed through unchanged because without a key name we cannot tell whether
 * they are sensitive.
 */
const SENSITIVE_KEY_PATTERN = /(api[-_]?key|token|secret|password|credential|private)/i;

function encryptObject(obj, options) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    // Top-level string: no key name available, so we cannot determine
    // sensitivity. Pass through (already-encrypted values stay as-is).
    return isEncrypted(obj) ? obj : obj;
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

/**
 * Recursively walk an object and decrypt every encrypted string leaf.
 * Returns a new object — the input is not mutated.
 */
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
  deriveKey,
  clearKeyCache,
  ENCRYPTED_PREFIX
};
