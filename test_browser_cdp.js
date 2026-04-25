#!/usr/bin/env node
/**
 * Debug: Get frame tree of page 4 (the settings page per Playwright)
 */
const { BrowserCDPClient } = require('./src/cdp/client');

const CDP_WS = 'ws://127.0.0.1:9333/devtools/browser/4fb18348-7d3f-4dc5-9624-6ab3ae68e5b7';

async function main() {
  const browserClient = new BrowserCDPClient(CDP_WS);
  await browserClient.connect();
  console.log('[OK] Connected\n');

  const targetsResult = await browserClient.send('Target.getTargets', {});
  const pages = targetsResult.targetInfos.filter(t => t.type === 'page');

  // Try page 4 (index 4) - which is pages[4] in Playwright
  const page4 = pages[4];
  console.log(`Attaching to page[4]: ${page4 ? page4.targetId : 'none'}`);

  if (!page4) {
    await browserClient.close();
    return;
  }

  const session = await browserClient.attachToTarget(page4.targetId);
  await session.send('DOM.enable');
  await session.send('Runtime.enable');
  console.log('[OK] Attached\n');

  // Get frame tree
  try {
    const frameTree = await session.send('Page.getFrameTree', {});
    console.log('Frame tree:');
    console.log(JSON.stringify(frameTree, null, 2).substring(0, 3000));
  } catch(e) {
    console.log('Page.getFrameTree error:', e.message);
  }

  // Simple eval
  try {
    const result = await session.send('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true
    });
    console.log('\nPage title:', JSON.stringify(result));
  } catch(e) {
    console.log('evaluate error:', e.message);
  }

  // Try to get document
  try {
    const docResult = await session.send('Runtime.evaluate', {
      expression: 'window.location.href',
      returnByValue: true
    });
    console.log('Window href:', JSON.stringify(docResult));
  } catch(e) {
    console.log('href error:', e.message);
  }

  await browserClient.close();
  console.log('\n=== Done ===');
}

main().catch(err => { console.error('[ERROR]:', err.message); process.exit(1); });