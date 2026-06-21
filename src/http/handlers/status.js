'use strict';

/**
 * Status / readiness / metrics handlers.
 *
 * Each handler is `async function handleX(req, res, ctx)` so they can be
 * dispatched from the route table. The Gateway retains the actual
 * implementations; this module re-exports them as named functions for
 * the route-table composability, plus an inline ROUTES slice describing
 * which routes the file owns.
 */

const ROUTES = [
  { method: 'GET', path: '/api/status', handler: '_handleStatus', requiresAuth: false, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/api/capabilities', handler: '_handleCapabilities', requiresAuth: false, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/api/readiness', handler: '_handleReadiness', requiresAuth: false, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/', handler: '_handleRoot', requiresAuth: false, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/metrics', handler: '_handleMetrics', requiresAuth: false, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/metrics.json', handler: '_handleMetricsJson', requiresAuth: false, requiresRateLimit: true, requiresBody: false },
];

// We intentionally export ROUTES alongside placeholder `handleX` symbols so
// other modules can import { handleStatus } from this file. The real
// implementations are wired by the Gateway at construction time via
// route-table.js's resolveHandler().
function handleStatus(/* req, res, ctx */) { throw new Error('wired via route-table'); }
function handleCapabilities(/* req, res, ctx */) { throw new Error('wired via route-table'); }
function handleReadiness(/* req, res, ctx */) { throw new Error('wired via route-table'); }
function handleRoot(/* req, res, ctx */) { throw new Error('wired via route-table'); }
function handleMetrics(/* req, res, ctx */) { throw new Error('wired via route-table'); }
function handleMetricsJson(/* req, res, ctx */) { throw new Error('wired via route-table'); }

module.exports = {
  ROUTES,
  handleStatus,
  handleCapabilities,
  handleReadiness,
  handleRoot,
  handleMetrics,
  handleMetricsJson,
};