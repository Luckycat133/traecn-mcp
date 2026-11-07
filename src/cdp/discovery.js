'use strict';

/* global document */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');
const { TraeCNAutomationError } = require('./errors');
const { CDPClient } = require('./client');
const { getEnvWithFallback, safeClose } = require('../shared/utils');
const { runtimeDefault } = require('../config/runtime-schema');

const DEFAULT_DISCOVERY_PORTS = ['9222', '9223', '9224', '9225', '9226', '9230', '9333', '9334'];

const CDP_REQUEST_TIMEOUT_MS = 5000;

function classifyWorkspaceTarget(target = {}) {
  const url = String(target.url || '').split(/[?#]/, 1)[0].toLowerCase();
  if (!url.startsWith('vscode-file:') && !url.startsWith('vscode-app:')) return null;
  if (url.endsWith('/solo/solo-lite.html')) return 'agent';
  if (url.endsWith('/workbench.html')) return 'workbench';
  return null;
}

function classifyTargetSurface(target = {}) {
  const title = String(target.title || '').toLowerCase();
  const url = String(target.url || '').toLowerCase();

  if (classifyWorkspaceTarget(target)) return 'workspace';
  if (
    url.includes('/setup/setup.html') ||
    title.includes('欢迎使用') ||
    title.includes('选择您的主题') ||
    title.includes('快捷键') ||
    title.includes('添加命令行') ||
    title.includes('登录即可') ||
    title.includes('welcome')
  ) {
    return 'setup';
  }

  if (!url && /trae cn|solo/.test(title)) {
    return 'workspace';
  }

  return 'unknown';
}

// Serialized into Runtime.evaluate, so this function must be self-contained.
function readWorkspaceMode(workspaceKind) {
  if (workspaceKind === 'agent') return 'solo';
  if (document.body?.classList.contains('solo-mode')) return 'solo';
  const activeTab = document.querySelector(
    '.icube-mode-tab-item.active, .icube-mode-tab-item.selected, .icube-mode-tab-item[aria-selected="true"]'
  );
  const label = activeTab?.textContent?.trim().toLowerCase() || '';
  if (/solo|agent/.test(label)) return 'solo';
  if (/ide|编辑器/.test(label)) return 'ide';
  if (document.querySelector('.soloaisidebar')?.getClientRects().length) return 'solo';
  if (document.querySelector('.monaco-workbench')?.getClientRects().length) return 'ide';
  return null;
}

function describeCDPSurface(targets = []) {
  const pages = targets.filter(target => target && target.type === 'page');
  if (pages.length === 0) {
    return {
      kind: 'none',
      title: null,
      url: null,
      targetId: null,
      totalPageTargets: 0
    };
  }

  const scored = pages
    .map(target => {
      const kind = classifyTargetSurface(target);
      const rank = classifyWorkspaceTarget(target) ? 4 : kind === 'workspace' ? 3 : kind === 'setup' ? 2 : 1;
      return { target, kind, rank };
    })
    .sort((left, right) => right.rank - left.rank);

  return {
    kind: scored[0].kind,
    title: scored[0].target.title || null,
    url: scored[0].target.url || null,
    targetId: scored[0].target.id || null,
    totalPageTargets: pages.length
  };
}

/**
 * WebSocket fallback for listing CDP targets via Target.getTargets.
 * `wsPath` comes from App Support/<App>/DevToolsActivePort.
 */
function fetchCDPTargetsWS(host, port, wsPath) {
  return new Promise((resolve, reject) => {
    const wsUrl = `ws://${host}:${port}${wsPath}`;
    let ws;
    try { ws = new WebSocket(wsUrl); } catch (e) { return reject(e); }
    const to = setTimeout(() => {
      try { ws.close(); } catch { /* best-effort close */ }
      reject(new Error('CDP WS /list timed out'));
    }, 5000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }));
    });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.id === 1) {
        clearTimeout(to);
        try { ws.close(); } catch { /* best-effort close */ }
        if (msg.error) return reject(new Error('CDP WS error: ' + (msg.error.message || JSON.stringify(msg.error))));
        resolve((msg.result && msg.result.targetInfos) || []);
      }
    });
    ws.on('error', (e) => { clearTimeout(to); reject(e); });
  });
}

