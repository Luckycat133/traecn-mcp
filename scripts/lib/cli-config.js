'use strict';

// Single source of truth for CLI argument parsing and gateway connection
// config across the dev/CI scripts. Previously each script re-declared
// readArg and duplicated the host/port resolution, which drifted
// between scripts. Importing from here keeps connection settings consistent
// while preserving each script's original resolution priority.

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8788;

// Reads `--name value`, `--name=value`, or returns fallback.
// Superset of every script-local readArg variant: acceptance-audit and
// live-uat returned null; long-queue-proof, unattended-status-report and
// gateway-service used a fallback. With the default fallback (null) the
// behavior is identical to all of them.
function readArg(name, fallback = null) {
  const inlinePrefix = `${name}=`;
  const inline = process.argv.slice(2).find(arg => arg.startsWith(inlinePrefix));
  if (inline) return inline.slice(inlinePrefix.length);
  const index = process.argv.indexOf(name);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

// Resolve host/port honoring, in priority order:
//   CLI --host/--port  >  TRAECN_GATEWAY_HOST/PORT  >  legacy TRAECN_HOST/PORT  >  defaults
// `useCliArgs:false` reproduces scripts that never read --host/--port (they
// resolve host/port purely from env); `useLegacyEnv:false` reproduces
// acceptance-audit, which did not fall back to the legacy TRAECN_HOST/PORT vars.
function resolveGatewayHostPort(options = {}) {
  const { useCliArgs = true, useLegacyEnv = true } = options;
  const host = (useCliArgs ? readArg('--host') : null)
    || process.env.TRAECN_GATEWAY_HOST
    || (useLegacyEnv ? process.env.TRAECN_HOST : null)
    || DEFAULT_HOST;
  const portRaw = (useCliArgs ? readArg('--port') : null)
    || process.env.TRAECN_GATEWAY_PORT
    || (useLegacyEnv ? process.env.TRAECN_PORT : null)
    || String(DEFAULT_PORT);
  return { host, port: Number(portRaw) };
}

function resolveGatewayToken() {
  return process.env.TRAECN_GATEWAY_TOKEN || '';
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  readArg,
  resolveGatewayHostPort,
  resolveGatewayToken
};
