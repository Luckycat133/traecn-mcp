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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout')); } }, 15000);
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
  const port = 9333;
  const targets = await _get(`http://127.0.0.1:${port}/json/list`);
  const soloPage = targets.find(x => x.type === 'page' && x.title?.includes('openclaw'));
  if (!soloPage) { console.log('No SOLO Coder page'); return; }
  console.log('Using:', soloPage.title);
  const client = new CDPClient(soloPage.webSocketDebuggerUrl);
  await client.connect();
  await client.send('DOM.enable');
  await client.send('Runtime.enable');

  // Check initial state
  const initial = await client.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      text: document.querySelector('.chat-input-v2-input-box-editable')?.textContent?.slice(0, 50),
      btn: document.querySelector('button.chat-input-v2-send-button')?.disabled,
      response: document.querySelector('[data-role="assistant"]')?.textContent?.trim().slice(0, 100)
    })`,
    returnByValue: true
  });
  console.log('Initial state:', JSON.parse(initial.result?.value || '{}'));

  // Test newChat
  console.log('\nnewChat...');
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'n', code: 'KeyN', modifiers: 256 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'n', code: 'KeyN', modifiers: 256 });
  await sleep(2000);

  const afterNewChat = await client.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      text: document.querySelector('.chat-input-v2-input-box-editable')?.textContent?.slice(0, 50),
      btn: document.querySelector('button.chat-input-v2-send-button')?.disabled,
      response: document.querySelector('[data-role="assistant"]')?.textContent?.trim().slice(0, 100)
    })`,
    returnByValue: true
  });
  console.log('After newChat:', JSON.parse(afterNewChat.result?.value || '{}'));

  // Test innerText + click
  console.log('\nTrying innerText + click...');
  await client.send('Runtime.evaluate', {
    expression: `
      (function() {
        var el = document.querySelector('.chat-input-v2-input-box-editable');
        if (!el) return 'no element';
        el.innerText = '1+1=?';
        el.dispatchEvent(new InputEvent('input', {bubbles: true, cancelable: true}));
        return el.textContent;
      })()
    `,
    returnByValue: true
  });
  await sleep(1000);

  const afterType = await client.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      text: document.querySelector('.chat-input-v2-input-box-editable')?.textContent?.slice(0, 50),
      btn: document.querySelector('button.chat-input-v2-send-button')?.disabled
    })`,
    returnByValue: true
  });
  console.log('After typing:', JSON.parse(afterType.result?.value || '{}'));

  if (!JSON.parse(afterType.result?.value || '{}').btn) {
    console.log('Button enabled! Clicking...');
    await client.send('Runtime.evaluate', {
      expression: `document.querySelector('button.chat-input-v2-send-button')?.click()`,
      returnByValue: true
    });
    await sleep(5000);
    const afterClick = await client.send('Runtime.evaluate', {
      expression: `document.querySelector('[data-role="assistant"]')?.textContent?.trim().slice(0, 200)`,
      returnByValue: true
    });
    console.log('Response:', afterClick.result?.value);
  } else {
    console.log('Button still disabled, trying Ctrl+Enter...');
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 2 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 2 });
    await sleep(5000);
    const afterSubmit = await client.send('Runtime.evaluate', {
      expression: `document.querySelector('[data-role="assistant"]')?.textContent?.trim().slice(0, 200)`,
      returnByValue: true
    });
    console.log('Response:', afterSubmit.result?.value);
  }

  await client.close();
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
