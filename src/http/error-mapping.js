'use strict';

/**
 * Map TraeCNAutomationError (and bare Error) to HTTP status codes.
 *
 * Until this module existed, every automation error from a driver collapsed
 * to 502 Bad Gateway in the gateway's catch-all (gateway.js _handleRequestImpl).
 * That hid real client-side problems (bad selectors, review gates) behind a
 * generic "upstream failure" status. Each code here chooses the most accurate
 * status so SDKs and CLIs can react appropriately.
 *
 * Adding a code? Pick the smallest status that conveys intent:
 *   400 — caller-provided input invalid (INVALID_INPUT)
 *   404 — well-formed request, but the target doesn't exist (SELECTOR_NOT_FOUND, TARGET_NOT_FOUND)
 *   409 — request valid, but blocked by policy/state (REVIEW_GATE_BLOCKED,
 *         OPERATION_CONFIRMATION_REQUIRED, INVALID_SOLO_CHAT_QUERY)
 *   502 — TraeCN itself produced an unexpected result
 *   503 — TraeCN or CDP unavailable right now (CONNECTION_FAILED, CDP_DISCONNECTED,
 *         RECOVERY_FAILED, CDP_NOT_CONNECTED)
 *   504 — TraeCN took too long (RESPONSE_TIMEOUT, CDP_TIMEOUT, WEBHOOK_FAILED)
 */

const CODE_TO_STATUS = Object.freeze({
  // 400 — caller did something wrong
  INVALID_INPUT: 400,

  // 404 — request shape is fine, but target is missing
  SELECTOR_NOT_FOUND: 404,
  TARGET_NOT_FOUND: 404,

  // 409 — request valid but blocked by policy/state
  REVIEW_GATE_BLOCKED: 409,
  WINDOW_NOT_VISIBLE: 409,
  OPERATION_CONFIRMATION_REQUIRED: 409,
  INVALID_SOLO_CHAT_QUERY: 409,
  PROJECT_NOT_OPEN: 409,

  // 502 — TraeCN said something we didn't expect
  COMPOSER_FOCUS_FAILED: 502,
  COMPOSER_INPUT_FAILED: 502,
  FRESH_CHAT_FAILED: 502,
  SOLO_CHAT_SWITCH_FAILED: 502,
  SESSION_PREPARE_FAILED: 502,
  SEND_FAILED: 502,

  // 503 — bridge-side resources missing/unavailable
  CONNECTION_FAILED: 503,
  CDP_NOT_CONNECTED: 503,
  CDP_DISCONNECTED: 503,
  RECOVERY_FAILED: 503,
  TASK_STORE_UNAVAILABLE: 503,
  WORKSPACE_CONTEXT_UNAVAILABLE: 503,

  // 504 — timeout-class
  RESPONSE_TIMEOUT: 504,
  CDP_TIMEOUT: 504,
  WEBHOOK_FAILED: 504,
});

const DEFAULT_STATUS = 502;
const FALLBACK_BY_NAME = Object.freeze({
  HttpError: (err) => (Number.isInteger(err.statusCode) ? err.statusCode : 500),
  TraeCNAutomationError: (err) => CODE_TO_STATUS[err.code] || DEFAULT_STATUS,
});

/**
 * Resolve an HTTP status code from any thrown value.
 * @param {*} err
 * @returns {number}
 */
function errorToHttpStatus(err) {
  if (!err) return 500;
  if (Number.isInteger(err.statusCode)) return err.statusCode;
  if (typeof err.status === 'number') return err.status;
  const mapper = FALLBACK_BY_NAME[err.name];
  if (mapper) return mapper(err);
  return 500;
}

/**
 * Produce a JSON-safe error body. The message is included; the name+code
 * are surfaced so the client can branch on them without parsing prose.
 * @param {*} err
 * @returns {{error: string, code?: string, details?: object}}
 */
function errorToBody(err) {
  if (!err) return { error: 'Internal server error' };
  if (err.name === 'TraeCNAutomationError') {
    return { error: err.message, code: err.code, details: err.details || {} };
  }
  if (Number.isInteger(err.statusCode) || err.name === 'HttpError') {
    return { error: err.message, code: err.code };
  }
  // Bare Error: never leak message/stack/details to clients — internal
  // driver failures often contain filesystem paths, selector names, or
  // CDP internals. The real message is already logged server-side at the
  // catch-all in gateway.js.
  return { error: 'Internal server error' };
}

/**
 * Return a single safe string message for an error, applying the same
 * disclosure rules as errorToBody. Use this for fields that store a
 * plain string (e.g. `task.error`, `batch.results[].error`) instead of
 * an error body object.
 * @param {*} err
 * @returns {string}
 */
function safeErrorMessage(err) {
  if (!err) return 'Internal server error';
  if (err.name === 'TraeCNAutomationError' ||
      Number.isInteger(err.statusCode) ||
      err.name === 'HttpError') {
    return err.message || 'Internal server error';
  }
  return 'Internal server error';
}

module.exports = {
  CODE_TO_STATUS,
  DEFAULT_STATUS,
  errorToHttpStatus,
  errorToBody,
  safeErrorMessage,
};
