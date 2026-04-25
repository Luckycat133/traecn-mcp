#!/usr/bin/env node
/**
 * Test: Verify setContentEditableText properly clears and replaces Lexical editor content
 * 
 * Connects to Trae CN via CDP, finds the target with title "test_project",
 * and tests that setContentEditableText correctly replaces existing content
 * rather than appending to it.
 */
const { BrowserCDPClient } = require('./src/cdp/client');
const dom = require('./src/cdp/browser-dom');

const CDP_HOST = '127.0.0.1';
const CDP_PORT = 9333;
const TARGET_TITLE_CONTAINS = 'test_project';

async function main() {
  // 1. Connect to browser-level CDP
  const browserClient = new BrowserCDPClient(`ws://${CDP_HOST}:${CDP_PORT}/json`);
  await browserClient.connect();
  console.log('[OK] Connected to browser CDP');

  // 2. Find target with "test_project" in title
  const targetsResult = await browserClient.send('Target.getTargets', {});
  const pageTargets = targetsResult.targetInfos.filter(t => t.type === 'page');
  
  const target = pageTargets.find(t => 
    (t.title || '').toLowerCase().includes(TARGET_TITLE_CONTAINS.toLowerCase())
  );
  
  if (!target) {
    console.error(`[FAIL] No target found with title containing "${TARGET_TITLE_CONTAINS}"`);
    console.error('Available targets:');
    pageTargets.forEach(t => console.error(`  - ${t.title} (${t.targetId})`));
    await browserClient.close();
    process.exit(1);
  }
  console.log(`[OK] Found target: "${target.title}" (${target.targetId})`);

  // 3. Attach to target
  const session = await browserClient.attachToTarget(target.targetId);
  await session.send('Runtime.enable');
  console.log('[OK] Attached to target session');

  // 4. Find the Lexical editor editable div
  const editableSelector = 'div.chat-input-v2-input-box-editable';
  const nodeId = await dom.querySelector(session, editableSelector);
  
  if (!nodeId) {
    console.error(`[FAIL] Could not find element with selector: ${editableSelector}`);
    await browserClient.close();
    process.exit(1);
  }
  console.log(`[OK] Found editable div (nodeId=${nodeId})`);

  // 5. Get current content (should be empty initially)
  const beforeText = await dom.getInnerText(session, nodeId);
  console.log(`[INFO] Content before test: "${beforeText}"`);

  // 6. Set initial text via execCommand to establish content
  //    (simulate user typing first)
  await dom.setContentEditableText(session, nodeId, 'Initial content');
  await new Promise(r => setTimeout(r, 300));
  
  const afterFirstSet = await dom.getInnerText(session, nodeId);
  console.log(`[INFO] After first setContentEditableText: "${afterFirstSet}"`);

  // 7. Now replace with new text — this is the key test
  //    The fix ensures this REPLACES rather than APPENDS
  await dom.setContentEditableText(session, nodeId, 'Replacement text');
  await new Promise(r, setTimeout(r, 300));

  const afterSecondSet = await dom.getInnerText(session, nodeId);
  console.log(`[INFO] After second setContentEditableText: "${afterSecondSet}"`);

  // 8. Verify
  const expected = 'Replacement text';
  if (afterSecondSet === expected) {
    console.log(`[PASS] Content correctly replaced. Got "${afterSecondSet}", expected "${expected}"`);
  } else {
    console.error(`[FAIL] Content was NOT replaced correctly.`);
    console.error(`  Expected: "${expected}"`);
    console.error(`  Got:      "${afterSecondSet}"`);
    console.error(`  This indicates the text was appended instead of replaced.`);
    await browserClient.close();
    process.exit(1);
  }

  await browserClient.close();
  console.log('\n=== All tests passed ===');
}

main().catch(err => {
  console.error('[ERROR]:', err.message);
  console.error(err.stack);
  process.exit(1);
});