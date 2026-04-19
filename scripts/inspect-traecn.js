'use strict';

const http = require('http');
const { CDPClient } = require('../src/cdp/client');
const dom = require('../src/cdp/browser-dom');

function _getEnvWithFallback(traecnKey, traeKey, defaultValue) {
  return process.env[traecnKey] || process.env[traeKey] || defaultValue;
}

const CDP_HOST = _getEnvWithFallback('TRAECN_CDP_HOST', 'TRAE_CDP_HOST', '127.0.0.1');
const CDP_PORT = _getEnvWithFallback('TRAECN_REMOTE_DEBUGGING_PORT', 'TRAE_REMOTE_DEBUGGING_PORT', '9222');

async function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (err) { reject(new Error(`Failed to parse: ${err.message}`)); }
      });
    }).on('error', reject);
  });
}

async function scanDOM(client) {
  const scanResults = {
    composers: [],
    sendButtons: [],
    responseRegions: [],
    newChatButtons: [],
    modeTabs: [],
    activityIndicators: []
  };

  const composerSelectors = [
    '.chat-input-v2-input-box-editable',
    'textarea',
    "[contenteditable='true']",
    "input[type='text']",
    '[class*="chat-input"]',
    '[class*="composer"]',
    '[class*="input-box"]',
    '[role="textbox"]'
  ];

  const sendButtonSelectors = [
    'button.chat-input-v2-send-button',
    "button[data-testid*='send']",
    "button[aria-label*='Send']",
    "button[aria-label*='发送']",
    "button[type='submit']",
    'button[class*="send"]',
    'button[class*="submit"]'
  ];

  const responseSelectors = [
    '.assistant-chat-turn-content',
    '.agent-plan-items.assistant-chat-turn-element',
    "[data-message-author-role='assistant']",
    "[data-role='assistant']",
    "[data-author='assistant']",
    '.assistant',
    '[class*="assistant"]',
    '[class*="response"]',
    '[class*="reply"]'
  ];

  const newChatSelectors = [
    'a.codicon-icube-NewChat',
    "a[data-testid*='new-chat']",
    "button[data-testid*='new-chat']",
    "[aria-label*='New Chat']",
    "[aria-label*='新建对话']",
    '[class*="new-chat"]',
    '[class*="NewChat"]'
  ];

  const modeTabSelectors = [
    '.icube-mode-tab-item',
    "[class*='icube-mode-tab-item']",
    "[data-testid*='mode-tab']",
    '[class*="mode-tab"]',
    '[class*="mode-switch"]'
  ];

  const activitySelectors = [
    '.chat-content-container',
    '.chat-list-wrapper',
    '[class*="chat-content"]',
    '[class*="chat-list"]',
    '[class*="activity"]',
    '[class*="loading"]'
  ];

  for (const selector of composerSelectors) {
    const nodeId = await dom.querySelector(client, selector);
    if (nodeId) {
      const html = await dom.getOuterHTML(client, nodeId);
      scanResults.composers.push({ selector, nodeId, preview: html.slice(0, 200) });
    }
  }

  for (const selector of sendButtonSelectors) {
    const nodeId = await dom.querySelector(client, selector);
    if (nodeId) {
      const text = await dom.getInnerText(client, nodeId);
      scanResults.sendButtons.push({ selector, nodeId, text: text.trim() });
    }
  }

  for (const selector of responseSelectors) {
    const nodeIds = await dom.querySelectorAll(client, selector);
    for (const nodeId of nodeIds) {
      const text = await dom.getInnerText(client, nodeId);
      scanResults.responseRegions.push({
        selector,
        nodeId,
        textPreview: (text || '').slice(0, 200)
      });
    }
  }

  for (const selector of newChatSelectors) {
    const nodeId = await dom.querySelector(client, selector);
    if (nodeId) {
      const text = await dom.getInnerText(client, nodeId);
      scanResults.newChatButtons.push({ selector, nodeId, text: text.trim() });
    }
  }

  for (const selector of modeTabSelectors) {
    const nodeIds = await dom.querySelectorAll(client, selector);
    for (const nodeId of nodeIds) {
      const text = await dom.getInnerText(client, nodeId);
      scanResults.modeTabs.push({ selector, nodeId, text: text.trim() });
    }
  }

  for (const selector of activitySelectors) {
    const nodeId = await dom.querySelector(client, selector);
    if (nodeId) {
      scanResults.activityIndicators.push({ selector, nodeId });
    }
  }

  return scanResults;
}

