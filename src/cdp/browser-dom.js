'use strict';

async function querySelector(client, selector) {
  const { root } = await client.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await client.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector
  });
  return nodeId || null;
}

async function querySelectorAll(client, selector) {
  const { root } = await client.send('DOM.getDocument', { depth: -1 });
  const { nodeIds } = await client.send('DOM.querySelectorAll', {
    nodeId: root.nodeId,
    selector
  });
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
    // Node may have been removed/replaced — return empty to signal need for re-query
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
  // Use execCommand('insertText') which properly triggers beforeinput/input events
  // that Trae CN's Lexical editor listens to for enabling the send button
  await client.send('Runtime.callFunctionOn', {
    functionDeclaration: `function() {
      this.innerText = '';
      this.focus();
      document.execCommand('insertText', false, ${JSON.stringify(text)});
    }`,
    objectId
  });
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
    if (nodeId) {
      return { nodeId, matchedSelector: selector };
    }
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
  findFirstMatching
};
