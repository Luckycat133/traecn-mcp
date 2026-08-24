'use strict';

/**
 * Route Table — single source of truth for URL → handler mapping.
 *
 * This module exposes the ROUTES array used by the Gateway's dispatch
 * layer. Each entry describes one endpoint:
 *
 *   - method:            HTTP verb ('GET' | 'POST' | 'DELETE' | ...)
 *   - path:              exact path or path pattern with `:param` segments
 *   - handler:           function name on Gateway (used to look up the
 *                        callable at dispatch time)
 *   - requiresAuth:      false for public endpoints (e.g. /api/status,
 *                        /metrics), true otherwise. Note: /openapi.json is
 *                        auth-gated to prevent API-surface reconnaissance.
 *   - requiresRateLimit: true for endpoints that count against the IP /
 *                        API-key rate-limit bucket. Some endpoints
 *                        (e.g. /metrics) are rate-limited per IP but
 *                        bypass auth — they're listed with both flags
 *                        off so callers can apply the policy independently.
 *   - requiresBody:      true if the handler expects a JSON body
 *   - pathParams:        array of param names extracted from the path
 *                        pattern (e.g. ['taskId'] for /api/tasks/:taskId)
 *
 * The dispatch path in Gateway.handleRequestImpl calls `matchRoute(method,
 * pathname)` first; on a miss it returns 404.
 */

const handlerModules = [
  require('./handlers/status'),
  require('./handlers/tasks'),
  require('./handlers/delegate'),
  require('./handlers/task-events'),
  require('./handlers/unified-agent'),
  require('./handlers/batch'),
  require('./handlers/sessions'),
  require('./handlers/solo-chat'),
  require('./handlers/trae-control'),
  require('./handlers/queue'),
  require('./handlers/project'),
  require('./handlers/task-actions'),
  require('./handlers/driver-dispatch')
];

// These routes still resolve to Gateway-owned lifecycle/configuration methods.
// Handler modules are the source of truth for every extracted endpoint above.
const gatewayRoutes = [
  { method: 'GET', path: '/', handler: '_handleRoot', requiresAuth: false, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/assets/web-console/styles.css', handler: '_handleWebConsoleAsset', requiresAuth: false, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/assets/web-console/state.js', handler: '_handleWebConsoleAsset', requiresAuth: false, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/assets/web-console/app.js', handler: '_handleWebConsoleAsset', requiresAuth: false, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/openapi.json', handler: '_handleOpenApiSpec', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/api/settings/sections', handler: '_handleSettingsListSections', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/api/settings/options', handler: '_handleSettingsListOptions', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/api/settings/read-all', handler: '_handleSettingsReadAll', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/api/settings/read', handler: '_handleSettingsRead', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/api/settings', handler: '_handleSettingsRead', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'POST', path: '/api/settings/set', handler: '_handleSettingsSet', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/settings', handler: '_handleSettingsSet', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/settings/switch-tab', handler: '_handleSettingsSwitchTab', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/settings/back-to-chat', handler: '_handleSettingsBackToChat', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/dialog/approve', handler: '_handleDialogApprove', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/dialog/dismiss', handler: '_handleDialogDismiss', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/api/dialog/status', handler: '_handleDialogStatus', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'POST', path: '/api/confirm/plan', handler: '_handleConfirmPlan', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/preflight', handler: '_handlePreflight', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'GET', path: '/api/config', handler: '_handleGetConfig', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/api/config/schema', handler: '_handleGetConfigSchema', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'POST', path: '/api/config/update', handler: '_handleUpdateConfig', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/config/reset', handler: '_handleResetConfig', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/api/config/diff', handler: '_handleConfigDiff', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/debug/automation', handler: '_handleDebugAutomation', requiresAuth: true, requiresRateLimit: true, requiresBody: false, debugOnly: true }
];

const ROUTES = handlerModules.flatMap(module => module.ROUTES || []).concat(gatewayRoutes);

/**
 * Compile a path pattern into a regex. `:name` segments match any
 * non-slash sequence and are captured under `name`. Trailing slashes are
 * tolerated but the match still requires the captured chars to be present.
 */
function compilePath(pattern) {
  const segments = pattern.split('/').filter(Boolean);
  const paramNames = [];
  const parts = segments.map(seg => {
    if (seg.startsWith(':')) {
      paramNames.push(seg.slice(1));
      return '([^/]+)';
    }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  const re = new RegExp('^/' + parts.join('/') + '/?$');
  return { re, paramNames };
}

// Pre-compile the routes once.
const COMPILED_ROUTES = ROUTES.map(route => ({
  ...route,
  ...compilePath(route.path),
}));

/**
 * Find a matching route for the given (method, pathname).
 *
 * Returns `{ route, params }` on hit, or `null` on miss.
 *
 * Exact path matches short-circuit path-param matches to avoid surprising
 * behaviour when both `/api/tasks/history` and `/api/tasks/:taskId` are
 * registered.
 */
function matchRoute(method, pathname) {
  if (!method || !pathname) return null;
  let exactPathname;
  try {
    exactPathname = decodeURI(pathname);
  } catch {
    exactPathname = pathname;
  }

  // First pass: exact path + exact method match.
  for (const route of COMPILED_ROUTES) {
    if (route.method !== method) continue;
    if (route.path === exactPathname) {
      return { route, params: {} };
    }
  }

  // Second pass: pattern + exact method match.
  for (const route of COMPILED_ROUTES) {
    if (route.method !== method) continue;
    const m = pathname.match(route.re);
    if (!m) continue;
    const params = {};
    try {
      route.paramNames.forEach((name, idx) => {
        params[name] = decodeURIComponent(m[idx + 1]);
      });
    } catch {
      return null;
    }
    return { route, params };
  }

  return null;
}

/**
 * Resolve the callable handler on the given gateway instance. The
 * handler string follows the convention `_handleFoo` for top-level
 * handlers and `_handleDriverAction:editor` for driver-dispatch routes.
 */
function resolveHandler(gateway, handlerName) {
  if (!handlerName) return null;
  if (handlerName.startsWith('_handleDriverAction:')) {
    const driverName = handlerName.slice('_handleDriverAction:'.length);
    const fn = gateway._handleDriverAction;
    if (typeof fn !== 'function') return null;
    return (req, res) => fn.call(gateway, req, res, driverName);
  }
  return typeof gateway[handlerName] === 'function' ? gateway[handlerName].bind(gateway) : null;
}

module.exports = {
  ROUTES,
  COMPILED_ROUTES,
  matchRoute,
  resolveHandler,
  compilePath,
};
