'use strict';

// Real loopback Gateway, Mock driver, and an owned CDP HTTP fixture. Each run
// uses disposable stores and one process; no desktop or model is contacted.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { monitorEventLoopDelay } = require('perf_hooks');

const WARMUP = 5;

function positiveInteger(value, label) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function parseArgs(args) {
  const options = { iterations: 200, concurrency: 1, json: false, help: false };
  let hasIterations = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') options.json = true;
    else if (args[i] === '--help' || args[i] === '-h') options.help = true;
    else if (args[i] === '--concurrency') {
      options.concurrency = positiveInteger(args[++i], 'concurrency');
    } else if (!hasIterations && !args[i].startsWith('-')) {
      options.iterations = positiveInteger(args[i], 'iterations');
      hasIterations = true;
    } else throw new Error(`Unknown benchmark argument: ${args[i]}`);
  }
  return options;
}

function requestStatus(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: '127.0.0.1', port, path: '/api/status', agent: false
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.once('error', reject);
      response.once('aborted', () => reject(new Error('Incomplete status response')));
      response.once('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error(`Status request returned HTTP ${response.statusCode}`);
          const snapshot = JSON.parse(body);
          if (snapshot.mockBridge !== true || snapshot.service !== 'traecn-cdp-http-bridge') {
            throw new Error('Status response is not from the Mock Gateway');
          }
          resolve(snapshot);
        } catch (error) { reject(error); }
      });
    });
    request.once('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('Status request timed out')));
  });
}

function percentile(sorted, percent) {
  return sorted[Math.max(0, Math.ceil(sorted.length * percent / 100) - 1)];
}

