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

const ROUTES = [
  // Status / health
  { method: 'GET', path: '/api/status', handler: '_handleStatus', requiresAuth: false, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/api/capabilities', handler: '_handleCapabilities', requiresAuth: false, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/api/readiness', handler: '_handleReadiness', requiresAuth: false, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/', handler: '_handleRoot', requiresAuth: false, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/openapi.json', handler: '_handleOpenApiSpec', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/metrics', handler: '_handleMetrics', requiresAuth: false, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/metrics.json', handler: '_handleMetricsJson', requiresAuth: false, requiresRateLimit: true, requiresBody: false },

  // Tasks
  { method: 'GET', path: '/api/tasks/history', handler: '_handleTasksHistory', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'DELETE', path: '/api/tasks/history', handler: '_handleTasksHistoryClear', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/api/tasks/:taskId/replay', handler: '_handleTaskReplay', requiresAuth: true, requiresRateLimit: true, requiresBody: false, pathParams: ['taskId'] },
  { method: 'GET', path: '/api/tasks/:taskId', handler: '_handleGetTask', requiresAuth: true, requiresRateLimit: true, requiresBody: false, pathParams: ['taskId'] },
  { method: 'POST', path: '/api/tasks/submit', handler: '_handleUnifiedSubmit', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'GET', path: '/api/task/:taskId', handler: '_handleTaskStatus', requiresAuth: true, requiresRateLimit: true, requiresBody: false, pathParams: ['taskId'] },
  { method: 'POST', path: '/api/task/:taskId/review', handler: '_handleTaskReview', requiresAuth: true, requiresRateLimit: true, requiresBody: true, pathParams: ['taskId'] },
  { method: 'POST', path: '/api/task/:taskId/cancel', handler: '_handleTaskCancel', requiresAuth: true, requiresRateLimit: true, requiresBody: false, pathParams: ['taskId'] },
  { method: 'POST', path: '/api/tasks/delegate', handler: '_handleDelegateAsync', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/delegate', handler: '_handleDelegateAsync', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/delegate-async', handler: '_handleDelegateAsync', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/task/adopt-current', handler: '_handleAdoptCurrentTask', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/api/task-events', handler: '_handleListTaskEvents', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'POST', path: '/api/task-events/ack', handler: '_handleAckTaskEvent', requiresAuth: true, requiresRateLimit: true, requiresBody: true },

  // Compact Agent surface
  { method: 'GET', path: '/api/models', handler: '_handleListModels', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/api/conversations', handler: '_handleListConversations', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'POST', path: '/api/conversations/manage', handler: '_handleManageConversation', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/interactions/resolve', handler: '_handleResolveInteraction', requiresAuth: true, requiresRateLimit: true, requiresBody: true },

  // Batch tasks
  { method: 'POST', path: '/api/tasks/batch', handler: '_handleBatchSubmit', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'GET', path: '/api/tasks/batch/:batchId', handler: '_handleBatchStatus', requiresAuth: true, requiresRateLimit: true, requiresBody: false, pathParams: ['batchId'] },
  { method: 'DELETE', path: '/api/tasks/batch/:batchId', handler: '_handleBatchCancel', requiresAuth: true, requiresRateLimit: true, requiresBody: false, pathParams: ['batchId'] },

  // Sessions
  { method: 'POST', path: '/api/sessions', handler: '_handleCreateSession', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'GET', path: '/api/sessions', handler: '_handleListSessions', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/api/sessions/:sessionId', handler: '_handleGetSession', requiresAuth: true, requiresRateLimit: true, requiresBody: false, pathParams: ['sessionId'] },
  { method: 'POST', path: '/api/sessions/:sessionId/delegate', handler: '_handleDelegate', requiresAuth: true, requiresRateLimit: true, requiresBody: true, pathParams: ['sessionId'] },

  // Solo chat
  { method: 'POST', path: '/api/new-chat', handler: '_handleNewChat', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'GET', path: '/api/solo/chats', handler: '_handleListSoloChats', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'POST', path: '/api/solo/chats/switch', handler: '_handleSwitchSoloChat', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/solo/chats/submit', handler: '_handleSubmitSoloChatTask', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/solo/chats/delete', handler: '_handleDeleteSoloChats', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/solo/chats/cleanup-foreign-queue', handler: '_handleCleanupForeignQueue', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/solo/chats/cleanup_foreign_solo_queue', handler: '_handleCleanupForeignQueue', requiresAuth: true, requiresRateLimit: true, requiresBody: true },

  // Trae control
  { method: 'POST', path: '/api/trae/stop-generation', handler: '_handleStopGeneration', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/trae/restart-debug', handler: '_handleRestartTraeDebug', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/api/trae/review-gate', handler: '_handleReviewGateStatus', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'POST', path: '/api/trae/review-gate', handler: '_handleReviewGateResolve', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'GET', path: '/api/detect-mode', handler: '_handleDetectMode', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'POST', path: '/api/switch-mode', handler: '_handleSwitchMode', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/switch-model', handler: '_handleSwitchModel', requiresAuth: true, requiresRateLimit: true, requiresBody: true },

  // Queue
  { method: 'GET', path: '/api/queue-status', handler: '_handleQueueStatus', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/api/queue/status', handler: '_handleQueueStatusList', requiresAuth: true, requiresRateLimit: true, requiresBody: false },

  // Project / self
  { method: 'POST', path: '/api/open-project', handler: '_handleOpenProject', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/update-self', handler: '_handleUpdateSelf', requiresAuth: true, requiresRateLimit: true, requiresBody: true },

  // Settings
  { method: 'GET', path: '/api/settings/sections', handler: '_handleSettingsListSections', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/api/settings/options', handler: '_handleSettingsListOptions', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/api/settings/read-all', handler: '_handleSettingsReadAll', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/api/settings/read', handler: '_handleSettingsRead', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/api/settings', handler: '_handleSettingsRead', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'POST', path: '/api/settings/set', handler: '_handleSettingsSet', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/settings', handler: '_handleSettingsSet', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/settings/switch-tab', handler: '_handleSettingsSwitchTab', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/settings/back-to-chat', handler: '_handleSettingsBackToChat', requiresAuth: true, requiresRateLimit: true, requiresBody: true },

  // Dialog
  { method: 'POST', path: '/api/dialog/approve', handler: '_handleDialogApprove', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/dialog/dismiss', handler: '_handleDialogDismiss', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/api/dialog/status', handler: '_handleDialogStatus', requiresAuth: true, requiresRateLimit: true, requiresBody: false },

  // Confirm / preflight
  { method: 'POST', path: '/api/confirm/plan', handler: '_handleConfirmPlan', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/preflight', handler: '_handlePreflight', requiresAuth: true, requiresRateLimit: true, requiresBody: true },

  // Config
  { method: 'GET', path: '/api/config', handler: '_handleGetConfig', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/api/config/schema', handler: '_handleGetConfigSchema', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'POST', path: '/api/config/update', handler: '_handleUpdateConfig', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/config/reset', handler: '_handleResetConfig', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/api/config/diff', handler: '_handleConfigDiff', requiresAuth: true, requiresRateLimit: true, requiresBody: false },

  // Driver dispatch (POST to /api/<driverName>)
  { method: 'POST', path: '/api/editor', handler: '_handleDriverAction:editor', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/file', handler: '_handleDriverAction:file', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/terminal', handler: '_handleDriverAction:terminal', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/git', handler: '_handleDriverAction:git', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/search', handler: '_handleDriverAction:search', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/diagnostics', handler: '_handleDriverAction:diagnostics', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/snapshot', handler: '_handleDriverAction:snapshot', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/extension', handler: '_handleDriverAction:extension', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/command', handler: '_handleDriverAction:command', requiresAuth: true, requiresRateLimit: true, requiresBody: true },

  // Debug (only when TRAECN_ENABLE_DEBUG_ENDPOINTS=1)
  { method: 'GET', path: '/debug/automation', handler: '_handleDebugAutomation', requiresAuth: true, requiresRateLimit: true, requiresBody: false, debugOnly: true },
];

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
