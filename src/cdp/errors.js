'use strict';

class TraeCNAutomationError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = 'TraeCNAutomationError';
    this.code = code;
    this.details = details || {};
  }

  static connectionFailed(host, port, cause) {
    return new TraeCNAutomationError(
      `Failed to connect to TraeCN CDP at ${host}:${port}: ${cause}`,
      'CONNECTION_FAILED',
      { host, port, cause: String(cause) }
    );
  }

  static targetNotFound(criteria) {
    return new TraeCNAutomationError(
      `No TraeCN CDP target found matching: ${JSON.stringify(criteria)}`,
      'TARGET_NOT_FOUND',
      { criteria }
    );
  }

  static selectorNotFound(type, selectors) {
    return new TraeCNAutomationError(
      `No DOM element found for ${type} with selectors: ${selectors.join(', ')}`,
      'SELECTOR_NOT_FOUND',
      { type, selectors }
    );
  }

  static responseTimeout(timeoutMs) {
    return new TraeCNAutomationError(
      `TraeCN response timed out after ${timeoutMs}ms`,
      'RESPONSE_TIMEOUT',
      { timeoutMs }
    );
  }

  static sessionPrepareFailed(cause) {
    return new TraeCNAutomationError(
      `Failed to prepare TraeCN session: ${cause}`,
      'SESSION_PREPARE_FAILED',
      { cause: String(cause) }
    );
  }

  static sendFailed(cause) {
    return new TraeCNAutomationError(
      `Failed to send message to TraeCN: ${cause}`,
      'SEND_FAILED',
      { cause: String(cause) }
    );
  }
}

const TraeAutomationError = TraeCNAutomationError;

module.exports = { TraeCNAutomationError, TraeAutomationError };