async function fetchCDPTargets(host, port, wsPath) {
  try {
    return await fetchCDPTargetsHTTP(host, port);
  } catch (httpErr) {
    if (wsPath) {
      try { return await fetchCDPTargetsWS(host, port, wsPath); }
      catch { /* fall through */ }
    }
    throw httpErr;
  }
}

async function fetchCDPTargetsHTTP(host, port) {
  return new Promise((resolve, reject) => {
    const url = `http://${host}:${port}/json/list`;
    const req = http.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume(); // drain to free the socket
        reject(new Error(`CDP /json/list returned HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`Failed to parse CDP targets: ${err.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(CDP_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('CDP /json/list request timed out'));
    });
  });
}

/**
 * WebSocket fallback for fetching CDP version. Used when the HTTP
 * /json/version endpoint is unreachable (e.g. sandboxed runtimes
 * where localhost HTTP is proxied but the raw CDP WebSocket is not).
 * `wsPath` comes from the App Support/<App>/DevToolsActivePort file.
 */
function fetchCDPVersionWS(host, port, wsPath) {
  return new Promise((resolve, reject) => {
    const wsUrl = `ws://${host}:${port}${wsPath}`;
    let ws;
    try { ws = new WebSocket(wsUrl); } catch (e) { return reject(e); }
    const to = setTimeout(() => {
      try { ws.close(); } catch { /* best-effort close */ }
      reject(new Error('CDP WS /version timed out'));
    }, 5000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
    });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.id === 1) {
        clearTimeout(to);
        try { ws.close(); } catch { /* best-effort close */ }
        if (msg.error) return reject(new Error('CDP WS error: ' + (msg.error.message || JSON.stringify(msg.error))));
        resolve(msg.result || {});
      }
    });
    ws.on('error', (e) => { clearTimeout(to); reject(e); });
  });
}

async function fetchCDPVersion(host, port, wsPath) {
  try {
    return await fetchCDPVersionHTTP(host, port);
  } catch (httpErr) {
    if (wsPath) {
      try { return await fetchCDPVersionWS(host, port, wsPath); }
      catch { /* fall through to original error */ }
    }
    throw httpErr;
  }
}

async function fetchCDPVersionHTTP(host, port) {
  return new Promise((resolve, reject) => {
    const url = `http://${host}:${port}/json/version`;
    const req = http.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`CDP /json/version returned HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`Failed to parse CDP version: ${err.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(CDP_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('CDP /json/version request timed out'));
    });
  });
}

function isTraeCNVersion(version) {
  const browser = String(version?.Browser || '').toLowerCase();
  const userAgent = String(version?.['User-Agent'] || '').toLowerCase();
  const product = /\btrae(?:\s*cn)?(?=[/\s-]|$)/;
  return product.test(browser) || product.test(userAgent);
}

/**
 * Trae CN may publish its dynamic CDP port and browser WebSocket path in
 * ~/Library/Application Support/Trae CN/DevToolsActivePort.
 */
function readDevToolsActivePort(appName) {
  try {
    const file = path.join(os.homedir(), 'Library', 'Application Support', appName, 'DevToolsActivePort');
    const lines = fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
    const port = Number(lines[0]);
    const wsPath = lines[1] || '';
    if (Number.isInteger(port) && port > 0 && port < 65536) {
      return { port: String(port), wsPath };
    }
  } catch {
    // File absent for this app — not fatal.
  }
  return null;
}

function uniquePorts(...groups) {
  const ports = [];
  for (const group of groups) {
    for (const raw of group || []) {
      const port = String(raw || '').trim();
      if (port && !ports.includes(port)) ports.push(port);
    }
  }
  return ports;
}

