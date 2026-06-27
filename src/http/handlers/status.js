'use strict';

/**
 * Status / readiness / metrics handlers.
 *
 * Each handler is `function handleX(req, res, ctx)` — they take the gateway
 * instance as `ctx` so they can call into the same fields they used as
 * `this.<x>` previously. Behavior is preserved 1:1 with the inline Gateway
 * methods, just relocated.
 *
 * The Gateway retains thin delegating shims (`_handleStatus`,
 * `_handleReadiness`, etc.) that close over the handler factory result,
 * so existing gateway.test.js cases that call `gateway._handleStatus(...)`
 * continue to work unchanged.
 *
 * Metrics is intentionally sync — Prometheus scrapers don't need async,
 * and the existing inline version was sync.
 */

const { globalMetrics } = require('../../shared/metrics');

const ROUTES = [
  { method: 'GET', path: '/api/status', handler: '_handleStatus', requiresAuth: false, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/api/capabilities', handler: '_handleCapabilities', requiresAuth: false, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/api/readiness', handler: '_handleReadiness', requiresAuth: false, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/metrics', handler: '_handleMetrics', requiresAuth: false, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/metrics.json', handler: '_handleMetricsJson', requiresAuth: false, requiresRateLimit: true, requiresBody: false },
];

function handleStatus(req, res, ctx) {
  return ctx._statusSnapshot().then(snapshot => ctx._json(req, res, snapshot));
}

function handleReadiness(req, res, ctx) {
  return ctx._ensureConnection()
    .then(() => ctx.driver.checkReadiness())
    .then(readiness => ctx._json(req, res, readiness));
}

function handleMetrics(req, res, ctx) {
  // Refresh volatile gauges so scrapers see fresh values.
  try { ctx._refreshMetricsGauges(); } catch { /* never fail the scrape */ }
  const body = globalMetrics.toPrometheus();
  res.writeHead(200, {
    'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function handleMetricsJson(req, res, ctx) {
  try { ctx._refreshMetricsGauges(); } catch { /* never fail the scrape */ }
  ctx._json(req, res, globalMetrics.getMetrics());
}

module.exports = {
  ROUTES,
  handleStatus,
  handleReadiness,
  handleMetrics,
  handleMetricsJson,
};