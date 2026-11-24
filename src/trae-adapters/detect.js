'use strict';

const { classifyTargetSurface, classifyWorkspaceTarget, readWorkspaceMode } = require('../cdp/discovery');

function normalizedVersion(value) {
  const match = String(value || '').match(/\b(\d+\.\d+\.\d+(?:\.\d+)?)\b/);
  return match ? match[1] : null;
}

function parseTraeVersion(input = {}) {
  for (const key of ['traeVersion', 'productVersion', 'applicationVersion']) {
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

async function probeProductEnvironment(client, workspaceKind = null) {
  if (!client || typeof client.send !== 'function') return {};
  try {
    const response = await client.send('Runtime.evaluate', {
      expression: `
        (async () => {
          let configuration;
          try {
            configuration = await window.vscode?.context?.configuration?.();
          } catch {
            // Older renderers may expose only the product globals.
          }
          const product = configuration?.product
            || window._VSCODE_PRODUCT_JSON
            || window.__TRAECN_PRODUCT_JSON__
            || window.__icube_product__
            || {};
          const versionMeta = document.querySelector(
            'meta[name="application-version"], meta[name="app-version"], meta[name="product-version"]'
          );
          const visible = element => Boolean(element?.getClientRects().length);

          const controls = Array.from(document.querySelectorAll('button, [role="button"]'));
          const reviewGate = controls.some(item => visible(item)
            && /全部保留|全部撤销|Keep All|Discard All/i.test(item.innerText || item.textContent || ''));
          return {
            productName: String(product.nameLong || product.nameShort || product.applicationName || 'Trae CN'),
            productVersion: String(
              product.version
              || product.applicationVersion
              || document.documentElement?.dataset?.version
              || versionMeta?.content
              || ''
            ),
            appVersion: String(product.appVersion || ''),
            mode: (${readWorkspaceMode.toString()})(${JSON.stringify(workspaceKind)}),
            structures: {
              composer: visible(document.querySelector('.chat-input-v2-input-box-editable, textarea, [contenteditable="true"]')),
              conversationIdentity: !!document.querySelector('[data-conversation-id], [data-chat-id], .solo-chat-item'),
              reviewGate,
              settingsUI: !!document.querySelector('[class*="settings"], [class*="preferences"], [data-settings-section]')
            }
          };
        })()
      `,
      returnByValue: true,
      awaitPromise: true
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
  const surface = classifyTargetSurface(target);
  const workspaceKind = classifyWorkspaceTarget(target);
  const product = options.productProbe && typeof options.productProbe === 'object'
    ? options.productProbe
    : await probeProductEnvironment(options.client, workspaceKind);
  const productVersion = parseTraeVersion(product);
  const cdpDetectedVersion = parseTraeVersion(cdpVersion);

  return {
    product: String(product.productName || 'Trae CN'),
    traeVersion: productVersion || cdpDetectedVersion || null,
    appVersion: normalizedVersion(product.appVersion),
    platform: String(options.platform || process.platform),
    mode: surface === 'workspace' && ['solo', 'ide'].includes(product.mode) ? product.mode : null,
    cdp: {
      browser: cdpVersion.Browser || null,
      protocolVersion: cdpVersion['Protocol-Version'] || null
    },
    target: {
      title: target.title || null,
      surface,
      workspaceKind
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
