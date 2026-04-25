'use strict';

const http = require('http');
const { TraeCNAutomationError } = require('./errors');
const { CDPClient } = require('./client');
const dom = require('./browser-dom');
const { DomDriver } = require('./dom-driver');
const { getEnvWithFallback } = require('../shared/utils');

async function fetchCDPTargets(host, port) {
  return new Promise((resolve, reject) => {
    const url = `http://${host}:${port}/json/list`;
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`Failed to parse CDP targets: ${err.message}`));
        }
      });
    }).on('error', reject);
  });
}

async function fetchCDPVersion(host, port) {
  return new Promise((resolve, reject) => {
    const url = `http://${host}:${port}/json/version`;
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`Failed to parse CDP version: ${err.message}`));
        }
      });
    }).on('error', reject);
  });
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

  const effectiveHost = options.host || host;
  const effectivePort = options.port || port;
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

  // Try candidates in score order; pick the first one with composer + send button + response content
  for (const candidate of candidates) {
    let client = null;
    try {
      client = new CDPClient(candidate.webSocketDebuggerUrl);
      await client.connect();
      await client.send('DOM.enable');
      await client.send('Runtime.enable');
      const driver = new DomDriver(client);
      const readiness = await driver.checkReadiness();

      if (readiness.composer && readiness.sendButton) {
        const hasContent = await validateTargetHasContent(client, readiness);
        await client.close();
        if (hasContent) {
          return {
            id: candidate.id,
            title: candidate.title,
            url: candidate.url,
            webSocketDebuggerUrl: candidate.webSocketDebuggerUrl,
            score: candidate.score
          };
        }
      } else {
        await client.close();
      }
    } catch {
      if (client) {
        try { await client.close(); } catch { /* ignore */ }
      }
    }
  }

  // Fall back to highest-scored candidate
  const best = candidates[0];
  return {
    id: best.id,
    title: best.title,
    url: best.url,
    webSocketDebuggerUrl: best.webSocketDebuggerUrl,
    score: best.score
  };
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
  fetchCDPTargets,
  fetchCDPVersion,
  scoreTarget,
  discoverTarget,
  connectToTarget
};
