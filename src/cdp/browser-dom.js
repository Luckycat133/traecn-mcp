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
  // Use Runtime.evaluate instead of DOM.querySelector for VS Code webview compatibility
  const result = await client.send('Runtime.evaluate', {
    expression: `document.querySelector('${selector.replace(/'/g, "\\'")}') !== null`,
    returnByValue: true
  });
  return result.result?.value ? selector : null;
}

async function querySelectorAll(client, selector) {
  // Use Runtime.evaluate instead of DOM.querySelectorAll
  const result = await client.send('Runtime.evaluate', {
    expression: `document.querySelectorAll('${selector.replace(/'/g, "\\'")}').length`,
    returnByValue: true
  });
  const count = result.result?.value || 0;
  return count > 0 ? Array(count).fill(0).map((_, i) => i) : [];
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
  const objectId = await _getNodeObjectId(client, nodeId);
  await client.send('Runtime.callFunctionOn', {
    functionDeclaration: `function() {
      this.focus();
      var sel = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(this);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('delete', false, null);
      document.execCommand('insertText', false, ${JSON.stringify(text)});
    }`,
    objectId
  });
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
  // Use Runtime.evaluate in batch to avoid multiple round-trips
  const selList = selectors.map(s => `'${s.replace(/'/g, "\\'")}'`).join(', ');
  const result = await client.send('Runtime.evaluate', {
    expression: `(function() { var sels = [${selList}]; for (var i = 0; i < sels.length; i++) { var el = document.querySelector(sels[i]); if (el && el.offsetParent !== null) { return { found: true, selector: sels[i] }; } } return { found: false }; })()`,
    returnByValue: true
  });
  const info = result.result?.value || {};
  if (info.found) {
    return { matchedSelector: info.selector };
  }
  return null;
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
  DomCache
};
