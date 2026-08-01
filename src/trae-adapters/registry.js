'use strict';

const known107Capabilities = require('./traecn-1.107/capabilities');
const known107Selectors = require('./traecn-1.107/selectors');

const EMPTY_CAPABILITIES = Object.freeze({
  conversationIdentity: false,
  reviewGate: false,
  settingsUI: false,
  structuredTaskState: false,
  fixtureReplay: false
});

const DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'traecn-1.107',
    compatibility: 'verified',
    versionPattern: /^1\.107(?:\.|$)/,
    platforms: Object.freeze(['darwin']),
    capabilities: known107Capabilities,
    selectors: known107Selectors,
    evidence: 'docs/REAL-DOM-FINDINGS.md',
    warnings: Object.freeze([])
  }),
  Object.freeze({
    id: 'traecn-unknown',
    compatibility: 'degraded',
    versionPattern: null,
    platforms: Object.freeze([]),
    capabilities: EMPTY_CAPABILITIES,
    selectors: Object.freeze({}),
    evidence: null,
    warnings: Object.freeze([
      'This TraeCN version/platform is not verified; generic DOM fallbacks remain best-effort.'
    ])
  })
]);

function cloneDefinition(definition, environment = {}) {
  return {
    id: definition.id,
    compatibility: definition.compatibility,
    capabilities: { ...definition.capabilities },
    selectors: Object.fromEntries(
      Object.entries(definition.selectors).map(([key, values]) => [key, [...values]])
    ),
    evidence: definition.evidence,
    warnings: [...definition.warnings],
    environment: { ...environment }
  };
}

function selectTraeAdapter(environment = {}) {
  const version = String(environment.traeVersion || '');
  const platform = String(environment.platform || process.platform);
  const matched = DEFINITIONS.find(definition => definition.versionPattern
    && definition.versionPattern.test(version)
    && definition.platforms.includes(platform));
  return cloneDefinition(matched || DEFINITIONS.at(-1), environment);
}

function mergeAdapterConfig(baseConfig = {}, adapter = {}) {
  const merged = { ...baseConfig };
  for (const [key, values] of Object.entries(adapter.selectors || {})) {
    const existing = Array.isArray(baseConfig[key]) ? baseConfig[key] : [];
    merged[key] = [...new Set([...(values || []), ...existing])];
  }
  return merged;
}

function adapterHandshake(adapter = {}) {
  const environment = adapter.environment || {};
  return {
    traeVersion: environment.traeVersion || null,
    platform: environment.platform || process.platform,
    adapter: adapter.id || 'traecn-unknown',
    mode: environment.mode || null,
    compatibility: adapter.compatibility || 'degraded',
    verified: adapter.compatibility === 'verified',
    capabilities: { ...(adapter.capabilities || EMPTY_CAPABILITIES) },
    warnings: [...(adapter.warnings || [])],
    evidence: adapter.evidence || null,
    versionSource: environment.versionSource || 'unknown'
  };
}

function listTraeAdapters() {
  return DEFINITIONS.map(definition => ({
    id: definition.id,
    compatibility: definition.compatibility,
    platforms: [...definition.platforms],
    evidence: definition.evidence
  }));
}

module.exports = {
  adapterHandshake,
  listTraeAdapters,
  mergeAdapterConfig,
  selectTraeAdapter
};
