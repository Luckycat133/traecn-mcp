'use strict';

const known107Capabilities = require('./traecn-1.107/capabilities');
const known107Selectors = require('./traecn-1.107/selectors');
const standaloneAgentSelectors = require('./traecn-3.4.11/selectors');
const OBSERVED_AGENT_VERSIONS = Object.freeze(['3.4.15', '3.4.11']);

function isKnownStandaloneAgentVersion(appVersion) {
  return OBSERVED_AGENT_VERSIONS.includes(appVersion);
}

const EMPTY_CAPABILITIES = Object.freeze({
  conversationIdentity: false,
  reviewGate: false,
  settingsUI: false,
  structuredTaskState: false,
  fixtureReplay: false
});

const DEFINITIONS = Object.freeze([
  ...OBSERVED_AGENT_VERSIONS.map(appVersion => Object.freeze({
    id: 'traecn-' + appVersion,
    compatibility: 'degraded',
    appVersion,
    versionKey: 'appVersion',
    platforms: Object.freeze(['darwin']),
    capabilities: EMPTY_CAPABILITIES,
    selectors: standaloneAgentSelectors,
    evidence: 'docs/REAL-DOM-FINDINGS.md',
    warnings: Object.freeze([
      'Trae CN ' + appVersion + ' workspace structure was observed on macOS. Full task execution is not verified.'
    ])
  })),
  Object.freeze({
    id: 'traecn-1.107',
    compatibility: 'verified',
    versionPattern: /^1\.107(?:\.|$)/,
    versionKey: 'traeVersion',
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
  const fallback = DEFINITIONS.at(-1);
  if (environment.target && environment.target.surface !== 'workspace') {
    return cloneDefinition(fallback, environment);
  }
  const platform = String(environment.platform || process.platform);
  // An Agent window or an explicit app version must not inherit verified
  // compatibility merely because the Electron workbench reports 1.107.
  const versionKey = environment.appVersion || environment.target?.workspaceKind === 'agent'
    ? 'appVersion'
    : 'traeVersion';
  const version = String(environment[versionKey] || '');
  const matched = DEFINITIONS.find(definition => definition.versionKey === versionKey
    && (definition.appVersion ? definition.appVersion === version : definition.versionPattern?.test(version))
    && definition.platforms.includes(platform));
  return cloneDefinition(matched || fallback, environment);
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
    appVersion: environment.appVersion || null,
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
  isKnownStandaloneAgentVersion,
  listTraeAdapters,
  mergeAdapterConfig,
  selectTraeAdapter
};
