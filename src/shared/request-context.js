'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');

/**
 * Per-request context propagated via Node.js AsyncLocalStorage.
 *
 * Why AsyncLocalStorage?
 * - Built into Node ≥14, zero dependencies.
 * - Lets deeply nested helpers (CDP driver, plugins, audit logger, metrics)
 *   read requestId/sessionId/authKeyId without explicit threading.
 *
 * Usage:
 *   const ctx = require('./request-context');
 *   await ctx.run({ requestId: 'r-123' }, async () => { ... });
 *   const id = ctx.getRequestId(); // 'r-123' inside the run() callback
 */

const storage = new AsyncLocalStorage();

function generateRequestId() {
  // 12-byte random ID, hex-encoded, prefixed for grep-ability in logs.
  return `req-${crypto.randomBytes(12).toString('hex')}`;
}

/**
 * Run an async callback inside a request scope. The provided context becomes
 * visible to any code that calls `getContext()` further down the call stack.
 *
 * @param {object} context - { requestId?, sessionId?, authKeyId?, ... }
 * @param {Function} fn - Async function to execute.
 * @returns {*} The return value of `fn`.
 */
function run(context, fn) {
  const merged = { requestId: generateRequestId(), ...context };
  return storage.run(merged, fn);
}

function getContext() {
  return storage.getStore() || null;
}

function getRequestId() {
  const ctx = storage.getStore();
  return ctx ? ctx.requestId : null;
}

function get(key) {
  const ctx = storage.getStore();
  return ctx ? ctx[key] : undefined;
}

/**
 * Merge additional fields into the active context. Returns true if a context
 * was active (mutation succeeded) and false otherwise.
 */
function merge(extra) {
  const ctx = storage.getStore();
  if (!ctx) return false;
  Object.assign(ctx, extra);
  return true;
}

module.exports = {
  generateRequestId,
  run,
  getContext,
  getRequestId,
  get,
  merge,
};