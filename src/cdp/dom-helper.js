'use strict';

/**
 * DOMHelper — encapsulates low-level DOM operations and element finding.
 * Extracted from DomDriver to reduce its responsibility count.
 */

const dom = require('./browser-dom');
const { safeJsValue } = require('../shared/utils');

class DOMHelper {
  constructor(client, config) {
    this.client = client;
    this.config = config;
  }

  // ── Click helper injection ─────────────────────────────────────────────

  /**
   * Inject `window.__enhancedClick` into the page so that repeated inline
   * click-dispatcher code can be replaced with a single function call.
   */
  async ensureClickHelper() {
    await this.client.send('Runtime.evaluate', {
      expression: `(function() {
        if (window.__enhancedClick) return;
        var normalize = function(text) {
          return String(text || '').trim();
        };
        window.__enhancedClick = function(targetText, normalizeText) {
          var candidates = Array.from(document.querySelectorAll('button, a, [role="button"], div, span'));
          if (normalizeText) {
            normalize = function(text) {
              return String(text || '').replace(/\\s+/g, ' ').trim();
            };
          }
          for (var i = 0; i < candidates.length; i++) {
            var el = candidates[i];
            var text = normalize(el.innerText || el.textContent || '');
            if (text !== targetText) continue;
            var style = window.getComputedStyle ? window.getComputedStyle(el) : null;
            var clickable = el.tagName === 'BUTTON' ||
              el.tagName === 'A' ||
              el.getAttribute('role') === 'button' ||
              (style && style.cursor === 'pointer');
            if (!clickable || el.disabled) continue;
            var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
            if (!rect || rect.width < 12 || rect.height < 12) continue;
            var cx = rect.x + rect.width / 2;
            var cy = rect.y + rect.height / 2;
            el.dispatchEvent(new PointerEvent('pointerdown', {
              bubbles: true, cancelable: true, composed: true,
              clientX: cx, clientY: cy, button: 0, buttons: 1, pointerType: 'mouse'
            }));
            el.dispatchEvent(new PointerEvent('pointerup', {
              bubbles: true, cancelable: true, composed: true,
              clientX: cx, clientY: cy, button: 0, buttons: 1, pointerType: 'mouse'
            }));
            el.dispatchEvent(new MouseEvent('click', {
              bubbles: true, cancelable: true, clientX: cx, clientY: cy
            }));
            if (typeof el.click === 'function') el.click();
            return { clicked: true, text: text };
          }
          return { clicked: false, text: targetText };
        };
      })()`,
      returnByValue: true
    });
  }

  /**
   * Click an element by its text content using the injected helper.
   */
  async clickElementByText(text, normalizeText = false) {
    await this.ensureClickHelper();
    const result = await this.client.send('Runtime.evaluate', {
      expression: `window.__enhancedClick(${safeJsValue(text)}, ${normalizeText})`,
      returnByValue: true
    });
    return result.result?.value || { clicked: false, text };
  }

  // ── Element finders ────────────────────────────────────────────────────

  async findComposer() {
    return dom.findFirstMatching(this.client, this.config.composerSelectors);
  }

  async findSendButton() {
    return dom.findFirstMatching(this.client, this.config.sendButtonSelectors);
  }

  async findResponseRegion() {
    const region = await dom.findFirstMatching(this.client, this.config.responseSelectors);
    if (region) return region;
    return dom.findFirstMatching(this.client, this.config.activitySelectors);
  }

  async findNewChatButton() {
    const soloBtn = await dom.findFirstMatching(this.client, this.config.newChatSelectors);
    if (soloBtn) return soloBtn;
    return dom.findFirstMatching(this.client, this.config.ideNewChatSelectors);
  }

  /**
   * Find mode tabs by selector; uses text matching to avoid false positives
   * from elements that match the selector but aren't mode tabs (e.g., editor tabs).
   */
  async findModeTabs() {
    const results = [];
    for (const selector of this.config.modeTabSelectors) {
      const nodeIds = await dom.querySelectorAll(this.client, selector);
      for (const nodeId of nodeIds) {
        const text = await dom.getInnerText(this.client, nodeId);
        const trimmed = (text || '').trim();
        if (trimmed && results.every(r => r.nodeId !== nodeId)) {
          results.push({ nodeId, selector, text: trimmed });
        }
      }
    }
    return results;
  }

  async findVisibleElementRuntime(selectors, options = {}) {
    if (!this.client || typeof this.client.send !== 'function') return null;
    const safeSelectors = safeJsValue(Array.isArray(selectors) ? selectors : []);
    const allowDisabled = options.allowDisabled === true;
    try {
      const result = await this.client.send('Runtime.evaluate', {
        expression: `
          (function() {
            var selectors = ${safeSelectors};
            function visible(el) {
              if (!el) return false;
              var rect = el.getBoundingClientRect();
              var style = window.getComputedStyle(el);
              return !!(rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden' && style.display !== 'none');
            }
            for (var i = 0; i < selectors.length; i++) {
              var el = document.querySelector(selectors[i]);
              if (!visible(el)) continue;
              var className = String(el.className || '');
              var disabled = !!(el.disabled || el.getAttribute('aria-disabled') === 'true' || /(?:^|\\s)disabled(?:\\s|$)/.test(className));
              if (disabled && !${allowDisabled ? 'true' : 'false'}) continue;
              return {
                matchedSelector: selectors[i],
                visible: true,
                disabled: disabled,
                text: (el.innerText || el.textContent || '').trim().slice(0, 120)
              };
            }
            return null;
          })()
        `,
        returnByValue: true
      });
      return result.result?.value || null;
    } catch (_) {
      return null;
    }
  }

  // ── DOM access wrappers ────────────────────────────────────────────────

  async getOuterHTML(nodeId) {
    return dom.getOuterHTML(this.client, nodeId);
  }

  async setContentEditableText(nodeId, text) {
    return dom.setContentEditableText(this.client, nodeId, text);
  }

  async setInputValue(nodeId, text) {
    return dom.setInputValue(this.client, nodeId, text);
  }

  async clickNode(nodeId) {
    return dom.clickNode(this.client, nodeId);
  }

  // ── Mouse / keyboard helpers ───────────────────────────────────────────

  async dispatchTrustedMouseClick(point, options = {}) {
    if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) return false;
    const x = Number(point.x);
    const y = Number(point.y);
    const button = options.button === 'right' ? 'right' : 'left';
    await this.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await this.client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      buttons: button === 'right' ? 2 : 1,
      clickCount: 1
    });
    await this.client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      buttons: 0,
      clickCount: 1
    });
    return true;
  }

  // ── Expression waiting ─────────────────────────────────────────────────

  async waitForExpression(expression, timeoutMs = 5000, pollMs = 200) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = await this.client.send('Runtime.evaluate', {
        expression,
        returnByValue: true
      });
      if (result.result?.value) return true;
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    return false;
  }

  // ── Runtime evaluate wrapper ───────────────────────────────────────────

  async evaluate(expression, options = {}) {
    const params = { expression, returnByValue: true, ...options };
    return this.client.send('Runtime.evaluate', params);
  }

  async evaluateValue(expression, options = {}) {
    const result = await this.evaluate(expression, options);
    return result.result?.value;
  }
}

module.exports = { DOMHelper };
