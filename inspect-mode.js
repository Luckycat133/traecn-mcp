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

async function main() {
  const targets = await _get('http://127.0.0.1:9222/json/list');
  const t = targets.find(x => x.title.includes('openclaw') && x.type === 'page');
  console.log('Target:', t?.title);

  const client = new CDPClient(t.webSocketDebuggerUrl);
  await client.connect();
  await client.send('DOM.enable');
  await client.send('Runtime.enable');
  console.log('Connected\n');

  // Find and print all potentially clickable new-chat elements
  const r = await client.send('Runtime.evaluate', {
    expression: `
      (function() {
        var results = [];
        var selectors = [
          '[class*="new-chat"]', '[class*="newChat"]', '[class*="new_conversation"]',
          '[class*="conversation-new"]', '[aria-label*="new"]', '[aria-label*="New"]',
          'button[class*="chat"]', 'button[class*="new"]', '[role="button"][class*="chat"]'
        ];
        for (var s of selectors) {
          var els = document.querySelectorAll(s);
          for (var i = 0; i < els.length; i++) {
            results.push(s + '[' + i + ']: ' + els[i].className.replace(/\\s+/g,' ').trim() + ' | ' + els[i].textContent.trim().slice(0,50));
          }
        }
        return JSON.stringify(results);
      })()
    `,
    returnByValue: true
  });
  console.log('New chat candidates:', JSON.parse(r.result?.value || '[]').join('\n'));

  // Check the composer state
  const c = await client.send('Runtime.evaluate', {
    expression: `
      (function() {
        var el = document.querySelector('.chat-input-v2-input-box-editable');
        if (!el) return 'no composer';
        return 'composer found: ' + el.className.replace(/\\s+/g,' ').trim() + ' | text: ' + el.textContent.trim().slice(0,50) + ' | contenteditable: ' + el.getAttribute('contenteditable');
      })()
    `,
    returnByValue: true
  });
  console.log('\nComposer:', c.result?.value);

  // Check send button
  const s = await client.send('Runtime.evaluate', {
    expression: `
      (function() {
        var btn = document.querySelector('button.chat-input-v2-send-button');
        if (!btn) return 'no send button';
        return 'found: ' + btn.className.replace(/\\s+/g,' ').trim() + ' | disabled: ' + btn.disabled + ' | display: ' + getComputedStyle(btn).display;
      })()
    `,
    returnByValue: true
  });
  console.log('Send button:', s.result?.value);

  await client.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
