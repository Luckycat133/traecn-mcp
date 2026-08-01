'use strict';

const { classifyTargetSurface } = require('../cdp/discovery');

function normalizedVersion(value) {
  const match = String(value || '').match(/\b(\d+\.\d+\.\d+(?:\.\d+)?)\b/);
  return match ? match[1] : null;
}

function parseTraeVersion(input = {}) {
  for (const key of ['traeVersion', 'productVersion', 'applicationVersion', 'appVersion']) {
    const direct = normalizedVersion(input[key]);
    if (direct) return direct;
  }

  for (const value of [input.Browser, input['User-Agent'], input.product, input.name]) {
    const match = String(value || '').match(
      /(?:trae\s*cn|traecn|trae)[/\s-]+v?(\d+\.\d+\.\d+(?:\.\d+)?)/i
    );
    if (match) return match[1];
  }
  return null;
}

async function probeProductEnvironment(client) {
  if (!client || typeof client.send !== 'function') return {};
  try {
    const response = await client.send('Runtime.evaluate', {
      expression: `
        (() => {
          const product = window._VSCODE_PRODUCT_JSON
            || window.__TRAECN_PRODUCT_JSON__
            || window.__icube_product__
            || {};
          const versionMeta = document.querySelector(
            'meta[name="application-version"], meta[name="app-version"], meta[name="product-version"]'
          );
          const visible = element => !!(element && element.offsetParent !== null);
          const activeTabs = Array.from(document.querySelectorAll('.icube-mode-tab-item'));
          const activeTab = activeTabs.find(tab => {
            const classes = String(tab.className || '');
            return /(?:^|\\s)(?:active|selected)(?:\\s|$)/.test(classes)
              || tab.getAttribute('aria-selected') === 'true';
          });
          const activeText = String(activeTab?.innerText || activeTab?.textContent || '').toLowerCase();
          const soloSidebar = document.querySelector('.soloaisidebar');
          let mode = null;
          if (activeText.includes('ide')) mode = 'ide';
          else if (activeText.includes('solo')) mode = 'solo';
          else if (visible(soloSidebar)) mode = 'solo';
          else if (visible(document.querySelector('.monaco-workbench, .monaco-editor'))) mode = 'ide';

          const controls = Array.from(document.querySelectorAll('button, [role="button"]'));
          const controlText = controls
            .filter(visible)
            .map(item => String(item.innerText || item.textContent || '').trim())
            .join('\n');
          return {
            productName: String(product.nameLong || product.nameShort || product.applicationName || 'Trae CN'),
            productVersion: String(
              product.version
              || product.applicationVersion
              || document.documentElement?.dataset?.version
              || versionMeta?.content
              || ''
            ),
            mode,
            structures: {
              composer: visible(document.querySelector('.chat-input-v2-input-box-editable, textarea, [contenteditable="true"]')),
              conversationIdentity: !!document.querySelector('[data-conversation-id], [data-chat-id], .solo-chat-item'),
              reviewGate: /全部保留|全部撤销|Keep All|Discard All/i.test(controlText),
              settingsUI: !!document.querySelector('[class*="settings"], [class*="preferences"], [data-settings-section]')
            }
          };
        })()
      `,
      returnByValue: true
    });
    const value = response?.result?.value;
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

async function detectTraeEnvironment(options = {}) {
  const cdpVersion = options.cdpVersion && typeof options.cdpVersion === 'object'
    ? options.cdpVersion
    : {};
  const target = options.target && typeof options.target === 'object' ? options.target : {};
  const product = options.productProbe && typeof options.productProbe === 'object'
    ? options.productProbe
    : await probeProductEnvironment(options.client);
  const productVersion = parseTraeVersion(product);
  const cdpDetectedVersion = parseTraeVersion(cdpVersion);

  return {
    product: String(product.productName || 'Trae CN'),
    traeVersion: productVersion || cdpDetectedVersion || null,
    platform: String(options.platform || process.platform),
    mode: ['solo', 'ide'].includes(product.mode) ? product.mode : null,
    cdp: {
      browser: cdpVersion.Browser || null,
      protocolVersion: cdpVersion['Protocol-Version'] || null
    },
    target: {
      title: target.title || null,
      surface: classifyTargetSurface(target)
    },
    structures: product.structures && typeof product.structures === 'object'
      ? { ...product.structures }
      : {},
    versionSource: productVersion ? 'product' : (cdpDetectedVersion ? 'cdp' : 'unknown')
  };
}

module.exports = {
  detectTraeEnvironment,
  parseTraeVersion,
  probeProductEnvironment
};
