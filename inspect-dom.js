'use strict';

const http = require('http');
const { WebSocket } = require('ws');

class CDPClient {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.ws = null; this.msgId = 0; this.pending = new Map(); }
  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.on('open', () => resolve()); this.ws.on('error', reject);
      this.ws.on('message', data => {
        const msg = JSON.parse(data.toString());
        if (msg.id && this.pending.has(msg.id)) { this.pending.get(msg.id)(msg); this.pending.delete(msg.id); }
      });
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.msgId;
      this.pending.set(id, msg => { if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result); });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.ws?.close(); }
}

async function _get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } }); }).on('error', reject);
  });
}

async function typeAndSend(client, text) {
  const { root } = await client.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.chat-input-v2-input-box-editable' });
  if (!nodeId) { console.log('No composer'); return; }
  
  await client.send('Runtime.evaluate', {
    expression: `document.querySelector('.chat-input-v2-input-box-editable').innerText = '${text.replace(/'/g, "\\'")}'`,
    returnByValue: true
  });
  await client.send('Runtime.evaluate', {
    expression: `document.querySelector('.chat-input-v2-input-box-editable').dispatchEvent(new InputEvent('input', {bubbles:true}))`,
    returnByValue: true
  });
  
  const { nodeId: btnId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'button.chat-input-v2-send-button' });
  if (btnId) {
    await client.send('DOM.click', { nodeId: btnId });
    console.log('Send clicked');
  }
}

async function getText(client, sel) {
  try {
    const { root } = await client.send('DOM.getDocument', { depth: -1 });
    const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
    if (!nodeId) return null;
    const r = await client.send('Runtime.evaluate', {
      expression: `document.querySelector('${sel.replace(/'/g, "\\'")}')?.textContent?.trim() || ''`,
      returnByValue: true
    });
    return r.result?.value || '';
  } catch { return null; }
}

async function pollTillText(client, sel, intervalMs, maxMs) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < maxMs) {
    const t = await getText(client, sel);
    if (t && t !== last) { console.log(`[${Date.now()-start}ms] ${sel}: "${t.slice(0,80)}"`); last = t; }
    if (t) return t;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return last;
}

async function main() {
  const targets = await _get('http://127.0.0.1:9222/json/list');
  const t = targets.find(x => x.title.includes('openclaw') && x.type === 'page');
  console.log('Target:', t?.title);

  const client = new CDPClient(t.webSocketDebuggerUrl);
  await client.connect();
  await client.send('DOM.enable');
  await client.send('Runtime.enable');

  const selectors = ['.assistant-chat-turn-content', '[data-role="assistant"]', '.assistant', '[class*="assistant"]', '[class*="activity"]'];
  
  console.log('\n=== BEFORE ===');
  for (const sel of selectors) {
    const t = await getText(client, sel);
    if (t) console.log(`FOUND ${sel}: "${t.slice(0,60)}"`);
    else console.log(`MISSING ${sel}`);
  }

  console.log('\n=== SENDING ===');
  await typeAndSend(client, '1+1等于几');

  console.log('\n=== POLLING 20s ===');
  const results = await Promise.all(selectors.map(sel => pollTillText(client, sel, 1000, 20000).then(r => ({ sel, text: r }))));
  for (const { sel, text } of results) {
    if (text) console.log(`\nRESULT ${sel}: "${text.slice(0,200)}"`);
    else console.log(`TIMEOUT ${sel}`);
  }

  await client.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
