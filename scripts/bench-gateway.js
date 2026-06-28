'use strict';

/**
 * Gateway startup + /api/status latency benchmark.
 *
 * Runs gateway in mock-bridge mode against a random port, measures:
 *   - cold start: from process boot until startGateway resolves
 *   - /api/status latency: average over 200 in-process requests (in
 *     serial so the rate limiter is bypassed)
 *
 * Exits 0 on success and prints two machine-readable lines:
 *   startup_ms=<number>
 *   status_req_avg_us=<number>
 *
 * Run: `node scripts/bench-gateway.js`
 * Or:  `node scripts/bench-gateway.js <iterations>` to change request count.
 *
 * Lives in scripts/ (not test/) because it boots a real server and takes a
 * few seconds — it's a manual benchmark, not a CI gate.
 */

process.env.TRAECN_ENABLE_MOCK_BRIDGE = '1';
process.env.TRAECN_RATE_LIMIT_MAX_REQUESTS = '10000';

const http = require('http');
const { startGateway } = require('../src/http/gateway');

const ITERATIONS = Number(process.argv[2]) || 200;
const WARMUP = 5;

function req(port) {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: '127.0.0.1', port, path: '/api/status', method: 'GET', agent: false }, res => {
      res.on('data', () => {});
      res.on('end', resolve);
    });
    r.on('error', reject);
    r.end();
  });
}

(async () => {
  const t0 = process.hrtime.bigint();
  const { server, close } = await startGateway({ host: '127.0.0.1', port: 0 });
  const t1 = process.hrtime.bigint();
  const startupMs = Number(t1 - t0) / 1e6;
  const port = server.address().port;

  try {
    // Warmup (VM caches, JIT)
    for (let i = 0; i < WARMUP; i++) await req(port);

    const a = process.hrtime.bigint();
    for (let i = 0; i < ITERATIONS; i++) await req(port);
    const b = process.hrtime.bigint();

    const avgUs = (Number(b - a) / ITERATIONS) / 1000;
    console.log(`startup_ms=${startupMs.toFixed(3)}`);
    console.log(`status_req_avg_us=${avgUs.toFixed(3)}`);
  } finally {
    if (typeof close === 'function') await close();
    else server.close();
  }
})().catch(e => { console.error(e); process.exit(1); });