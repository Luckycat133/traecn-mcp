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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeJsString(str) {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

module.exports = { getEnvWithFallback, parseSelectors, sleep, escapeJsString };
