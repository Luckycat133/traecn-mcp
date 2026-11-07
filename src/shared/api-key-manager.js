'use strict';

const crypto = require('crypto');
const { getEnvWithFallback } = require('./utils');

const ALGORITHM = 'sha256';
const KEY_PREFIX_LENGTH = 8;

class ApiKeyManager {
  constructor(options = {}) {
    this.enabled = options.enabled !== false && (
      getEnvWithFallback('TRAECN_API_KEYS_ENABLED', 'TRAE_API_KEYS_ENABLED', '0') === '1'
    );
    this.keys = new Map();
    // Index from keyHash -> keyId for O(1) validation lookups. Maintained
    // alongside `this.keys` on create/revoke/rotate.
    this._keysByHash = new Map();
    this.signatureSecret = options.signatureSecret || getEnvWithFallback('TRAECN_SIGNATURE_SECRET', 'TRAE_SIGNATURE_SECRET', '');
    this.signatureTimestampWindow = options.signatureTimestampWindow || 300000;
    this.allowedIPs = options.allowedIPs !== undefined
      ? options.allowedIPs
      : this._parseAllowedIPs();
    this.defaultKeyExpiryDays = options.defaultKeyExpiryDays || 0;
  }

  _parseAllowedIPs() {
    const ipConfig = getEnvWithFallback('TRAECN_ALLOWED_IPS', 'TRAE_ALLOWED_IPS', '');
    if (!ipConfig) return null;
    return ipConfig.split(',').map(ip => ip.trim()).filter(Boolean).map(ip => this._parseIPEntry(ip));
  }

  _parseIPEntry(entry) {
    if (entry.includes('/')) {
      return { type: 'cidr', value: entry };
    }
    return { type: 'ip', value: entry };
  }

  _ipToBuffer(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    const octets = parts.map(p => Number(p));
    if (octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
      return null;
    }
    return Buffer.from(octets);
  }

