'use strict';

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
  if (typeof value !== 'string') return String(value);
  try {
    const encoded = JSON.stringify(value);
    if (/[<>\x00-\x1f]/.test(value)) return '';
    return encoded;
  } catch {
    return '';
  }
}

module.exports = {
  getEnvWithFallback,
  parseSelectors,
  parsePositiveInt,
  sleep,
  escapeJsString,
  safeJsValue
};
