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
  } catch(e) {
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
  clickByText,
  DomCache
};