  _cidrToRange(cidr) {
    const [ip, bitsStr] = cidr.split('/');
    let bits = Number(bitsStr);
    const ipBuffer = this._ipToBuffer(ip);
    if (!ipBuffer || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;

    const mask = Buffer.alloc(4);
    // Build the IPv4 subnet mask byte by byte from the remaining prefix
    // bits: a full byte (>= 8 bits) is 0xFF; a partial byte fills its top
    // bits with 1s via (0xFF << (8 - bits)) & 0xFF; exhausted bits give 0.
    for (let i = 0; i < 4; i++) {
      mask[i] = bits >= 8 ? 0xFF : (bits > 0 ? (0xFF << (8 - bits)) & 0xFF : 0);
      bits = Math.max(0, bits - 8);
    }

    const network = Buffer.alloc(4);
    for (let i = 0; i < 4; i++) {
      network[i] = ipBuffer[i] & mask[i];
    }

    const broadcast = Buffer.alloc(4);
    for (let i = 0; i < 4; i++) {
      broadcast[i] = network[i] | (~mask[i] & 0xFF);
    }

    return { network, broadcast };
  }

  _ipInCIDR(ip, cidr) {
    const range = this._cidrToRange(cidr);
    if (!range) return false;
    const ipBuffer = this._ipToBuffer(ip);
    if (!ipBuffer) return false;

    for (let i = 0; i < 4; i++) {
      if (ipBuffer[i] < range.network[i] || ipBuffer[i] > range.broadcast[i]) {
        return false;
      }
    }
    return true;
  }

  checkIPWhitelist(ip) {
    if (!this.allowedIPs) return true;
    return this.allowedIPs.some(entry => {
      if (entry.type === 'ip') {
        return entry.value === ip;
      }
      return this._ipInCIDR(ip, entry.value);
    });
  }

  generateKey() {
    const rawKey = crypto.randomBytes(32);
    return rawKey.toString('base64url');
  }

  hashKey(key) {
    return crypto.createHash(ALGORITHM).update(key).digest('hex');
  }

  getKeyPrefix(key) {
    return key.substring(0, KEY_PREFIX_LENGTH);
  }

  createKey(options = {}) {
    const keyId = 'key_' + crypto.randomBytes(8).toString('hex');
    const rawKey = this.generateKey();
    const keyHash = this.hashKey(rawKey);
    const keyPrefix = this.getKeyPrefix(rawKey);

    const now = new Date();
    const expiresAt = options.expiresInDays && options.expiresInDays > 0
      ? new Date(now.getTime() + options.expiresInDays * 24 * 60 * 60 * 1000)
      : null;

    const keyData = {
      keyId,
      name: options.name || 'Unnamed Key',
      keyHash,
      keyPrefix,
      createdAt: now.toISOString(),
      lastUsedAt: null,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      permissions: options.permissions || ['read']
    };

    this.keys.set(keyId, keyData);
    this._keysByHash.set(keyHash, keyId);
    return { ...keyData, key: rawKey };
  }

  /**
   * Validate a raw API key. Uses a hash index for O(1) lookup and
   * `timingSafeEqual` to avoid timing side-channels on hash comparison.
   *
   * @param {string} rawKey - The raw key to validate.
   * @returns {{valid: boolean, keyId?: string, permissions?: string[]} | {valid: boolean, reason: string} | null}
   *   Result object if the key format is valid, null if not found.
   */
  validateKey(rawKey) {
    if (!rawKey || typeof rawKey !== 'string') return null;

    const keyHash = this.hashKey(rawKey);
    const keyId = this._keysByHash.get(keyHash);
    if (!keyId) return null;

    const keyData = this.keys.get(keyId);
    if (!keyData) return null;

    // Constant-time comparison of the hash to avoid timing leaks. Both
    // buffers are 32-byte hex strings here; compare as buffers.
    const a = Buffer.from(keyHash, 'hex');
    const b = Buffer.from(keyData.keyHash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return null;
    }

    if (keyData.expiresAt && new Date(keyData.expiresAt) < new Date()) {
      return { valid: false, reason: 'expired' };
    }
    keyData.lastUsedAt = new Date().toISOString();
    return { valid: true, keyId, permissions: keyData.permissions };
  }

  getKey(keyId) {
    const keyData = this.keys.get(keyId);
    if (!keyData) return null;
    return {
      keyId: keyData.keyId,
      name: keyData.name,
      keyPrefix: keyData.keyPrefix,
      createdAt: keyData.createdAt,
      lastUsedAt: keyData.lastUsedAt,
      expiresAt: keyData.expiresAt,
      permissions: keyData.permissions
    };
  }

  listKeys() {
    return Array.from(this.keys.values()).map(k => ({
      keyId: k.keyId,
      name: k.name,
      keyPrefix: k.keyPrefix,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      expiresAt: k.expiresAt,
      permissions: k.permissions
    }));
  }

  revokeKey(keyId) {
    const keyData = this.keys.get(keyId);
    if (keyData) {
      this._keysByHash.delete(keyData.keyHash);
    }
    return this.keys.delete(keyId);
  }

  rotateKey(keyId) {
    const keyData = this.keys.get(keyId);
    if (!keyData) return null;

    // Remove the old hash from the index before assigning a new one.
    this._keysByHash.delete(keyData.keyHash);

    const newRawKey = this.generateKey();
    keyData.keyHash = this.hashKey(newRawKey);
    keyData.keyPrefix = this.getKeyPrefix(newRawKey);
    keyData.createdAt = new Date().toISOString();
    keyData.lastUsedAt = null;

    this._keysByHash.set(keyData.keyHash, keyId);

    return { ...keyData, key: newRawKey };
  }

  updateKey(keyId, updates) {
    const keyData = this.keys.get(keyId);
    if (!keyData) return null;

    if (updates.name) keyData.name = updates.name;
    if (updates.permissions) keyData.permissions = updates.permissions;
    if (updates.expiresInDays !== undefined) {
      if (updates.expiresInDays === 0) {
        keyData.expiresAt = null;
      } else {
        keyData.expiresAt = new Date(Date.now() + updates.expiresInDays * 24 * 60 * 60 * 1000).toISOString();
      }
    }

    return { ...keyData };
  }

  hasPermission(keyId, permission) {
    const keyData = this.keys.get(keyId);
    if (!keyData) return false;
    return keyData.permissions.includes(permission) || keyData.permissions.includes('admin');
  }

  verifySignature(reqBody, signature, timestamp) {
    if (!this.signatureSecret) return false;
    if (!timestamp || typeof timestamp !== 'string') return false;

    const ts = parseInt(timestamp, 10);
    if (!Number.isFinite(ts)) return false;

    const now = Date.now();
    if (Math.abs(now - ts) > this.signatureTimestampWindow) {
      return false;
    }

    const payload = `${timestamp}:${typeof reqBody === 'string' ? reqBody : JSON.stringify(reqBody || '')}`;
    const expectedSignature = crypto.createHmac('sha256', this.signatureSecret).update(payload).digest('hex');

    const sigBuffer = Buffer.from(signature || '', 'hex');
    const expBuffer = Buffer.from(expectedSignature, 'hex');

    if (sigBuffer.length !== expBuffer.length) return false;
    try {
      return crypto.timingSafeEqual(sigBuffer, expBuffer);
    } catch {
      return false;
    }
  }

  generateSignature(reqBody, timestamp) {
    if (!this.signatureSecret) return null;
    const ts = timestamp || Date.now().toString();
    const payload = `${ts}:${typeof reqBody === 'string' ? reqBody : JSON.stringify(reqBody || '')}`;
    return crypto.createHmac('sha256', this.signatureSecret).update(payload).digest('hex');
  }
}

module.exports = { ApiKeyManager };
