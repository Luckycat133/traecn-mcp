'use strict';
const http = require('http');
const WebSocket = require('ws');

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

async function main() {
  const list = await get('http://127.0.0.1:9222/json/list');
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  await new Promise(r => ws.once('open', r));

  function call(method, params = {}) {
    return new Promise(resolve => {
      const i = ++id;
      pending.set(i, m => resolve(m.result));
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  }

  await call('Runtime.enable');

  const expr = `(()=>{
    const out = {};
    // All global vars starting with vs/workbench/monaco
    out.globals = Object.keys(window).filter(k => /^(vs|monaco|workbench|_|_VSCODE)/.test(k));
    // Try to access the command service via DOM (we may find context menu or hotkey)
    out.settingsTabs = Array.from(document.querySelectorAll('.tabs-container > div, .tab, [class*="tab"]'))
      .filter(t => /设置|settings/i.test(t.innerText || t.title || ''))
      .map(t => ({ text: t.innerText, title: t.title, class: t.className }));
    // Close button for settings tab
    out.settingsCloseBtn = !!document.querySelector('.tab.active .tab-actions .action-label.codicon-close, .tab.focused .tab-actions .codicon-close');
    // Active settings tab aria
    out.activeSettings = document.querySelector('.tab.active, .tab.focused')?.innerText?.slice(0,80);
    // Look for command palette launcher class
    out.quickOpen = !!document.querySelector('.quick-input-widget, [class*="quick-input"]');
    // Composer search for any chat input
    out.composerInputs = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], .chat-input-v2-input-box-editable, .chat-input'))
      .map(e => ({ tag: e.tagName, classes: e.className, visible: e.offsetParent !== null, parent: e.parentElement?.className?.slice(0,60) }));
    // Find SOLO/IDE tab
    out.modeTabs = Array.from(document.querySelectorAll('.icube-mode-tab-item, [class*="icube-mode-tab"]'))
      .map(e => ({ text: e.innerText?.slice(0,40), classes: e.className, visible: e.offsetParent !== null }));
    // Status bar
    out.gitStatus = document.querySelector('.statusbar [aria-label*="Git"], .statusbar [class*="git"]')?.getAttribute('aria-label') || 
                    Array.from(document.querySelectorAll('.statusbar [title*="Git"], .statusbar [aria-label*="Git"]')).map(e => e.title || e.getAttribute('aria-label'));
    // Build info
    out.traeVersion = Array.from(document.querySelectorAll('[title*="TRAE"], [aria-label*="TRAE"]')).map(e => e.title || e.getAttribute('aria-label'));
    return JSON.stringify(out);
  })()`;

  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log(r.result.value);
  ws.close();
}

main().catch(e => { console.error(e); process.exit(1); });
