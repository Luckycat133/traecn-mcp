'use strict';

const { TraeCNAutomationError } = require('./errors');

/**
 * Shared JavaScript snippet that installs `window.__radixClick`. Radix UI
 * components (used by TraeCN's command palette, editor tabs, settings, etc.)
 * require a specific sequence of pointer/mouse events to register a "real"
 * click — a plain `el.click()` is not enough. This helper is injected once
 * per page via `Runtime.evaluate`.
 */
const RADIX_CLICK_INJECTION = `(function() {
  if (window.__radixClick) return;
  window.__radixClick = function(el) {
    if (!el) return;
    el.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, cancelable: true, button: 0}));
    el.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true, button: 0}));
    el.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, cancelable: true, button: 0}));
    el.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, button: 0}));
  };
})()`;

/**
 * Base class for CDP-based TraeCN automation drivers.
 *
 * Consolidates the shared lifecycle concerns that every driver needs:
 *  - holding a reference to the CDP `client`
 *  - holding a `config` object
 *  - late-binding a `CommandPaletteDriver` via `setPalette`
 *  - delegating commands to the palette via `_viaPalette`
 *  - injecting the `__radixClick` helper via `_ensureClickHelper`
 *  - small `Runtime.evaluate` / JSON.parse helpers used everywhere
 *
 * Subclasses are expected to call `super(client, config, deps)` and may
 * add extra fields from `deps` as needed.
 */
class BaseDriver {
  /**
   * @param {object} client - CDP session client (must implement `send`).
   * @param {object} [config={}] - Driver configuration.
   * @param {object} [deps={}] - Dependency bag. Recognized keys:
   *   @param {object} [deps.palette] - A `CommandPaletteDriver` instance.
   */
  constructor(client, config = {}, deps = {}) {
    this.client = client;
    this.config = config;
    this.palette = deps.palette || null;
  }

  /**
   * Late-bind or replace the `CommandPaletteDriver` used by this driver.
   *
   * @param {object} palette - A `CommandPaletteDriver` instance.
   */
  setPalette(palette) {
    this.palette = palette;
  }

  /**
   * Run a command through the bound `CommandPaletteDriver`.
   *
   * @param {string} commandId - VS Code command id (e.g. `workbench.action.files.save`).
   * @returns {Promise<*>} Resolves with whatever `palette.run` returns.
   * @throws {TraeCNAutomationError} When no palette has been bound. Code: `PALETTE_REQUIRED`.
   */
  _viaPalette(commandId) {
    if (!this.palette) {
      throw new TraeCNAutomationError(
        'CommandPaletteDriver is required for this operation',
        'PALETTE_REQUIRED',
        { commandId }
      );
    }
    return this.palette.run(commandId);
  }

  /**
   * Guard helper for drivers that need the palette but call a non-`run`
   * method (e.g. `palette.open()`). Throws the same `PALETTE_REQUIRED`
   * error as `_viaPalette` but does not dispatch the call.
   *
   * @param {string} commandId - Command id that would have been invoked.
   * @returns {object} The bound palette instance.
   * @throws {TraeCNAutomationError} When no palette has been bound.
   */
  _requirePalette(commandId) {
    if (!this.palette) {
      throw new TraeCNAutomationError(
        'CommandPaletteDriver is required for this operation',
        'PALETTE_REQUIRED',
        { commandId }
      );
    }
    return this.palette;
  }

  /**
   * Inject the `window.__radixClick` helper into the current page if it
   * has not been installed yet. Safe to call multiple times.
   *
   * @returns {Promise<void>}
   */
  async _ensureClickHelper() {
    await this.client.send('Runtime.evaluate', {
      expression: RADIX_CLICK_INJECTION,
      returnByValue: true
    });
  }

  /**
   * Thin wrapper around `Runtime.evaluate` with `returnByValue: true`.
   * Returns the raw JS value produced by the expression.
   *
   * @param {string} expression - JS expression to evaluate.
   * @returns {Promise<*>} The `result.result.value` field from the CDP response.
   */
  async _eval(expression) {
    const r = await this.client.send('Runtime.evaluate', {
      expression,
      returnByValue: true
    });
    return r && r.result ? r.result.value : undefined;
  }

  /**
   * Parse a JSON string returned by `Runtime.evaluate`, returning
   * `fallback` when the value is not valid JSON.
   *
   * @param {string} value - Raw string (usually `r.result.value`).
   * @param {*} fallback - Value to return when parsing fails.
   * @returns {*} Parsed value or `fallback`.
   */
  _parseResult(value, fallback) {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
}

module.exports = {
  BaseDriver,
  RADIX_CLICK_INJECTION
};
