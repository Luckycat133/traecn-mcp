'use strict';

class TraeCNAutomationError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = 'TraeCNAutomationError';
    this.code = code;
    this.details = details || {};
  }

  // ── 4xx — caller did something invalid or blocked ────────────────────

  static invalidInput(field, value, reason) {
    return new TraeCNAutomationError(
      `Invalid input for ${field}: ${reason || 'rejected'}`,
      'INVALID_INPUT',
      { field, value, reason }
    );
  }

  static reviewGateBlocked(reason) {
    return new TraeCNAutomationError(
      `Review gate blocked action: ${reason}`,
      'REVIEW_GATE_BLOCKED',
      { reason }
    );
  }

  static confirmationRequired(confirmationId, command, params) {
    return new TraeCNAutomationError(
      `Operation '${command}' requires explicit confirmation`,
      'OPERATION_CONFIRMATION_REQUIRED',
      { confirmationId, command, params }
    );
  }

  static soloChatQueryInvalid(reason) {
    return new TraeCNAutomationError(
      `Solo chat query rejected: ${reason}`,
      'INVALID_SOLO_CHAT_QUERY',
      { reason }
    );
  }

  static composerFocusFailed(cause) {
    return new TraeCNAutomationError(
      `Failed to focus composer: ${cause}`,
      'COMPOSER_FOCUS_FAILED',
      { cause: String(cause) }
    );
  }

  static composerInputFailed(cause) {
    return new TraeCNAutomationError(
      `Failed to set composer text: ${cause}`,
      'COMPOSER_INPUT_FAILED',
      { cause: String(cause) }
    );
  }

  static freshChatFailed(cause) {
    return new TraeCNAutomationError(
      `Failed to open a fresh chat: ${cause}`,
      'FRESH_CHAT_FAILED',
      { cause: String(cause) }
    );
  }

  static soloChatSwitchFailed(cause) {
    return new TraeCNAutomationError(
      `Failed to switch Solo chat: ${cause}`,
      'SOLO_CHAT_SWITCH_FAILED',
      { cause: String(cause) }
    );
  }

  // ── 5xx — something went wrong in the bridge / driver / TraeCN ──────

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

  static cdpTimeout(cause, timeoutMs) {
    return new TraeCNAutomationError(
      `CDP method timed out${timeoutMs ? ` after ${timeoutMs}ms` : ''}: ${cause}`,
      'CDP_TIMEOUT',
      { cause: String(cause), timeoutMs }
    );
  }

  static cdpDisconnected(reason) {
    return new TraeCNAutomationError(
      `CDP connection lost: ${reason}`,
      'CDP_DISCONNECTED',
      { reason }
    );
  }

  static cdpNotConnected() {
    return new TraeCNAutomationError(
      'CDP client is not connected',
      'CDP_NOT_CONNECTED',
      {}
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

  static webhookFailed(url, statusCode, body) {
    return new TraeCNAutomationError(
      `Webhook delivery failed (${statusCode}): ${url}`,
      'WEBHOOK_FAILED',
      { url, statusCode, body: typeof body === 'string' ? body.slice(0, 1024) : body }
    );
  }

  static recoveryFailed(cause) {
    return new TraeCNAutomationError(
      `TraeCN recovery failed: ${cause}`,
      'RECOVERY_FAILED',
      { cause: String(cause) }
    );
  }
}

const TraeAutomationError = TraeCNAutomationError;

module.exports = { TraeCNAutomationError, TraeAutomationError };
