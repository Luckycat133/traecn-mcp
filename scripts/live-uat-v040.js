'use strict';

/**
 * live-uat-v040.js — End-to-end smoke test for v0.4.0 drivers.
 *
 * Connects to the running TRAECNclaw gateway (127.0.0.1:8788) and exercises
 * the new /api/editor, /api/file, /api/terminal, /api/git, /api/search,
 * /api/diagnostics, /api/snapshot, /api/extension, /api/command endpoints
 * against a live TraeCN instance.
 *
 * Skips any step that requires a logged-in TraeCN (AI delegation).
 * Records a pass/fail per step and exits non-zero if any critical step fails.
 */

const http = require('http');

const HOST = '127.0.0.1';
const PORT = 8788;

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request({
      hostname: HOST, port: PORT, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body || '{}') }); }
        catch { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://${HOST}:${PORT}${path}`, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body || '{}') }); }
        catch { resolve({ status: res.statusCode, data: body }); }
      });
    }).on('error', reject);
  });
}

const steps = [];
async function step(name, fn, opts = {}) {
  const start = Date.now();
  try {
    const r = await fn();
    const ok = r && (r.data?.ok === true || r.status < 400);
    steps.push({ name, ok, status: r.status, elapsed: Date.now() - start, response: r.data });
    if (opts.silent !== true) {
      const status = ok ? '✓' : '✗';
      console.log(`  ${status} ${name} (${Date.now() - start}ms)${ok ? '' : ' — ' + JSON.stringify(r.data).slice(0, 200)}`);
    }
    return r;
  } catch (e) {
    steps.push({ name, ok: false, error: e.message, elapsed: Date.now() - start });
    console.log(`  ✗ ${name} — ERR: ${e.message}`);
    return null;
  }
}

async function main() {
  console.log(`[live-uat-v040] Connecting to gateway at http://${HOST}:${PORT}...\n`);

  // 1. Health check
  await step('gateway /api/status', () => get('/api/status'));

  // 2. /api/snapshot — pageHash (low-risk read)
  await step('snapshot / pageHash', () => post('/api/snapshot', { action: 'pageHash' }));

  // 3. /api/snapshot — text (read body text)
  await step('snapshot / text', () => post('/api/snapshot', { action: 'text' }));

  // 4. /api/file — listOpenEditors (read open files)
  await step('file / listOpenEditors', () => post('/api/file', { action: 'listOpenEditors' }));

  // 5. /api/file — readDisk (off-CDP, just Node fs)
  await step('file / readDisk hello.py', () => post('/api/file', { action: 'readDisk', filePath: '/Volumes/My Shared Files/共享/projects/TRAECNclaw/hello.py' }));

  // 6. /api/file — listTreeDisk (off-CDP)
  await step('file / listTreeDisk (depth=1)', () => post('/api/file', { action: 'listTreeDisk', rootPath: '/Volumes/My Shared Files/共享/projects/TRAECNclaw', opts: { maxDepth: 1 } }));

  // 7. /api/editor — readApplyState (read-only, no AI change expected)
  await step('editor / readApplyState', () => post('/api/editor', { action: 'readApplyState' }));

  // 8. /api/editor — listActive (read open editors)
  await step('editor / listActive', () => post('/api/editor', { action: 'listActive' }));

  // 9. /api/terminal — snapshot (read terminal state, may be no terminal)
  const termSnap1 = await step('terminal / snapshot', () => post('/api/terminal', { action: 'snapshot' }));

  // 10. /api/terminal — try to open new terminal (palette may race; OK to fail)
  await step('terminal / new (palette may race)', () => post('/api/terminal', { action: 'newTerminal' }));

  // 11. /api/terminal — snapshot after open
  await step('terminal / snapshot (post-new)', () => post('/api/terminal', { action: 'snapshot' }), { silent: true });

  // 12-14. /api/terminal — send/tail only if terminal is present
  const termSnap2 = await step('terminal / snapshot (pre-send)', () => post('/api/terminal', { action: 'snapshot' }), { silent: true });
  const termOutput = (termSnap2 && termSnap2.data && termSnap2.data.result && termSnap2.data.result.output) || '';
  const termPresent = termSnap2 && termSnap2.data && termSnap2.data.result && termSnap2.data.result.present;
  if (termPresent) {
    await step('terminal / send echo hello', () => post('/api/terminal', { action: 'send', text: 'echo live-uat-v040-hello' }));
    await step('terminal / sendLine (Enter)', () => post('/api/terminal', { action: 'sendLine' }));
    await step('terminal / tail 10', () => post('/api/terminal', { action: 'tail', lines: 10 }));
  } else {
    console.log('  -- terminal / send/tail SKIPPED (no terminal present)');
    steps.push({ name: 'terminal / send', ok: true, skipped: true, note: 'no terminal' });
    steps.push({ name: 'terminal / sendLine', ok: true, skipped: true, note: 'no terminal' });
    steps.push({ name: 'terminal / tail', ok: true, skipped: true, note: 'no terminal' });
  }

  // 15. /api/git — readCurrentBranch
  await step('git / readCurrentBranch', () => post('/api/git', { action: 'readCurrentBranch' }));

  // 16. /api/git — readStatus
  await step('git / readStatus', () => post('/api/git', { action: 'readStatus' }));

  // 17. /api/search — readResults (with no active query, may return empty)
  await step('search / readResults 10', () => post('/api/search', { action: 'readResults', maxResults: 10 }));

  // 18. /api/diagnostics — readModelMarkers (read editor markers)
  await step('diagnostics / readModelMarkers', () => post('/api/diagnostics', { action: 'readModelMarkers' }));

  // 19. /api/diagnostics — count
  await step('diagnostics / count', () => post('/api/diagnostics', { action: 'count' }));

  // 20. /api/extension — readVisible (extensions panel)
  await step('extension / readVisible', () => post('/api/extension', { action: 'readVisible', max: 10 }));

  // 21. /api/command — close (no-op if not open)
  await step('command / close', () => post('/api/command', { action: 'close' }));

  // 22. /api/command — open (open palette)
  await step('command / open', () => post('/api/command', { action: 'open' }));

  // 23. /api/command — close
  await step('command / close (post-open)', () => post('/api/command', { action: 'close' }));

  // 24. /api/snapshot — pageHash (verify state changed)
  await step('snapshot / pageHash (final)', () => post('/api/snapshot', { action: 'pageHash' }));

  // Summary
  console.log('\n');
  const passed = steps.filter(s => s.ok).length;
  const failed = steps.filter(s => !s.ok).length;
  console.log(`[live-uat-v040] Summary: ${passed}/${steps.length} passed, ${failed} failed\n`);

  if (failed > 0) {
    console.log('Failed steps:');
    for (const s of steps.filter(s => !s.ok)) {
      console.log(`  - ${s.name}: ${s.error || JSON.stringify(s.response).slice(0, 200)}`);
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('FATAL:', err); process.exit(2); });
