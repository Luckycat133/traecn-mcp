'use strict';

const packageInfo = require('../../package.json');

const MODERN_PROTOCOL_VERSION = '2026-07-28';
const LEGACY_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2024-11-05']);
const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  MODERN_PROTOCOL_VERSION,
  ...LEGACY_PROTOCOL_VERSIONS
]);
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';
const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';
const SERVER_INFO = Object.freeze({ name: 'traecnclaw', version: packageInfo.version });

class McpProtocolError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'McpProtocolError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

function requestMeta(message = {}) {
  return message.params && message.params._meta && typeof message.params._meta === 'object'
    && !Array.isArray(message.params._meta)
    ? message.params._meta
    : null;
}

function modernProtocolVersion(message = {}) {
  const meta = requestMeta(message);
  return meta && Object.prototype.hasOwnProperty.call(meta, PROTOCOL_VERSION_META_KEY)
    ? meta[PROTOCOL_VERSION_META_KEY]
    : null;
}

function isModernRequest(message = {}) {
  return modernProtocolVersion(message) !== null;
}

function assertModernRequest(message = {}) {
  const meta = requestMeta(message);
  const requested = modernProtocolVersion(message);
  if (requested !== MODERN_PROTOCOL_VERSION) {
    throw new McpProtocolError(-32022, 'Unsupported protocol version', {
      supported: [...SUPPORTED_PROTOCOL_VERSIONS],
      requested: requested || null
    });
  }
  if (!meta[CLIENT_CAPABILITIES_META_KEY]
      || typeof meta[CLIENT_CAPABILITIES_META_KEY] !== 'object'
      || Array.isArray(meta[CLIENT_CAPABILITIES_META_KEY])) {
    throw new McpProtocolError(-32602, 'Missing required client capabilities metadata');
  }
  return meta;
}

function negotiateLegacyProtocolVersion(requested) {
  return LEGACY_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : LEGACY_PROTOCOL_VERSIONS[0];
}

function serverMeta(extra = {}) {
  return {
    ...extra,
    [SERVER_INFO_META_KEY]: SERVER_INFO
  };
}

function modernResult(result = {}, options = {}) {
  const output = {
    resultType: 'complete',
    ...result,
    _meta: serverMeta(result._meta)
  };
  if (options.cacheable === true) {
    output.ttlMs = options.ttlMs || 300000;
    output.cacheScope = options.cacheScope || 'private';
  }
  return output;
}

module.exports = {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  LEGACY_PROTOCOL_VERSIONS,
  MODERN_PROTOCOL_VERSION,
  McpProtocolError,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO,
  SERVER_INFO_META_KEY,
  SUPPORTED_PROTOCOL_VERSIONS,
  assertModernRequest,
  isModernRequest,
  modernProtocolVersion,
  modernResult,
  negotiateLegacyProtocolVersion,
  requestMeta,
  serverMeta
};
