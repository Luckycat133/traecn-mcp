'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');

const { parseEnv } = require('../src/config/env');
const { readRuntimeEnv, runtimeDefault } = require('../src/config/runtime-schema');
const { isLoopbackHost } = require('../src/shared/utils');

const root = path.resolve(__dirname, '..');
const envPath = path.join(root, '.env');
const packageJson = require('../package.json');

const MIN_NODE_MAJOR = parseMinimumNodeMajor(packageJson.engines && packageJson.engines.node) || 22;
const DEFAULT_GATEWAY_HOST = runtimeDefault('TRAECN_GATEWAY_HOST');
const DEFAULT_GATEWAY_PORT = runtimeDefault('TRAECN_GATEWAY_PORT');
const DEFAULT_CDP_HOST = runtimeDefault('TRAECN_CDP_HOST');
const DEFAULT_CDP_PORT = runtimeDefault('TRAECN_REMOTE_DEBUGGING_PORT');
const TRAECN_APP_PATH = '/Applications/Trae CN.app';
const REQUEST_TIMEOUT_MS = 1200;

async function main() {
  const checks = [];
  const envFile = readEnvFile(checks);
  const env = { ...envFile.values, ...process.env };

  checkNodeVersion(checks);
  checkNpm(checks);
  checkEnvFile(checks, envFile.exists);

  const gateway = checkGatewayConfig(checks, env);
  const mockBridge = checkMockBridge(checks, env);
  const cdp = checkCdpConfig(checks, env);

  if (gateway.valid) {
    await checkPort(checks, 'Gateway port', gateway.host, gateway.port, {
      warning: `No listener detected on ${gateway.connectHost}:${gateway.port}; start the gateway with npm run start:gateway when needed.`
    });
    await checkGatewayStatus(checks, gateway);
  } else {
    add(checks, 'WARN', 'Gateway runtime checks', 'Skipped because HOST/PORT configuration is invalid.');
  }

  if (cdp.valid) {
    await checkPort(checks, 'CDP port', cdp.host, cdp.port, {
      warning: `No listener detected on ${cdp.connectHost}:${cdp.port}; Trae CN may not be running with remote debugging enabled. Prefer "TRAECN_QUICKSTART_PROFILE_MODE=existing npm run start:traecn -- --force-new --use-existing-profile" so automation reuses the logged-in profile.`
    });
    await checkCdpVersion(checks, cdp, mockBridge.enabled);
  } else {
    add(checks, 'WARN', 'CDP runtime checks', 'Skipped because CDP host/port configuration is invalid.');
  }

  checkTraeCnApp(checks);
  printChecks(checks);

  const criticalFailures = checks.filter(check => check.status === 'FAIL' && check.critical);
  process.exitCode = criticalFailures.length > 0 ? 1 : 0;
}

function readEnvFile(checks) {
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    return { exists: true, values: parseEnv(content) };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { exists: false, values: {} };
    }
    add(checks, 'FAIL', '.env readable', `Could not read ${envPath}: ${err.message}`, true);
    return { exists: false, values: {} };
  }
}

function checkNodeVersion(checks) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= MIN_NODE_MAJOR) {
    add(checks, 'PASS', 'Node.js version', `${process.version} satisfies >=${MIN_NODE_MAJOR}.`);
    return;
  }

  add(checks, 'FAIL', 'Node.js version', `${process.version} is below required >=${MIN_NODE_MAJOR}.`, true);
}

function checkNpm(checks) {
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    const version = childProcess.execFileSync(npmBin, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    add(checks, 'PASS', 'npm available', `npm ${version} found on PATH.`);
  } catch (err) {
    add(checks, 'FAIL', 'npm available', `Could not run npm --version: ${err.message}`, true);
  }
}

function checkEnvFile(checks, exists) {
  if (exists) {
    add(checks, 'PASS', '.env file', `${envPath} exists.`);
    return;
  }

  add(checks, 'WARN', '.env file', `${envPath} is missing; defaults and shell environment will be used.`);
}

