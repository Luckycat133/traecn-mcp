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
  console.log(`Found ${targets.length} CDP targets\n`);

  for (const t of targets) {
    console.log(`[${t.type}] "${t.title}" — ${t.url?.slice(0, 80)}`);
  }

  console.log('\n=== Scanning ALL targets for response selectors ===');
  for (const t of targets.filter(x => x.type === 'page')) {
    console.log(`\nTarget: ${t.title}`);
    const client = new CDPClient(t.webSocketDebuggerUrl);
    try {
      await client.connect();
      await client.send('DOM.enable');
      await client.send('Runtime.enable');
      const { root } = await client.send('DOM.getDocument', { depth: -1 });

      const selectors = [
        "[data-role='assistant']", '.assistant', '[class*="assistant"]',
        '.assistant-chat-turn-content', '[class*="activity"]', '[class*="chat"]'
      ];

      for (const sel of selectors) {
        try {
          const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
          if (nodeId) {
            const r = await client.send('Runtime.evaluate', {
              expression: `document.querySelector('${sel.replace(/'/g, "\\'")}')?.textContent?.trim() || ''`,
              returnByValue: true
            });
            console.log(`  ${r.result?.value ? 'TEXT' : 'EMPTY'} ${sel}: "${(r.result?.value||'').slice(0,80)}"`);
          } else {
            console.log(`  MISSING ${sel}`);
          }
        } catch (e) { console.log(`  ERR ${sel}: ${e.message.slice(0,40)}`); }
      }
      await client.close();
    } catch (e) { console.log(`  Error: ${e.message}`); }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