async function main() {
  console.log('[inspect-traecn] TraeCN CDP + DOM Inspector');
  console.log(`[inspect-traecn] CDP target: ${CDP_HOST}:${CDP_PORT}`);
  console.log('');

  let version;
  try {
    version = await fetchJSON(`http://${CDP_HOST}:${CDP_PORT}/json/version`);
    console.log('[inspect-traecn] CDP Version:');
    console.log(`  Browser: ${version.Browser || 'Unknown'}`);
    console.log(`  Protocol: ${version['Protocol-Version'] || 'Unknown'}`);
    console.log('');
  } catch (err) {
    console.error(`[inspect-traecn] Cannot connect to CDP at ${CDP_HOST}:${CDP_PORT}`);
    console.error(`[inspect-traecn] Error: ${err.message}`);
    console.error('');
    console.error('[inspect-traecn] Troubleshooting:');
    console.error('  1. Make sure TraeCN is running');
    console.error('  2. Start TraeCN with --remote-debugging-port=9222');
    console.error('  3. Check TRAECN_REMOTE_DEBUGGING_PORT environment variable');
    process.exit(1);
  }

  let targets;
  try {
    targets = await fetchJSON(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  } catch (err) {
    console.error(`[inspect-traecn] Failed to list targets: ${err.message}`);
    process.exit(1);
  }

  console.log(`[inspect-traecn] Found ${targets.length} CDP targets:`);
  for (const target of targets) {
    console.log(`  [${target.type}] ${target.title || 'No title'}`);
    console.log(`    URL: ${target.url || 'N/A'}`);
    console.log(`    ID: ${target.id}`);
  }
  console.log('');

  const pageTargets = targets.filter(t => t.type === 'page' && !t.title?.includes('DevTools'));

  if (pageTargets.length === 0) {
    console.error('[inspect-traecn] No page targets found. Is TraeCN Chat panel open?');
    process.exit(1);
  }

  for (const target of pageTargets) {
    console.log(`[inspect-traecn] Scanning DOM for target: "${target.title}"`);

    if (!target.webSocketDebuggerUrl) {
      console.log(`  Skipping: No WebSocket URL`);
      continue;
    }

    let client;
    try {
      client = new CDPClient(target.webSocketDebuggerUrl);
      await client.connect();
      await client.send('DOM.enable');

      const results = await scanDOM(client);

      console.log('');
      console.log('  === Composer (Input) Elements ===');
      if (results.composers.length === 0) {
        console.log('  (none found)');
      } else {
        for (const item of results.composers) {
          console.log(`  ✅ ${item.selector}`);
        }
      }

      console.log('');
      console.log('  === Send Button Elements ===');
      if (results.sendButtons.length === 0) {
        console.log('  (none found)');
      } else {
        for (const item of results.sendButtons) {
          console.log(`  ✅ ${item.selector} [text: "${item.text}"]`);
        }
      }

      console.log('');
      console.log('  === Response Region Elements ===');
      if (results.responseRegions.length === 0) {
        console.log('  (none found)');
      } else {
        for (const item of results.responseRegions) {
          console.log(`  ✅ ${item.selector} [preview: "${item.textPreview.slice(0, 60)}..."]`);
        }
      }

      console.log('');
      console.log('  === New Chat Button Elements ===');
      if (results.newChatButtons.length === 0) {
        console.log('  (none found)');
      } else {
        for (const item of results.newChatButtons) {
          console.log(`  ✅ ${item.selector} [text: "${item.text}"]`);
        }
      }

      console.log('');
      console.log('  === Mode Tab Elements ===');
      if (results.modeTabs.length === 0) {
        console.log('  (none found)');
      } else {
        for (const item of results.modeTabs) {
          console.log(`  ✅ ${item.selector} [text: "${item.text}"]`);
        }
      }

      console.log('');
      console.log('  === Activity Indicator Elements ===');
      if (results.activityIndicators.length === 0) {
        console.log('  (none found)');
      } else {
        for (const item of results.activityIndicators) {
          console.log(`  ✅ ${item.selector}`);
        }
      }

      console.log('');
      console.log('  === Recommended .env Configuration ===');
      const envLines = [];
      if (results.composers.length > 0) {
        envLines.push(`TRAECN_COMPOSER_SELECTORS=${results.composers.map(c => c.selector).join(',')}`);
      }
      if (results.sendButtons.length > 0) {
        envLines.push(`TRAECN_SEND_BUTTON_SELECTORS=${results.sendButtons.map(s => s.selector).join(',')}`);
      }
      if (results.responseRegions.length > 0) {
        envLines.push(`TRAECN_RESPONSE_SELECTORS=${results.responseRegions.map(r => r.selector).join(',')}`);
      }
      if (results.newChatButtons.length > 0) {
        envLines.push(`TRAECN_NEW_CHAT_SELECTORS=${results.newChatButtons.map(n => n.selector).join(',')}`);
      }
      if (results.modeTabs.length > 0) {
        envLines.push(`TRAECN_MODE_TAB_SELECTORS=${results.modeTabs.map(m => m.selector).join(',')}`);
      }
      if (results.activityIndicators.length > 0) {
        envLines.push(`TRAECN_ACTIVITY_SELECTORS=${results.activityIndicators.map(a => a.selector).join(',')}`);
      }

      if (envLines.length > 0) {
        for (const line of envLines) {
          console.log(`  ${line}`);
        }
      } else {
        console.log('  (No selectors found - DOM structure may differ from expected)');
      }

      const report = {
        target: { id: target.id, title: target.title, url: target.url },
        scanResults: results,
        recommendedEnv: envLines
      };

      const fs = require('fs');
      const path = require('path');
      const reportPath = path.resolve(__dirname, '..', 'inspect-report.json');
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
      console.log(`\n  Report saved to: ${reportPath}`);

    } catch (err) {
      console.error(`  Error scanning target: ${err.message}`);
    } finally {
      if (client) {
        await client.close();
      }
    }
  }

  console.log('\n[inspect-traecn] Inspection complete.');
}

main().catch(err => {
  console.error('[inspect-traecn] Fatal error:', err.message);
  process.exit(1);
});
