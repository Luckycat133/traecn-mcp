'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { CDPClient } = require('../src/cdp/client');
const { isTraeCNVersion, resolveCDPEndpoint } = require('../src/cdp/discovery');
const dom = require('../src/cdp/browser-dom');
const { loadEnv } = require('../src/config/env');
const { getEnvWithFallback } = require('../src/shared/utils');
const { getConfig } = require('../src/cdp/driver-config');
const { runtimeDefault } = require('../src/config/runtime-schema');

loadEnv(path.resolve(__dirname, '..', '.env'));

const args = new Set(process.argv.slice(2));
const VERIFY_MODE = args.has('--verify');
const WRITE_REPORT = !VERIFY_MODE && !args.has('--no-write');

function argValue(name, fallback) {
  const prefix = `${name}=`;
  const inline = process.argv.slice(2).find(arg => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

let CDP_HOST = argValue('--host', getEnvWithFallback('TRAECN_CDP_HOST', 'TRAE_CDP_HOST', runtimeDefault('TRAECN_CDP_HOST')));
let CDP_PORT = argValue('--port', getEnvWithFallback('TRAECN_REMOTE_DEBUGGING_PORT', 'TRAE_REMOTE_DEBUGGING_PORT', runtimeDefault('TRAECN_REMOTE_DEBUGGING_PORT')));

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

function looksLikeTraeTarget(target) {
  const title = String(target.title || '').toLowerCase();
  const url = String(target.url || '').toLowerCase();
  return title.includes('trae') || url.includes('vscode-app') || url.includes('vscode-file');
}

function verifyResults(target, version, results) {
  const checks = [
    {
      name: 'CDP endpoint belongs to TraeCN',
      ok: isTraeCNVersion(version),
      detail: version['User-Agent'] || version.Browser || 'unknown'
    },
    {
      name: 'Selected target looks like TraeCN',
      ok: looksLikeTraeTarget(target),
      detail: `${target.title || 'No title'} (${target.url || 'no url'})`
    },
    {
      name: 'Composer selector',
      ok: results.composers.length > 0,
      detail: results.composers[0]?.selector || 'not found'
    },
    {
      name: 'Send button selector',
      ok: results.sendButtons.length > 0,
      detail: results.sendButtons[0]?.selector || 'not found'
    },
    {
      name: 'Response/activity selector',
      ok: results.responseRegions.length > 0 || results.activityIndicators.length > 0,
      detail: results.responseRegions[0]?.selector || results.activityIndicators[0]?.selector || 'not found'
    },
    {
      name: 'New chat selector',
      ok: results.newChatButtons.length > 0,
      detail: results.newChatButtons[0]?.selector || 'not found'
    },
    {
      name: 'Mode tab selector',
      ok: results.modeTabs.length > 0,
      detail: results.modeTabs[0]?.selector || 'not found'
    }
  ];

  console.log('');
  console.log('  === Verify Summary ===');
  for (const check of checks) {
    console.log(`  ${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`);
  }

  return checks.every(check => check.ok);
}

function uniqueSelectors(selectors) {
  return Array.from(new Set(selectors.filter(Boolean)));
}

function getScanConfig() {
  const config = getConfig();
  return {
    composerSelectors: uniqueSelectors(config.composerSelectors),
    sendButtonSelectors: uniqueSelectors(config.sendButtonSelectors),
    responseSelectors: uniqueSelectors([
      ...config.responseSelectors,
      ...config.ideResponseSelectors,
      ...config.activitySelectors
    ]),
    newChatSelectors: uniqueSelectors([
      ...config.newChatSelectors,
      ...config.ideNewChatSelectors
    ]),
    modeTabSelectors: uniqueSelectors(config.modeTabSelectors),
    activitySelectors: uniqueSelectors([
      ...config.activitySelectors,
      ...config.ideTaskPanelSelectors
    ])
  };
}

async function scanDOM(client, scanConfig = getScanConfig()) {
  const scanResults = {
    composers: [],
    sendButtons: [],
    responseRegions: [],
    newChatButtons: [],
    modeTabs: [],
    activityIndicators: []
  };

  const composerSelectors = scanConfig.composerSelectors;
  const sendButtonSelectors = scanConfig.sendButtonSelectors;
  const responseSelectors = scanConfig.responseSelectors;
  const newChatSelectors = scanConfig.newChatSelectors;
  const modeTabSelectors = scanConfig.modeTabSelectors;
  const activitySelectors = scanConfig.activitySelectors;

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

  try {
    const endpoint = await resolveCDPEndpoint({ host: CDP_HOST, port: CDP_PORT });
    if (endpoint.port !== CDP_PORT || endpoint.host !== CDP_HOST) {
      console.log(`[inspect-traecn] Auto-selected TraeCN CDP endpoint: ${endpoint.host}:${endpoint.port}`);
    }
    CDP_HOST = endpoint.host;
    CDP_PORT = endpoint.port;
  } catch {
    // Keep the original endpoint so the existing troubleshooting message remains specific.
  }

  console.log(`[inspect-traecn] CDP target: ${CDP_HOST}:${CDP_PORT}`);
  console.log('');

  let version;
  try {
    version = await fetchJSON(`http://${CDP_HOST}:${CDP_PORT}/json/version`);
    console.log('[inspect-traecn] CDP Version:');
    console.log(`  Browser: ${version.Browser || 'Unknown'}`);
    console.log(`  Protocol: ${version['Protocol-Version'] || 'Unknown'}`);
    console.log(`  Owner: ${isTraeCNVersion(version) ? 'TraeCN' : 'not TraeCN'}`);
    console.log('');
    if (VERIFY_MODE && !isTraeCNVersion(version)) {
      console.error('[inspect-traecn] Verify failed: CDP endpoint is reachable, but it does not look like TraeCN.');
      console.error(`  User-Agent: ${version['User-Agent'] || 'Unknown'}`);
      console.error('  Check TRAECN_REMOTE_DEBUGGING_PORT; another browser may be using this port.');
      process.exit(1);
    }
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

  const pageTargets = targets
    .filter(t => t.type === 'page' && !t.title?.includes('DevTools'))
    .sort((a, b) => Number(looksLikeTraeTarget(b)) - Number(looksLikeTraeTarget(a)));

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

      if (VERIFY_MODE) {
        const passed = verifyResults(target, version, results);
        if (!passed) {
          process.exitCode = 1;
        }
      } else if (WRITE_REPORT) {
        const reportPath = path.resolve(__dirname, '..', 'inspect-report.json');
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
        console.log(`\n  Report saved to: ${reportPath}`);
      }

    } catch (err) {
      console.error(`  Error scanning target: ${err.message}`);
      if (VERIFY_MODE) {
        process.exitCode = 1;
      }
    } finally {
      if (client) {
        await client.close();
      }
    }
  }

  console.log('\n[inspect-traecn] Inspection complete.');
}

main().then(() => {
  process.exit(process.exitCode || 0);
}).catch(err => {
  console.error('[inspect-traecn] Fatal error:', err.message);
  process.exit(1);
});