async function resolveCDPEndpoint(options = {}) {
  const host = options.host || getEnvWithFallback(
    'TRAECN_CDP_HOST',
    'TRAE_CDP_HOST',
    runtimeDefault('TRAECN_CDP_HOST')
  );
  const configuredPort = options.port || getEnvWithFallback(
    'TRAECN_REMOTE_DEBUGGING_PORT',
    'TRAE_REMOTE_DEBUGGING_PORT',
    runtimeDefault('TRAECN_REMOTE_DEBUGGING_PORT')
  );
  const quickstartPort = getEnvWithFallback('TRAECN_QUICKSTART_REMOTE_DEBUGGING_PORT', 'TRAE_QUICKSTART_REMOTE_DEBUGGING_PORT', '');
  const extraPorts = String(getEnvWithFallback('TRAECN_DISCOVERY_PORTS', 'TRAE_DISCOVERY_PORTS', '') || '')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);

  const devtools = readDevToolsActivePort('Trae CN');
  const wsPathByPort = {};
  if (devtools?.wsPath) wsPathByPort[devtools.port] = devtools.wsPath;

  const ports = uniquePorts(
    [configuredPort],
    [quickstartPort],
    extraPorts,
    [devtools?.port],
    DEFAULT_DISCOVERY_PORTS
  );
  let lastError = null;
  let configuredPortError = null;
  let firstReachable = null;

  for (const port of ports) {
    const wsPath = wsPathByPort[String(port)] || '';
    try {
      const version = await fetchCDPVersion(host, port, wsPath);
      const endpoint = { host, port, version, isTraeCN: isTraeCNVersion(version), wsPathByPort };
      if (!firstReachable) firstReachable = endpoint;
      if (endpoint.isTraeCN) return endpoint;
    } catch (err) {
      lastError = err;
      if (String(port) === String(configuredPort)) {
        configuredPortError = err;
      }
    }
  }

  if (firstReachable) return firstReachable;

  const cause = configuredPortError || lastError;
  throw TraeCNAutomationError.connectionFailed(host, configuredPort, cause ? cause.message : 'No CDP endpoint found');
}

function scoreTarget(target, titleKeywords) {
  let score = 0;
  const title = (target.title || '').toLowerCase();
  const url = (target.url || '').toLowerCase();

  if (target.type === 'page') {
    score += 10;
  }
  if (classifyWorkspaceTarget(target)) score += 100;

  for (const keyword of titleKeywords) {
    if (title.includes(keyword.toLowerCase())) {
      score += 20;
    }
  }

  if (title.includes('chat') || url.includes('chat')) {
    score += 15;
  }

  if (title.includes('devtools')) {
    score -= 50;
  }

  // Penalize target kinds that are not the IDE workbench, so the IDE
  // wins when both a DiffView and the real editor pane are open.
  // These are the targets where Monaco is not (yet) loaded, or where
  // the workbench is showing an AI dialog / setup wizard instead of
  // the file tree.
  if (title.includes('diffview') || title.includes('diff view')) score -= 80;
  if (title.includes('review')) score -= 40;
  if (title.includes('settings') || title.includes('设置') || title.includes('preferences')) score -= 60;
  if (title.includes('welcome') || title.includes('setup') || title.includes('getting started')) score -= 100;
  if (title.includes('login') || title.includes('登录') || title.includes('signin')) score -= 50;
  if (title.includes('update') || title.includes('安装') || title.includes('install')) score -= 30;
  // Slight bonus for titles that look like a real file tab: e.g.
  // "src/foo.js — myproject" or just "myproject". This pushes the IDE
  // workbench ahead of a generic "Trae CN" / "TraeCNClaw" target.
  if (/[\w/\\]+\.\w+/.test(title) || /^[\w.-]+$/.test(title)) {
    score += 5;
  }

  return score;
}