async function runBenchmark({ iterations = 200, concurrency = 1 } = {}) {
  iterations = positiveInteger(iterations, 'iterations');
  concurrency = Math.min(positiveInteger(concurrency, 'concurrency'), iterations);
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'traecnclaw-gateway-bench-'));
  const previousCwd = process.cwd();
  const overrides = {
    TRAECN_ENABLE_MOCK_BRIDGE: '1',
    TRAECN_GATEWAY_TOKEN: 'isolated-benchmark-token',
    TRAECN_RATE_LIMIT_MAX_REQUESTS: '10000',
    TRAECN_RATE_LIMIT_WINDOW_MS: '60000',
    TRAECN_CONFIG_FILE: path.join(dataRoot, 'config.json'),
    TRAECN_CONFIG_WATCH: '0',
    TRAECN_AUTO_START_TRAE: '0',
    TRAECN_AUTO_RECOVER: '0',
    TRAECN_CDP_HOST: '127.0.0.1',
    TRAECN_REMOTE_DEBUGGING_PORT: '',
    TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH: path.join(dataRoot, 'queue.json'),
    TRAECN_TASK_EVENT_PERSISTENCE_PATH: path.join(dataRoot, 'events.json'),
    TRAECN_TASK_HISTORY_PERSISTENCE_PATH: path.join(dataRoot, 'history.json'),
    TRAECN_AUDIT_LOG_DIR: path.join(dataRoot, 'audit')
  };
  const previousEnv = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  const cdpFixture = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/json/version') {
      response.end(JSON.stringify({ Browser: 'TraeCN/1.107.1', 'Protocol-Version': '1.3' }));
    } else if (request.url === '/json/list') response.end('[]');
    else { response.statusCode = 404; response.end('{}'); }
  });
  let closeGateway;
  let memoryTimer;
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  try {
    await new Promise((resolve, reject) => {
      cdpFixture.once('error', reject);
      cdpFixture.listen(0, '127.0.0.1', resolve);
    });
    overrides.TRAECN_REMOTE_DEBUGGING_PORT = String(cdpFixture.address().port);
    Object.assign(process.env, overrides);
    process.chdir(dataRoot);
    const start = process.hrtime.bigint();
    const { startGateway } = require('../src/http/gateway');
    const { server, close } = await startGateway({ host: '127.0.0.1', port: 0 });
    closeGateway = close;
    const startupMs = Number(process.hrtime.bigint() - start) / 1e6;
    const port = server.address().port;
    for (let i = 0; i < WARMUP; i++) await requestStatus(port);

    const before = process.memoryUsage();
    let peakRss = before.rss;
    const sampleMemory = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss); };
    memoryTimer = setInterval(sampleMemory, 10);
    eventLoop.enable();
    // Let the delay monitor establish its first sample before timed requests.
    await new Promise(resolve => setTimeout(resolve, 20));
    eventLoop.reset();
    const latencies = new Array(iterations);
    let next = 0;
    let failure;
    const measuredStart = process.hrtime.bigint();
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (next < iterations && !failure) {
        const index = next++;
        const requestStart = process.hrtime.bigint();
        try {
          await requestStatus(port);
          latencies[index] = Number(process.hrtime.bigint() - requestStart) / 1e6;
          sampleMemory();
        } catch (error) { failure = error; }
      }
    }));
    if (failure) throw failure;
    const elapsedMs = Number(process.hrtime.bigint() - measuredStart) / 1e6;
    const after = process.memoryUsage();
    clearInterval(memoryTimer);
    memoryTimer = null;
    eventLoop.disable();
    latencies.sort((a, b) => a - b);
    const meanMs = latencies.reduce((sum, value) => sum + value, 0) / iterations;
    return {
      environment: { node: process.version, platform: process.platform, arch: process.arch, osRelease: os.release(), cpu: os.cpus()[0]?.model, cpuCount: os.cpus().length, bridge: 'mock', cdp: 'owned-loopback-fixture', endpoint: '/api/status', keepAlive: false },
      iterations, concurrency, warmup: WARMUP, successfulRequests: latencies.length,
      startup_ms: startupMs, startupIncludesModuleLoad: true,
      status_req_avg_us: meanMs * 1000,
      elapsed_ms: elapsedMs, throughput_rps: iterations * 1000 / elapsedMs,
      latency_ms: { mean: meanMs, p50: percentile(latencies, 50), p95: percentile(latencies, 95), p99: percentile(latencies, 99), max: latencies.at(-1) },
      memory_bytes: { rssBefore: before.rss, rssAfter: after.rss, rssPeakSampled: peakRss, heapUsedBefore: before.heapUsed, heapUsedAfter: after.heapUsed },
      event_loop_delay_ms: { resolution: 10, mean: Number.isFinite(eventLoop.mean) ? eventLoop.mean / 1e6 : null, p95: eventLoop.count ? eventLoop.percentile(95) / 1e6 : null, max: eventLoop.count ? eventLoop.max / 1e6 : null, samples: eventLoop.count }
    };
  } finally {
    if (memoryTimer) clearInterval(memoryTimer);
    eventLoop.disable();
    try {
      if (closeGateway) await closeGateway();
    } finally {
      if (cdpFixture.listening) await new Promise(resolve => cdpFixture.close(resolve));
      process.chdir(previousCwd);
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/bench-gateway.js [iterations] [--concurrency N] [--json]');
    console.log('Mock Gateway + local CDP fixture, temporary stores; validates every HTTP response.');
    return;
  }
  const originalLog = console.log;
  let result;
  try {
    if (options.json) console.log = (...args) => console.error(...args);
    result = await runBenchmark(options);
  } finally { console.log = originalLog; }
  if (options.json) console.log(JSON.stringify(result));
  else {
    console.log(`startup_ms=${result.startup_ms.toFixed(3)}`);
    console.log(`status_req_avg_us=${result.status_req_avg_us.toFixed(3)}`);
    console.log(`status_req_p95_us=${(result.latency_ms.p95 * 1000).toFixed(3)}`);
    console.log(`throughput_rps=${result.throughput_rps.toFixed(3)}`);
    console.log(`successful_requests=${result.successfulRequests}`);
    console.log(`concurrency=${result.concurrency}`);
  }
}

if (require.main === module) {
  main().catch(error => { console.error(`[bench-gateway] ${error.message}`); process.exitCode = 1; });
}

module.exports = { parseArgs, requestStatus };