function checkGatewayConfig(checks, env) {
  const host = readRuntimeEnv('TRAECN_GATEWAY_HOST', env);
  const portRaw = readRuntimeEnv('TRAECN_GATEWAY_PORT', env);
  const token = readRuntimeEnv('TRAECN_GATEWAY_TOKEN', env);
  const parsed = parsePort(portRaw);

  if (!host) {
    add(checks, 'FAIL', 'Gateway HOST', 'HOST is empty.', true);
  } else {
    add(checks, 'PASS', 'Gateway HOST', `Using ${host}.`);
  }

  if (!parsed.valid) {
    add(checks, 'FAIL', 'Gateway PORT', `PORT must be an integer from 1 to 65535; received ${JSON.stringify(portRaw)}.`, true);
  } else {
    add(checks, 'PASS', 'Gateway PORT', `Using ${parsed.value}.`);
  }

  if (!token && !isLoopbackHost(host)) {
    add(
      checks,
      'FAIL',
      'Gateway authentication',
      `Non-loopback bind ${host} requires TRAECN_GATEWAY_TOKEN.`,
      true
    );
  } else {
    add(
      checks,
      'PASS',
      'Gateway authentication',
      token ? 'Authentication token is configured.' : 'Tokenless access is restricted to loopback.'
    );
  }

  return {
    ...normalizeTarget(host || DEFAULT_GATEWAY_HOST, parsed.valid ? parsed.value : Number(DEFAULT_GATEWAY_PORT)),
    valid: Boolean(host) && parsed.valid
  };
}

function checkMockBridge(checks, env) {
  const raw = readRuntimeEnv('TRAECN_ENABLE_MOCK_BRIDGE', env);
  const enabled = raw === '1' || String(raw).toLowerCase() === 'true';
  const label = enabled ? 'enabled' : 'disabled';
  add(checks, 'PASS', 'TRAECN_ENABLE_MOCK_BRIDGE', `${label} (${raw}).`);
  return { enabled, raw };
}

function checkCdpConfig(checks, env) {
  const host = readRuntimeEnv('TRAECN_CDP_HOST', env);
  const portRaw = readRuntimeEnv('TRAECN_REMOTE_DEBUGGING_PORT', env);
  const parsed = parsePort(portRaw);

  if (!host) {
    add(checks, 'FAIL', 'CDP host', 'TRAECN_CDP_HOST/TRAE_CDP_HOST is empty.', true);
  } else {
    add(checks, 'PASS', 'CDP host', `Using ${host}.`);
  }

  if (!parsed.valid) {
    add(checks, 'FAIL', 'CDP port', `TRAECN_REMOTE_DEBUGGING_PORT/TRAE_REMOTE_DEBUGGING_PORT must be an integer from 1 to 65535; received ${JSON.stringify(portRaw)}.`, true);
  } else {
    add(checks, 'PASS', 'CDP port', `Using ${parsed.value}.`);
  }

  return {
    ...normalizeTarget(host || DEFAULT_CDP_HOST, parsed.valid ? parsed.value : Number(DEFAULT_CDP_PORT)),
    valid: Boolean(host) && parsed.valid
  };
}

async function checkPort(checks, label, host, port, options) {
  const target = normalizeTarget(host, port);
  try {
    await canConnect(target.connectHost, target.port);
    add(checks, 'PASS', label, `${target.connectHost}:${target.port} is accepting TCP connections.`);
  } catch {
    add(checks, 'WARN', label, options.warning);
  }
}

async function checkGatewayStatus(checks, gateway) {
  const url = buildUrl(gateway, '/api/status');
  try {
    const response = await requestJson(url);
    if (response.statusCode >= 200 && response.statusCode < 300) {
      add(checks, 'PASS', 'Gateway /api/status', `${url} returned HTTP ${response.statusCode}.`);
      return;
    }

    add(checks, 'WARN', 'Gateway /api/status', `${url} returned HTTP ${response.statusCode}.`);
  } catch (err) {
    add(checks, 'WARN', 'Gateway /api/status', `${url} is not reachable: ${err.message}`);
  }
}