async function discoverTarget(options = {}) {
  const host = getEnvWithFallback('TRAECN_CDP_HOST', 'TRAE_CDP_HOST', runtimeDefault('TRAECN_CDP_HOST'));
  const port = getEnvWithFallback(
    'TRAECN_REMOTE_DEBUGGING_PORT',
    'TRAE_REMOTE_DEBUGGING_PORT',
    runtimeDefault('TRAECN_REMOTE_DEBUGGING_PORT')
  );
  const titleContains = getEnvWithFallback('TRAECN_CDP_TARGET_TITLE_CONTAINS', 'TRAE_CDP_TARGET_TITLE_CONTAINS', 'Trae');
  const urlContains = getEnvWithFallback('TRAECN_CDP_TARGET_URL_CONTAINS', 'TRAE_CDP_TARGET_URL_CONTAINS', '');

  const endpoint = await resolveCDPEndpoint({ host: options.host || host, port: options.port || port });
  const effectiveHost = endpoint.host;
  const effectivePort = endpoint.port;
  if (!endpoint.isTraeCN) {
    throw TraeCNAutomationError.connectionFailed(effectiveHost, effectivePort, 'CDP belongs to a different application');
  }
  const effectiveTitleContains = options.titleContains || titleContains;
  const effectiveUrlContains = options.urlContains || urlContains;

  let targets;
  try {
    targets = await fetchCDPTargets(effectiveHost, effectivePort, (endpoint.wsPathByPort && endpoint.wsPathByPort[String(effectivePort)]) || '');
  } catch (err) {
    throw TraeCNAutomationError.connectionFailed(effectiveHost, effectivePort, err.message);
  }

  const titleKeywords = effectiveTitleContains
    .split(',')
    .map(k => k.trim())
    .filter(Boolean);

  titleKeywords.push('trae cn', 'traecn');

  const urlKeywords = effectiveUrlContains
    .split(',')
    .map(k => k.trim())
    .filter(Boolean);

  const pages = targets
    .filter(t => t.type === 'page' && t.webSocketDebuggerUrl)
    .map(t => ({
      ...t,
      surface: classifyTargetSurface(t),
      workspaceKind: classifyWorkspaceTarget(t),
      score: scoreTarget(t, titleKeywords)
    }))
    .filter(t => !options.surface || t.workspaceKind === options.surface)
    .filter(t => !urlKeywords.length || urlKeywords.some(k => String(t.url || '').toLowerCase().includes(k.toLowerCase())))
    .sort((a, b) => b.score - a.score);

  const workspaces = pages.filter(t => t.surface === 'workspace');
  const knownWorkspaces = workspaces.filter(t => t.workspaceKind);
  const allowSetup = !options.mode && !options.surface;
  const candidates = knownWorkspaces.length ? knownWorkspaces
    : workspaces.length || !allowSetup ? workspaces
      : pages.filter(t => t.surface === 'setup');

  const probeResults = await Promise.allSettled(
    candidates.map(async (candidate) => {
      const client = new CDPClient(candidate.webSocketDebuggerUrl);
      try {
        await client.connect();
        const checkResult = await client.send('Runtime.evaluate', {
          expression: `
            ({
              mode: (${readWorkspaceMode.toString()})(${JSON.stringify(candidate.workspaceKind)}),
              focused: document.hasFocus(),
              visible: document.visibilityState === 'visible',
              composer: !!document.querySelector('.chat-input-v2-input-box-editable')?.getClientRects().length
            })
          `,
          returnByValue: true
        });
        return { candidate, readiness: checkResult.result?.value || {} };
      } finally {
        await safeClose(client);
      }
    })
  );

  // The standalone Agent is the current chat surface. A restored, focused
  // workbench must not take precedence over a visible Agent window.
  const visibleAgent = ({ candidate, readiness }) =>
    Number(candidate.workspaceKind === 'agent' && readiness.visible === true);
  const selected = probeResults
    .filter(result => result.status === 'fulfilled')
    .map(result => result.value)
    .filter(item => !options.mode || item.readiness.mode === options.mode)
    .sort((left, right) => visibleAgent(right) - visibleAgent(left)
      || Number(Boolean(right.readiness.focused)) - Number(Boolean(left.readiness.focused))
      || Number(Boolean(right.readiness.visible)) - Number(Boolean(left.readiness.visible))
      || Number(Boolean(right.readiness.composer)) - Number(Boolean(left.readiness.composer))
      || right.candidate.score - left.candidate.score)[0];
  if (selected) {
    const { candidate, readiness } = selected;
    return {
      ...candidate,
      mode: candidate.surface === 'workspace' ? readiness.mode || null : null,
      cdpVersion: endpoint.version,
      cdpHost: endpoint.host,
      cdpPort: endpoint.port
    };
  }

  throw TraeCNAutomationError.connectionFailed(
    effectiveHost, effectivePort,
    `No matching Trae CN ${options.surface || options.mode || 'workspace or setup'} target found (${candidates.length} candidates probed)`
  );
}

async function connectToTarget(targetInfo) {
  const wsUrl = targetInfo.webSocketDebuggerUrl;
  if (!wsUrl) {
    throw new Error('Target has no WebSocket debugger URL');
  }

  const client = new CDPClient(wsUrl);
  try {
    await client.connect();
    await client.send('DOM.enable');
    await client.send('Runtime.enable');
  } catch (err) {
    await client.close();
    throw err;
  }

  return client;
}

module.exports = {
  DEFAULT_DISCOVERY_PORTS,
  classifyTargetSurface,
  classifyWorkspaceTarget,
  describeCDPSurface,
  fetchCDPTargets,
  fetchCDPVersion,
  isTraeCNVersion,
  resolveCDPEndpoint,
  scoreTarget,
  readWorkspaceMode,
  discoverTarget,
  connectToTarget
};
