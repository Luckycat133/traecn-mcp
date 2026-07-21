'use strict';

/**
 * Shared helpers for the handlers in this directory.
 *
 * Two recurring patterns are consolidated here:
 *
 * 1. Request validation rejection — handlers repeatedly end with
 *    `return ctx._json(req, res, { error: '<message>' }, <status>)` when a
 *    body field is missing or malformed. `rejectBadRequest` keeps that exact
 *    shape; the caller passes the per-site message (and optional extra body
 *    fields) through verbatim, so error payloads stay byte-identical.
 *
 * 2. Driver capability guards — handlers repeatedly probe
 *    `typeof ctx.driver.X === 'function'` to (a) pick a ternary fallback,
 *    (b) read a boolean support flag, or (c) bail out with a 501 error body.
 *    `hasDriverCapability` covers (a) and (b); `requireDriverCapability`
 *    covers (c) while preserving each site's distinct error payload.
 *
 * These helpers are internal to src/http/handlers/ — they are not re-exported
 * through any handler module's public surface and do not change behavior.
 */

/**
 * Send a JSON rejection for an invalid request and return the result so the
 * caller can `return rejectBadRequest(...)`. The `message` (and any
 * `extraFields`) are passed through untouched — each call site keeps its own
 * wording. Defaults to status 400, which is what every current caller uses.
 */
function rejectBadRequest(req, res, ctx, message, extraFields = null, statusCode = 400) {
  return ctx._json(req, res, { error: message, ...extraFields }, statusCode);
}

/**
 * Return true when the connected driver exposes method `name`. Equivalent to
 * the inline `typeof ctx.driver[name] === 'function'` probes previously
 * scattered across handlers. Used both for ternary fallbacks and for
 * boolean support flags.
 */
function hasDriverCapability(ctx, name) {
  return typeof ctx.driver[name] === 'function';
}

/**
 * Guard form for "method must exist, otherwise reply with an error".
 * Returns true when the capability is present. When missing, sends
 * `{ error: message, ...extraFields }` with `statusCode` (default 501) and
 * returns false so the caller can `return` early. Error payloads are
 * supplied per call site and remain byte-identical to the previous inline
 * responses.
 */
function requireDriverCapability(req, res, ctx, name, message, extraFields = null, statusCode = 501) {
  if (hasDriverCapability(ctx, name)) {
    return true;
  }
  ctx._json(req, res, { error: message, ...extraFields }, statusCode);
  return false;
}

module.exports = { rejectBadRequest, hasDriverCapability, requireDriverCapability };
