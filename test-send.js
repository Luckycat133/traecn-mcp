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
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { reject(new Error('not connected')); return; }
      const id = ++this.msgId;
      this.pending.set(id, msg => { if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result); });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout')); } }, 30000);
    });
  }
  close() { this.ws?.close(); }
}
async function _get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } }); }).on('error', reject);
  });
}
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function main() {
  const targets = await _get('http://127.0.0.1:9222/json/list');
  const page = targets.find(x => x.type === 'page');
  console.log('Page:', page?.title);
  const client = new CDPClient(page.webSocketDebuggerUrl);
  await client.connect();
  await client.send('DOM.enable');
  await client.send('Runtime.enable');

  // Check UI
  const ui = await client.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      composer: !!document.querySelector('.chat-input-v2-input-box-editable'),
      sendBtn: !!document.querySelector('button.chat-input-v2-send-button'),
      btnDisabled: document.querySelector('button.chat-input-v2-send-button')?.disabled,
      textContent: document.querySelector('.chat-input-v2-input-box-editable')?.textContent,
      responseText: document.querySelector('[data-role="assistant"]')?.textContent?.trim().slice(0, 100)
    })`,
    returnByValue: true
  });
  console.log('UI:', JSON.parse(ui.result?.value || '{}'));

  // Try new chat
  console.log('\nTrying newChat...');
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'n', code: 'KeyN', modifiers: 256 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'n', code: 'KeyN', modifiers: 256 });
  await sleep(2000);

  // Check response region
  const afterNewChat = await client.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      textContent: document.querySelector('.chat-input-v2-input-box-editable')?.textContent,
      responseText: document.querySelector('[data-role="assistant"]')?.textContent?.trim().slice(0, 100)
    })`,
    returnByValue: true
  });
  console.log('After newChat:', JSON.parse(afterNewChat.result?.value || '{}'));

  // Try clearing response region (as gateway now does)
  console.log('\nClearing response region...');
  const clearResult = await client.send('Runtime.evaluate', {
    expression: `
      (function() {
        var el = document.querySelector('[data-role="assistant"]');
        if (el) { el.textContent = ''; return 'cleared assistant'; }
        var items = document.querySelectorAll('.agent-plan-items');
        for (var i = 0; i < items.length; i++) items[i].textContent = '';
        return 'cleared items: ' + items.length;
      })()
    `,
    returnByValue: true
  });
  console.log('Clear result:', clearResult.result?.value);
  await sleep(200);

  // Try sendMessage sequence
  console.log('\nTrying sendMessage sequence...');
  // Ctrl+A + Backspace
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
  await sleep(50);
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' });
  await sleep(100);

  // Type "1+1=?"
  for (const char of '1+1=?') {
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: char, code: 'Key' + char.toUpperCase() });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: char, code: 'Key' + char.toUpperCase() });
    await sleep(30);
  }
  await sleep(500);

  const afterType = await client.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      textContent: document.querySelector('.chat-input-v2-input-box-editable')?.textContent,
      btnDisabled: document.querySelector('button.chat-input-v2-send-button')?.disabled
    })`,
    returnByValue: true
  });
  console.log('After typing:', JSON.parse(afterType.result?.value || '{}'));

  // Ctrl+Enter to submit
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 2 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 2 });
  await sleep(5000);

  // Check response
  const afterSubmit = await client.send('Runtime.evaluate', {
    expression: `document.querySelector('[data-role="assistant"]')?.textContent?.trim().slice(0, 100)`,
    returnByValue: true
  });
  console.log('Response after submit:', afterSubmit.result?.value);

  await client.close();
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
