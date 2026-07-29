'use strict';

const DOM_DOC_CACHE_TTL = 2000;

class DomCache {
  constructor() {
    this._doc = null;
    this._docTs = 0;
  }

  async getDocument(client) {
    const now = Date.now();
    if (this._doc && now - this._docTs < DOM_DOC_CACHE_TTL) {
      return this._doc;
    }
    const { root } = await client.send('DOM.getDocument', { depth: -1 });
    this._doc = root;
    this._docTs = now;
    return root;
  }

  invalidate() {
    this._doc = null;
    this._docTs = 0;
  }
}

const _globalCache = new DomCache();

async function querySelector(client, selector) {
  const root = await _globalCache.getDocument(client);
  const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  return nodeId || null;
}

async function querySelectorAll(client, selector) {
  const root = await _globalCache.getDocument(client);
  const { nodeIds } = await client.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector });
  return nodeIds || [];
}

async function getTextNodeContent(client, nodeId) {
  const { children } = await client.send('DOM.describeNode', { nodeId });
  if (!children) return '';

  let text = '';
  for (const child of children) {
    if (child.nodeValue) {
      text += child.nodeValue;
    }
    if (child.children) {
      text += await _collectText(client, child);
    }
  }
  return text;
}

async function _collectText(client, node) {
  let text = '';
  if (node.nodeValue) {
    text += node.nodeValue;
  }
  if (node.children) {
    for (const child of node.children) {
      text += await _collectText(client, child);
    }
  }
  return text;
}

async function getOuterHTML(client, nodeId) {
  const { outerHTML } = await client.send('DOM.getOuterHTML', { nodeId });
  return outerHTML;
}

async function getInnerText(client, nodeId) {
  try {
    const { result } = await client.send('Runtime.callFunctionOn', {
      functionDeclaration: 'function() { return this.innerText; }',
      objectId: await _getNodeObjectId(client, nodeId),
      returnByValue: true
    });
    return result.value || '';
  } catch {
    _globalCache.invalidate();
    return '';
  }
}

async function _getNodeObjectId(client, nodeId) {
  const { object } = await client.send('DOM.resolveNode', { nodeId });
  return object.objectId;
}

async function focusNode(client, nodeId) {
  await client.send('DOM.focus', { nodeId });
}

async function clickNode(client, nodeId) {
  const objectId = await _getNodeObjectId(client, nodeId);
  await client.send('Runtime.callFunctionOn', {
    functionDeclaration: 'function() { this.click(); }',
    objectId
  });
}

async function typeText(client, nodeId, text) {
  await focusNode(client, nodeId);

  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    modifiers: 2
  });
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    modifiers: 2
  });

  for (const char of text) {
    await client.send('Input.dispatchKeyEvent', {
      type: 'char',
      text: char
    });
  }
}

async function setInputValue(client, nodeId, value) {
  const objectId = await _getNodeObjectId(client, nodeId);
  await client.send('Runtime.callFunctionOn', {
    functionDeclaration: `function() { this.value = ''; }`,
    objectId
  });
  await client.send('Runtime.callFunctionOn', {
    functionDeclaration: `function() { this.value = ${JSON.stringify(value)}; this.dispatchEvent(new Event('input', { bubbles: true })); }`,
    objectId
  });
}

async function setContentEditableText(client, nodeId, text) {
  await focusNode(client, nodeId);
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    modifiers: 4
  });
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    modifiers: 4
  });
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Backspace',
    code: 'Backspace',
    windowsVirtualKeyCode: 8
  });
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Backspace',
    code: 'Backspace',
    windowsVirtualKeyCode: 8
  });
  await client.send('Input.insertText', { text });
  _globalCache.invalidate();
}

async function pressEnter(client) {
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13
  });
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13
  });
}

async function findFirstMatching(client, selectors) {
  for (const selector of selectors) {
    const nodeId = await querySelector(client, selector);
    if (!nodeId) continue;

    const visible = await isVisible(client, nodeId);
    if (visible) {
      return { nodeId, matchedSelector: selector };
    }
  }
  return null;
}

