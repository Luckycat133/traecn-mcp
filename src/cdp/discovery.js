'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { TraeCNAutomationError } = require('./errors');
const { CDPClient } = require('./client');
const { getEnvWithFallback, safeClose } = require('../shared/utils');

const DEFAULT_DISCOVERY_PORTS = ['9222', '9223', '9224', '9225', '9226', '9230', '9333', '9334'];

function classifyTargetSurface(target = {}) {
  const title = String(target.title || '').toLowerCase();
  const url = String(target.url || '').toLowerCase();

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

  if (
    url.includes('/workbench/workbench.html') ||
    url.includes('/electron-sandbox/workbench/workbench.html') ||
    url.includes('/workbench.html') ||
    title.includes('trae cn') ||
    title.includes('solo')
  ) {
    return 'workspace';
  }

  return 'unknown';
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
      const rank = kind === 'workspace' ? 3 : kind === 'setup' ? 2 : 1;
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

async function fetchCDPTargets(host, port) {
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
    req.setTimeout(5000, () => {
      req.destroy(new Error('CDP /json/list request timed out'));
    });
  });
}

async function fetchCDPVersion(host, port) {
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
    req.setTimeout(5000, () => {
      req.destroy(new Error('CDP /json/version request timed out'));
    });
  });
}

function isTraeCNVersion(version) {
  const browser = String(version?.Browser || '').toLowerCase();
  const userAgent = String(version?.['User-Agent'] || '').toLowerCase();
  return (
    browser.includes('trae') ||
    userAgent.includes('traecn') ||
    userAgent.includes('trae cn') ||
    // Trae CN's agent runtime ("Antigravity") exposes its own Chromium
    // DevTools port on a dynamic port; treat it as a valid TraeCN surface.
    userAgent.includes('antigravity')
  );
}

/**
 * Trae CN's "Antigravity" agent runtime opens a Chromium DevTools (CDP)
 * endpoint on a per-session port, persisted in
 * ~/Library/Application Support/Antigravity/DevToolsActivePort (first line
 * is the port). This is the working CDP surface on builds that no longer
 * forward --remote-debugging-port to the IDE process.
 * @returns {string} port string, or '' if not available
 */
