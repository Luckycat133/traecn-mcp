'use strict';

const crypto = require('crypto');

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
 * 转义 JavaScript 字符串
 * @param {string} str 输入字符串
 * @returns {string}
 */
function escapeJsString(str) {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
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

function normalizeQueueProbeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[，。！？、,.!?;:：]/g, ' ')
    .replace(/\b(?:rename|export|copy\s+session|delete\s+task)\b/g, ' ')
    .replace(/重命名|导出|复制会话|删除任务/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isQueueProbeStatusSuffix(value) {
  const suffix = String(value || '').trim();
  if (!suffix) return true;
  const withoutTime = suffix
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}\s+\d{2}\b/g, ' ')
    .replace(/\d{1,2}月\d{1,2}日/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!withoutTime) return true;
  return /^(?:queued|queueing|queuing|running|waiting|processing|thinking|done|ready|进行中|思考中|生成中|排队中|等待中|任务中断|已中断|已完成|完成|请稍等)(?:\s+(?:queued|queueing|queuing|running|waiting|processing|thinking|done|ready|进行中|思考中|生成中|排队中|等待中|任务中断|已中断|已完成|完成|请稍等))*$/.test(withoutTime);
}

function isQueueProbeCommandText(value) {
  const normalized = normalizeQueueProbeText(value);
  if (!normalized) return false;
  const prefixMatch = normalized.match(/^(wait\s+for\s+(?:the\s+)?(?:trae\s+)?queue|wait\s+for\s+queue)\b(.*)$/);
  if (prefixMatch && isQueueProbeStatusSuffix(prefixMatch[2])) return true;
  if (/^check\s+(?:the\s+)?(?:trae\s+)?queue(?:\s+status)?$/.test(normalized)) return true;
  if (/^queue\s+status$/.test(normalized)) return true;
  if (/^排队$/.test(normalized)) return true;
  if (/^等(?:待)?排队$/.test(normalized)) return true;
  if (/^等待\s*(?:trae)?\s*队列$/.test(normalized)) return true;
  if (/^现在\s*(?:已经)?\s*排(?:到|到了|上了)$/.test(normalized)) return true;
  if (/^排队中(?:\s*请稍等)?$/.test(normalized)) return true;
  if (/^测试排队$/.test(normalized)) return true;
  if (/^换一个排队更久的模型测试排队$/.test(normalized)) return true;
  return false;
}

function extractQueueProbePayloads(taskText) {
  const text = String(taskText || '');
  const payloads = [];
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const payloadIndex = lines.findIndex(line => /^##\s+User Command Payload$/i.test(line));
  if (payloadIndex >= 0) {
    for (const line of lines.slice(payloadIndex + 1)) {
      if (/^raw params:/i.test(line)) continue;
      payloads.push(line);
      break;
    }
  }
  const rawTaskMatch = text.match(/"task"\s*:\s*"([^"]{1,240})"/i);
  if (rawTaskMatch) payloads.push(rawTaskMatch[1]);
  return payloads;
}

function isGenericQueueProbeTask(taskText) {
  if (isQueueProbeCommandText(taskText)) return true;
  return extractQueueProbePayloads(taskText).some(isQueueProbeCommandText);
}

function isForeignQueueProbeText(value) {
  const normalized = normalizeQueueProbeText(value);
  if (!normalized) return false;
  if (isQueueProbeCommandText(normalized)) return true;
  return /^wait\s+for\s+(?:the\s+)?(?:trae\s+)?queue\b/.test(normalized)
    || /^wait\s+for\s+queue\b/.test(normalized)
    || /^等待\s*(?:trae)?\s*队列\b/.test(normalized)
    || /^排队中\b/.test(normalized);
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
  escapeJsString,
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