async function isVisible(client, nodeId) {
  try {
    const objectId = await _getNodeObjectId(client, nodeId);
    const { result } = await client.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() {
        var rect = this.getBoundingClientRect();
        var style = window.getComputedStyle(this);
        return !!(rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none');
      }`,
      returnByValue: true
    });
    return !!result.value;
  } catch {
    _globalCache.invalidate();
    return false;
  }
}

/**
 * Evaluate a function in the page context and return the by-value result.
 *
 * Wraps `Runtime.evaluate` with safe defaults:
 *   - `awaitPromise: true` so the function can return a Promise
 *   - `returnByValue: true` so callers get a JSON-serializable value
 *     instead of an objectId they have to release
 *   - `exceptionDetails` is surfaced as a thrown error so callers don't
 *     silently consume page-side exceptions
 *
 * `args` is forwarded as the trailing arguments to the function expression,
 * matching CDP's `Runtime.evaluate#arguments` shape. They must be JSON-safe.
 */
async function evaluate(client, fnDecl, args = []) {
  const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
    expression: `(${fnDecl})(${args.map(a => JSON.stringify(a)).join(', ')})`,
    returnByValue: true,
    awaitPromise: true
  });
  if (exceptionDetails) {
    const message = exceptionDetails.exception?.description
      || exceptionDetails.text
      || 'Runtime.evaluate threw';
    throw new Error(`[browser-dom.evaluate] ${message}`);
  }
  return result.value;
}

/**
 * Click the first element matching any of `selectors` whose visible text
 * matches `text`. Returns true if a click happened, false otherwise.
 *
 * `text` may be a string (substring, case-insensitive) or a RegExp.
 * Implementation evaluates a single helper function in the page so the
 * loop runs locally instead of round-tripping per node.
 */
async function clickByText(client, selectors, text) {
  const fnDecl = `function() {
    const selectors = arguments[0];
    const pattern = arguments[1];
    const matcher = (pattern instanceof RegExp)
      ? (s) => pattern.test(s)
      : (s) => s.toLowerCase().includes(String(pattern).toLowerCase());
    for (const sel of selectors) {
      const nodes = document.querySelectorAll(sel);
      for (const node of nodes) {
        const text = (node.innerText || node.textContent || '').trim();
        if (!matcher(text)) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const style = window.getComputedStyle(node);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        node.click();
        return true;
      }
    }
    return false;
  }`;
  return evaluate(client, fnDecl, [selectors, typeof text === 'string' ? text : text.source]);
}

/**
 * Like `clickByText` but invokes `window.__radixClick(node)` instead of
 * the native `.click()` method.
 *
 * Used by driver code that targets Radix UI primitives (which require a
 * synthetic event sequence rather than the browser's native click
 * dispatch). The element visibility / text-match loop is otherwise
 * identical to `clickByText`.
 *
 * Returns true if a click happened, false otherwise.
 */
async function clickByTextRadix(client, selectors, text) {
  const fnDecl = `function() {
    const selectors = arguments[0];
    const pattern = arguments[1];
    if (typeof window.__radixClick !== 'function') return 'radix_click_unavailable';
    const matcher = (pattern instanceof RegExp)
      ? (s) => pattern.test(s)
      : (s) => s.toLowerCase().includes(String(pattern).toLowerCase());
    for (const sel of selectors) {
      const nodes = document.querySelectorAll(sel);
      for (const node of nodes) {
        const text = (node.innerText || node.textContent || '').trim();
        if (!matcher(text)) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const style = window.getComputedStyle(node);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        try { window.__radixClick(node); } catch (e) { return 'radix_click_failed: ' + e.message; }
        return true;
      }
    }
    return false;
  }`;
  return evaluate(client, fnDecl, [selectors, typeof text === 'string' ? text : text.source]);
}

/**
 * Evaluate a function in the page and parse the returned value as JSON.
 *
 * The legacy driver pattern is to `JSON.stringify(...)` inside the
 * expression and `JSON.parse(result.value)` on the Node side. This
 * helper consolidates that round-trip: pass a function that returns a
 * JSON-stringifiable object, and we hand back the parsed value.
 *
 * Throws if the value is not a string or if parsing fails.
 */
async function evaluateJSON(client, fnDecl, args = []) {
  const raw = await evaluate(client, fnDecl, args);
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); }
  catch (e) {
    throw new Error(`[browser-dom.evaluateJSON] failed to parse: ${e.message}`, { cause: e });
  }
}

// JS source injected into the page so radix-click support is available
// before the first attempt. Equivalent to the legacy `_ensureClickHelper`
// in the drivers; centralised here so callers don't need to call two
// helpers in the right order.
const RADIX_CLICK_HELPER_SOURCE = `function() {
  if (window.__radixClick) return 'already_present';
  window.__radixClick = function(el) {
    if (!el) return;
    el.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, cancelable: true, button: 0}));
    el.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true, button: 0}));
    el.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, cancelable: true, button: 0}));
    el.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, button: 0}));
  };
  return 'installed';
}`;

