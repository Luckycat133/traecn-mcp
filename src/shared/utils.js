'use strict';

const crypto = require('crypto');

const {
  normalizeQueueProbeText,
  isQueueProbeCommandText,
  isGenericQueueProbeTask,
  isForeignQueueProbeText
} = require('./queue-probe');

/**
 * 从环境变量获取值，支持降级查找
 * @param {string} traecnKey TraeCN 环境变量名
 * @param {string} traeKey 降级环境变量名
 * @param {*} defaultValue 默认值
 * @returns {*}
 */
function getEnvWithFallback(traecnKey, traeKey, defaultValue) {
  return process.env[traecnKey] ?? process.env[traeKey] ?? defaultValue;
}

/**
 * 解析 CSS 选择器列表
 * @param {string} envValue 逗号分隔的选择器字符串
 * @param {string[]} defaults 默认值
 * @returns {string[]}
 */
function parseSelectors(envValue, defaults) {
  if (!envValue) return defaults;
  return envValue.split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * 解析正整数
 * @param {string} value 输入字符串
 * @param {number} defaultValue 默认值
 * @returns {number}
 */
function parsePositiveInt(value, defaultValue) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

/**
 * 延迟函数
 * @param {number} ms 毫秒数
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 安全的 JavaScript 值序列化
 * @param {*} value 输入值
 * @returns {string}
 */
function safeJsValue(value) {
  try {
    if (typeof value === 'undefined') return 'undefined';
    if (typeof value === 'string' && hasUnsafeJsValueChars(value)) return '';
    const encoded = JSON.stringify(value);
    if (typeof encoded === 'undefined') return 'undefined';
    return encoded;
  } catch {
    return '';
  }
}

function hasUnsafeJsValueChars(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (value[index] === '<' || value[index] === '>' || code <= 31) {
      return true;
    }
  }
  return false;
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
