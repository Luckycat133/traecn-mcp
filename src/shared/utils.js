'use strict';

function getEnvWithFallback(traecnKey, traeKey, defaultValue) {
  return process.env[traecnKey] || process.env[traeKey] || defaultValue;
}

function parseSelectors(envValue, defaults) {
  if (envValue) {
    return envValue.split(',').map(s => s.trim()).filter(Boolean);
  }
  return defaults;
}

function parsePositiveInt(value, defaultValue) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return parsed;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeJsString(str) {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// Safe JSON-stringify wrapper for injecting values into browser JS strings.
// Returns a JS-literal string (including quotes). Returns empty string for unsafe input.
function safeJsValue(value) {
  if (typeof value !== 'string') return String(value);
  try {
    const encoded = JSON.stringify(value);
    // Block strings containing characters that could break out of the JS string context
    if (/[<>\x00-\x1f]/.test(value)) return '';
    return encoded;
  } catch {
    return '';
  }
}

module.exports = { getEnvWithFallback, parseSelectors, parsePositiveInt, sleep, escapeJsString, safeJsValue };