/**
 * clickByText with extended matching options.
 *
 * The default `clickByText` and `clickByTextRadix` helpers only support a
 * single list of selectors with substring/RegExp text match. Drivers
 * often need:
 *   - a primary selector list plus a fallback list (e.g. try
 *     `.settings-sidebar-menu-item` first, then `[class*="sidebar"]`),
 *   - control over which text-extraction strategy to consider first
 *     (`.text` child, `aria-label`, `title`),
 *   - exact-match semantics instead of substring,
 *   - native click vs radix click,
 *   - optional polling for the element to appear.
 *
 * Returns a structured result so callers can distinguish "not found"
 * from `radix_click_unavailable` from `radix_click_failed: ...` — they
 * drive different recovery paths in the drivers.
 *
 * @param {object} client
 * @param {string[]} selectors       primary selectors to try
 * @param {string|RegExp} text       text pattern (substring, exact, or RegExp)
 * @param {object} [options]
 * @param {string[]} [options.fallbackSelectors]   additional selectors tried after primary
 * @param {string[]} [options.strategies=['text','aria-label','title']]
 *        ordered list of text-extraction strategies; first non-empty wins per node
 * @param {boolean} [options.exact=false]         require exact match (no substring)
 * @param {boolean} [options.trim=true]           trim text before matching
 * @param {'native'|'radix'} [options.click='radix']  click implementation
 * @param {number} [options.timeoutMs]             if > 0, poll for element to appear
 * @returns {Promise<{ok: boolean, matchedText?: string, matchedSelector?: string, reason?: string}>}
 */
async function clickByTextEx(client, selectors, text, options = {}) {
  const {
    fallbackSelectors = [],
    strategies = ['text', 'aria-label', 'title'],
    exact = false,
    trim = true,
    click = 'radix',
    timeoutMs = 0
  } = options;

  const allSelectors = [...selectors, ...fallbackSelectors];

  const patternSource = (text instanceof RegExp)
    ? text.source
    : String(text);

  const isRegex = text instanceof RegExp;

  const fnDecl = `function() {
    const selectors = arguments[0];
    const pattern = arguments[1];
    const isRegex = arguments[2];
    const strategies = arguments[3];
    const exact = arguments[4];
    const trim = arguments[5];
    const clickMode = arguments[6];

    const radixAvailable = (clickMode === 'radix') && (typeof window.__radixClick === 'function');

    function matchOne(haystack) {
      if (typeof haystack !== 'string') return false;
      const candidate = trim ? haystack.trim() : haystack;
      if (isRegex) {
        return new RegExp(pattern).test(candidate);
      }
      if (exact) return candidate === pattern;
      return candidate.toLowerCase().includes(pattern.toLowerCase());
    }

    function extractText(node) {
      for (const strat of strategies) {
        let value = '';
        if (strat === 'text') {
          // Prefer a "text" child (matches legacy settings-driver) before
          // falling back to the node own textContent / innerText.
          const child = node.querySelector && node.querySelector('.text');
          value = child
            ? (child.textContent || '')
            : (node.textContent || node.innerText || '');
        } else if (strat === 'aria-label') {
          value = node.getAttribute && (node.getAttribute('aria-label') || '');
        } else if (strat === 'title') {
          value = node.title || (node.getAttribute && node.getAttribute('title')) || '';
        }
        if (value && String(value).trim() !== '') {
          return trim ? String(value).trim() : String(value);
        }
      }
      return '';
    }

    for (const sel of selectors) {
      const nodes = document.querySelectorAll(sel);
      for (const node of nodes) {
        const text = extractText(node);
        if (!matchOne(text)) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const style = window.getComputedStyle(node);
        if (style.visibility === 'hidden' || style.display === 'none') continue;

        if (clickMode === 'radix') {
          if (!radixAvailable) return { ok: false, reason: 'radix_click_unavailable' };
          try { window.__radixClick(node); }
          catch (e) { return { ok: false, reason: 'radix_click_failed: ' + (e && e.message || e) }; }
        } else {
          node.click();
        }
        return { ok: true, matchedText: text, matchedSelector: sel };
      }
    }
    return { ok: false, reason: 'not_found' };
  }`;

  // Auto-install __radixClick when caller asked for radix click mode.
  if (click === 'radix') {
    await evaluate(client, RADIX_CLICK_HELPER_SOURCE, []);
  }

  const baseArgs = [allSelectors, patternSource, isRegex, strategies, exact, trim, click];

  if (!timeoutMs || timeoutMs <= 0) {
    return evaluate(client, fnDecl, baseArgs);
  }

  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const result = await evaluate(client, fnDecl, baseArgs);
    if (result && result.ok) return result;
    // Hard-fail fast for radix click problems — no point polling for a
    // selector that exists if the click helper is missing or throwing.
    if (result && result.reason && result.reason !== 'not_found') return result;
    last = result;
    await new Promise(r => setTimeout(r, 100));
  }
  return last || { ok: false, reason: 'timeout' };
}

