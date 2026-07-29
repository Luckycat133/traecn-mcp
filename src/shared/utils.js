'use strict';

const crypto = require('crypto');

// Queue-probe logic lives in ./queue-probe; re-exported below so the public
// surface of this module stays unchanged for existing callers.
const {
  normalizeQueueProbeText,
  isQueueProbeCommandText,
  isGenericQueueProbeTask,
  isForeignQueueProbeText
} = require('./queue-probe');

/**
 * Get a value from environment variables, with fallback lookup.
 * @param {string} traecnKey TraeCN environment variable name.
 * @param {string} traeKey Fallback environment variable name.
 * @param {*} defaultValue Default value.
 * @returns {*}
 */
function getEnvWithFallback(traecnKey, traeKey, defaultValue) {
  return process.env[traecnKey] ?? process.env[traeKey] ?? defaultValue;
}

/**
 * Parse a CSS selector list.
 * @param {string} envValue Comma-separated selector string.
 * @param {string[]} defaults Default values.
 * @returns {string[]}
 */
function parseSelectors(envValue, defaults) {
  if (!envValue) return defaults;
  return envValue.split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Parse a positive integer.
 * @param {string} value Input string.
 * @param {number} defaultValue Default value.
 * @returns {number}
 */
function parsePositiveInt(value, defaultValue) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

/**
 * Delay helper.
 * @param {number} ms Milliseconds.
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Safe JavaScript value serialization.
 * @param {*} value Input value.
 * @returns {string}
 */
function safeJsValue(value) {
  try {
    if (typeof value === 'undefined') return 'undefined';
    if (typeof value === 'string') {
      value = stripControlChars(value);
    }
    const encoded = JSON.stringify(value);
    if (typeof encoded === 'undefined') return 'undefined';
    return encoded;
  } catch {
    return '""';
  }
}

function stripControlChars(value) {
  let result = '';
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 31) result += value[i];
  }
  return result;
}

async function safeClose(resource) {
  if (!resource || typeof resource.close !== 'function') return;
  try {
    await resource.close();
  } catch {
    // Best effort cleanup only.
  }
}

/**
 * Constant-time string comparison to prevent timing side-channel attacks.
 * Returns true iff both strings are byte-equal. Handles length mismatch
 * without leaking which prefix matched.
 *
 * @param {string} left - First string.
 * @param {string} right - Second string.
 * @returns {boolean} True if the strings are equal.
 */
function secureCompare(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}



// Substring-based redaction keys used by both sanitizeLog (general purpose)
// and audit-logger. Listed longest-first so prefixes ('authorization' before
// 'auth' before 'token') don't accidentally over-match.
const SENSITIVE_LOG_KEYS = Object.freeze([
  'authorization',
  'set-cookie',
  'apikey',
  'api_key',
  'cookie',
  'credential',
  'password',
  'secret',
  'token'
]);

function sanitizeLog(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const sanitized = Array.isArray(obj) ? [] : {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_LOG_KEYS.some(k => key.toLowerCase().includes(k))) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeLog(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function getGatewayContext(env = process.env) {
  const portStr = env.TRAECN_GATEWAY_PORT ?? env.TRAE_GATEWAY_PORT ?? '8787';
  const host = env.TRAECN_GATEWAY_HOST ?? env.TRAE_GATEWAY_HOST ?? '127.0.0.1';
  const token = env.TRAECN_GATEWAY_TOKEN ?? env.TRAE_GATEWAY_TOKEN ?? '';
  const timeoutStr = env.TRAECN_GATEWAY_TIMEOUT_MS ?? env.TRAE_GATEWAY_TIMEOUT_MS ?? '30000';
  return {
    host,
    port: parsePositiveInt(portStr, 8787),
    token,
    timeout: parsePositiveInt(timeoutStr, 30000)
  };
}

module.exports = {
  getEnvWithFallback,
  parseSelectors,
  parsePositiveInt,
  sleep,
  safeJsValue,
  secureCompare,
  normalizeQueueProbeText,
  isQueueProbeCommandText,
  isGenericQueueProbeTask,
  isForeignQueueProbeText,
  safeClose,
  sanitizeLog,
  getGatewayContext,
  SENSITIVE_LOG_KEYS
};