function getAntigravityDevToolsPort() {
  try {
    const file = path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort');
    const raw = fs.readFileSync(file, 'utf8').split('\n')[0].trim();
    const port = Number(raw);
    if (Number.isInteger(port) && port > 0 && port < 65536) return String(port);
  } catch {
    // File absent on builds without the Antigravity runtime — not fatal.
  }
  return '';
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
  const host = options.host || getEnvWithFallback('TRAECN_CDP_HOST', 'TRAE_CDP_HOST', '127.0.0.1');
  const configuredPort = options.port || getEnvWithFallback('TRAECN_REMOTE_DEBUGGING_PORT', 'TRAE_REMOTE_DEBUGGING_PORT', '9222');
  const quickstartPort = getEnvWithFallback('TRAECN_QUICKSTART_REMOTE_DEBUGGING_PORT', 'TRAE_QUICKSTART_REMOTE_DEBUGGING_PORT', '');
  const extraPorts = String(getEnvWithFallback('TRAECN_DISCOVERY_PORTS', 'TRAE_DISCOVERY_PORTS', '') || '')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);

  const antigravityPort = getAntigravityDevToolsPort();

  const ports = uniquePorts(
    [configuredPort],
    [quickstartPort],
    extraPorts,
    [antigravityPort],
    DEFAULT_DISCOVERY_PORTS
  );
  let lastError = null;
  let configuredPortError = null;
  let firstReachable = null;

  for (const port of ports) {
    try {
      const version = await fetchCDPVersion(host, port);
      const endpoint = { host, port, version, isTraeCN: isTraeCNVersion(version) };
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

async function validateTargetHasContent(client, readiness) {
  // Check if response region has actual text content
  if (!readiness.responseRegion) return false;
  try {
    const sel = readiness.responseRegion.matchedSelector.replace(/'/g, "\\'");
    const r = await client.send('Runtime.evaluate', {
      expression: `document.querySelector('${sel}')?.textContent?.trim() || ''`,
      returnByValue: true
    });
    return !!(r.result?.value && r.result.value.length > 0);
  } catch {
    return false;
  }
}

async function discoverTarget(options = {}) {
  const host = getEnvWithFallback('TRAECN_CDP_HOST', 'TRAE_CDP_HOST', '127.0.0.1');
  const port = getEnvWithFallback('TRAECN_REMOTE_DEBUGGING_PORT', 'TRAE_REMOTE_DEBUGGING_PORT', '9222');
  const titleContains = getEnvWithFallback('TRAECN_CDP_TARGET_TITLE_CONTAINS', 'TRAE_CDP_TARGET_TITLE_CONTAINS', 'Trae');
  const urlContains = getEnvWithFallback('TRAECN_CDP_TARGET_URL_CONTAINS', 'TRAE_CDP_TARGET_URL_CONTAINS', '');

  const endpoint = await resolveCDPEndpoint({ host: options.host || host, port: options.port || port });
  const effectiveHost = endpoint.host;
  const effectivePort = endpoint.port;
  const effectiveTitleContains = options.titleContains || titleContains;
  const effectiveUrlContains = options.urlContains || urlContains;

  let targets;
  try {
    targets = await fetchCDPTargets(effectiveHost, effectivePort);
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

  let candidates = targets
    .filter(t => t.type === 'page')
    .map(t => ({
      ...t,
      score: scoreTarget(t, titleKeywords)
    }))
    .sort((a, b) => b.score - a.score);

  if (urlKeywords.length > 0) {
    candidates = candidates.filter(t => {
      const targetUrl = (t.url || '').toLowerCase();
      return urlKeywords.some(k => targetUrl.includes(k.toLowerCase()));
    });
  }

  // If no title-matched candidates, fall back to any page with SOLO Coder UI
  if (candidates.length === 0) {
    candidates = targets
      .filter(t => t.type === 'page')
      .map(t => ({ ...t, score: 0 }));
  }

  const bestCandidate = candidates[0];

  const safeComposerSels = JSON.stringify([
    '.chat-input-v2-input-box-editable', 'textarea', "[contenteditable='true']",
    "input[type='text']", "[class*='chat-input']", "[class*='input-box']"
  ]);
  const safeSendSels = JSON.stringify([
    'button.chat-input-v2-send-button', "button[data-testid*='send']",
    "button[aria-label*='Send']", "button[aria-label*='发送']",
    "button[type='submit']", "[class*='send-button']", "[class*='send']"
  ]);

  const probeResults = await Promise.allSettled(
    candidates.map(async (candidate) => {
      const client = new CDPClient(candidate.webSocketDebuggerUrl);
      await client.connect();
      try {
        await client.send('DOM.enable');
        await client.send('Runtime.enable');

        const checkResult = await client.send('Runtime.evaluate', {
          expression: `
            (function() {
              var composerSels = ${safeComposerSels};
              var sendSels = ${safeSendSels};
              var composer = null, sendBtn = null;
              for (var i = 0; i < composerSels.length; i++) {
                var el = document.querySelector(composerSels[i]);
                if (el) { composer = { sel: composerSels[i], visible: el.getBoundingClientRect().width > 20 && el.getBoundingClientRect().height > 15 && el.offsetParent !== null }; break; }
              }
              for (var j = 0; j < sendSels.length; j++) {
                var btn = document.querySelector(sendSels[j]);
                if (btn) { sendBtn = { sel: sendSels[j] }; break; }
              }
              return { composer: composer, sendButton: sendBtn };
            })()
          `,
          returnByValue: true
        });

        return { candidate, client, readiness: checkResult.result?.value || {} };
      } catch (err) {
        // Close the client on probe failure so we don't leak WebSockets.
        // Without this, a connected-but-rejected client is never closed
        // because it's not in the `live` array.
        await safeClose(client);
        throw err;
      }
    })
  );

  const live = [];
  for (const r of probeResults) {
    if (r.status === 'fulfilled') live.push(r.value);
  }

  // Preserve the score ordering from `candidates` instead of returning the
  // first probe to complete — that ordering already knows which target is
  // most likely the real IDE workbench, while Promise.allSettled returns
  // results in completion order which has nothing to do with suitability.
  live.sort((a, b) => (b.candidate.score || 0) - (a.candidate.score || 0));

  function buildTarget(p) {
    return {
      id: p.candidate.id, title: p.candidate.title, url: p.candidate.url,
      webSocketDebuggerUrl: p.candidate.webSocketDebuggerUrl, score: p.candidate.score
    };
  }

  const p1 = live.find(p => p.readiness.composer && p.readiness.sendButton);
  if (p1) {
    const target = buildTarget(p1);
    await Promise.all(live.map(p => safeClose(p.client)));
    return target;
  }

  const p2 = live.find(p => p.readiness.composer && p.readiness.composer.visible);
  if (p2) {
    const target = buildTarget(p2);
    await Promise.all(live.map(p => safeClose(p.client)));
    return target;
  }

  if (live.length > 0) {
    const target = buildTarget(live[0]);
    await Promise.all(live.map(p => safeClose(p.client)));
    return target;
  }

  return bestCandidate;
}

async function connectToTarget(targetInfo) {
  const wsUrl = targetInfo.webSocketDebuggerUrl;
  if (!wsUrl) {
    throw new Error('Target has no WebSocket debugger URL');
  }

  const client = new CDPClient(wsUrl);
  await client.connect();
  await client.send('DOM.enable');
  await client.send('Runtime.enable');

  return client;
}

module.exports = {
  DEFAULT_DISCOVERY_PORTS,
  classifyTargetSurface,
  describeCDPSurface,
  fetchCDPTargets,
  fetchCDPVersion,
  isTraeCNVersion,
  resolveCDPEndpoint,
  scoreTarget,
  discoverTarget,
  connectToTarget
};