/**
 * Click the first element whose extracted text passes a custom predicate.
 *
 * Used by drivers whose match logic doesn't fit the substring/RegExp
 * shape of clickByText (e.g. matching against text + title + aria-label
 * simultaneously via a JS expression).
 *
 * `predicateSource` is the JS source of a predicate
 * `(text, title, aria) => boolean`. It is inlined into the page-side
 * function and must be a pure expression — no closures over Node-side
 * state.
 *
 * @param {object} client
 * @param {string} predicateSource  JS source of predicate: (text, title, aria) => boolean
 * @param {object} [options]
 * @param {string[]} [options.selectors]           selectors to scan
 * @param {string[]} [options.fallbackSelectors]   additional selectors tried after primary
 * @param {string[]} [options.strategies=['text','aria-label','title']]
 * @param {'native'|'radix'} [options.click='radix']
 * @returns {Promise<{ok: boolean, matchedText?: string, matchedSelector?: string, reason?: string}>}
 */
async function clickByPredicate(client, predicateSource, options = {}) {
  const {
    selectors = [],
    fallbackSelectors = [],
    strategies = ['text', 'aria-label', 'title'],
    click = 'radix'
  } = options;

  const allSelectors = [...selectors, ...fallbackSelectors];

  const fnDecl = `function() {
    const selectors = arguments[0];
    const predicate = arguments[1];
    const strategies = arguments[2];
    const clickMode = arguments[3];

    const radixAvailable = (clickMode === 'radix') && (typeof window.__radixClick === 'function');

    function extractParts(node) {
      const parts = { text: '', title: '', aria: '' };
      for (const strat of strategies) {
        if (strat === 'text' && !parts.text) {
          const child = node.querySelector && node.querySelector('.text');
          parts.text = ((child ? child.textContent : node.textContent) || node.innerText || '').trim();
        } else if (strat === 'aria-label' && !parts.aria) {
          parts.aria = (node.getAttribute && node.getAttribute('aria-label') || '').trim();
        } else if (strat === 'title' && !parts.title) {
          parts.title = (node.title || (node.getAttribute && node.getAttribute('title')) || '').trim();
        }
      }
      return parts;
    }

    for (const sel of selectors) {
      const nodes = document.querySelectorAll(sel);
      for (const node of nodes) {
        const parts = extractParts(node);
        let matched = false;
        try { matched = predicate(parts.text, parts.title, parts.aria); }
        catch (e) { return { ok: false, reason: 'predicate_threw: ' + (e && e.message || e) }; }
        if (!matched) continue;

        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const style = window.getComputedStyle(node);
        if (style.visibility === 'hidden' || style.display === 'none') continue;

        if (clickMode === 'radix') {
          if (!radixAvailable) return { ok: false, reason: 'radix_click_unavailable' };
          try { window.__radixClick(node); }
          catch (e) { return { ok: false, reason: 'radix_click_failed: ' + (e && e.message || e) }; }
        } else {
          node.click();
        }
        return { ok: true, matchedText: parts.text, matchedSelector: sel };
      }
    }
    return { ok: false, reason: 'not_found' };
  }`;

  if (click === 'radix') {
    await evaluate(client, RADIX_CLICK_HELPER_SOURCE, []);
  }

  return evaluate(client, fnDecl, [allSelectors, predicateSource, strategies, click]);
}

module.exports = {
  querySelector,
  querySelectorAll,
  getTextNodeContent,
  getOuterHTML,
  getInnerText,
  focusNode,
  clickNode,
  typeText,
  setInputValue,
  setContentEditableText,
  pressEnter,
  findFirstMatching,
  evaluate,
  evaluateJSON,
  clickByText,
  clickByTextRadix,
  clickByTextEx,
  clickByPredicate,
  DomCache
};