async function checkCdpVersion(checks, cdp, mockBridgeEnabled) {
  const url = buildUrl(cdp, '/json/version');
  try {
    const response = await requestJson(url);
    if (response.statusCode >= 200 && response.statusCode < 300) {
      const browser = response.body && response.body.Browser ? ` (${response.body.Browser})` : '';
      const userAgent = response.body && response.body['User-Agent'] ? response.body['User-Agent'] : '';
      if (looksLikeTraeCN(response.body)) {
        add(checks, 'PASS', 'CDP /json/version', `${url} returned HTTP ${response.statusCode}${browser}.`);
      } else {
        const suffix = mockBridgeEnabled ? ' Mock bridge mode can continue, but live mode would connect to the wrong app.' : ' Live mode may connect to the wrong app.';
        add(checks, 'WARN', 'CDP /json/version', `${url} is reachable${browser}, but it does not look like TraeCN. User-Agent: ${userAgent || 'unknown'}.${suffix}`);
      }
      return;
    }

    add(checks, 'WARN', 'CDP /json/version', `${url} returned HTTP ${response.statusCode}.`);
  } catch (err) {
    const suffix = mockBridgeEnabled ? ' Mock bridge mode can continue without live CDP.' : '';
    add(checks, 'WARN', 'CDP /json/version', `${url} is not reachable: ${err.message}.${suffix}`);
  }
}

function looksLikeTraeCN(body) {
  const browser = String((body && body.Browser) || '').toLowerCase();
  const userAgent = String((body && body['User-Agent']) || '').toLowerCase();
  return browser.includes('trae') || userAgent.includes('traecn') || userAgent.includes('trae cn');
}

function checkTraeCnApp(checks) {
  if (fs.existsSync(TRAECN_APP_PATH)) {
    add(checks, 'PASS', 'Trae CN app', `${TRAECN_APP_PATH} exists.`);
    return;
  }

  add(checks, 'WARN', 'Trae CN app', `${TRAECN_APP_PATH} was not found; mock bridge mode does not require it.`);
}

function canConnect(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('connection timed out'));
    }, REQUEST_TIMEOUT_MS);

    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, { timeout: REQUEST_TIMEOUT_MS }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        data += chunk;
      });
      res.on('end', () => {
        let body = null;
        if (data) {
          try {
            body = JSON.parse(data);
          } catch {
            body = null;
          }
        }
        resolve({ statusCode: res.statusCode, body });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('request timed out'));
    });
    req.on('error', reject);
  });
}

function normalizeTarget(host, port) {
  if (/^https?:\/\//.test(host)) {
    const parsed = new URL(host);
    return {
      host,
      connectHost: parsed.hostname,
      port: port || Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80),
      protocol: parsed.protocol
    };
  }

  const connectHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return {
    host,
    connectHost,
    port,
    protocol: 'http:'
  };
}

function buildUrl(target, pathname) {
  if (/^https?:\/\//.test(target.host)) {
    const url = new URL(target.host);
    url.pathname = pathname;
    url.search = '';
    url.hash = '';
    if (target.port && !url.port) {
      url.port = String(target.port);
    }
    return url;
  }

  return new URL(`${target.protocol}//${target.connectHost}:${target.port}${pathname}`);
}

function parsePort(raw) {
  const value = Number(raw);
  return {
    value,
    valid: Number.isInteger(value) && value >= 1 && value <= 65535
  };
}

function parseMinimumNodeMajor(range) {
  if (!range) return null;
  const match = String(range).match(/>=\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

function add(checks, status, name, detail, critical = false) {
  checks.push({ status, name, detail, critical });
}

function printChecks(checks) {
  const width = Math.max(...checks.map(check => check.status.length));
  console.log('TraeCN MCP doctor');
  console.log('');
  for (const check of checks) {
    const status = check.status.padEnd(width, ' ');
    console.log(`${status} ${check.name} - ${check.detail}`);
  }

  const counts = checks.reduce((acc, check) => {
    acc[check.status] = (acc[check.status] || 0) + 1;
    return acc;
  }, {});
  console.log('');
  console.log(`Summary: ${counts.PASS || 0} PASS, ${counts.WARN || 0} WARN, ${counts.FAIL || 0} FAIL`);
}

main().catch(err => {
  console.error('FAIL doctor crashed -', err.message);
  process.exit(1);
});
