'use strict';

/**
 * Driver dispatch handler — handles POST /api/<driverName> for the 9
 * driver routes (editor, file, terminal, git, search, diagnostics,
 * snapshot, extension, command).
 *
 * The route-table.js resolves `_handleDriverAction:<driverName>` to
 * `gateway._handleDriverAction(req, res, driverName)` so this single
 * handler covers all 9 driver endpoints.
 *
 * Moved verbatim from gateway.js. Behavior preserved 1:1.
 */

const ROUTES = [
  { method: 'POST', path: '/api/editor', handler: '_handleDriverAction:editor', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/file', handler: '_handleDriverAction:file', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/terminal', handler: '_handleDriverAction:terminal', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/git', handler: '_handleDriverAction:git', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/search', handler: '_handleDriverAction:search', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/diagnostics', handler: '_handleDriverAction:diagnostics', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/snapshot', handler: '_handleDriverAction:snapshot', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/extension', handler: '_handleDriverAction:extension', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/command', handler: '_handleDriverAction:command', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
];

async function handleDriverAction(req, res, ctx, driverName) {
  await ctx._ensureConnection();
  if (!ctx.driver) {
    return ctx._json(req, res, {
      error: 'CDP driver not initialized; TraeCN may not be reachable',
      code: 'DRIVER_NOT_READY'
    }, 503);
  }
  if (ctx.mockBridge) {
    return ctx._json(req, res, {
      error: 'Driver commands require a live TraeCN connection; mock bridge is active (TRAECN_ENABLE_MOCK_BRIDGE=1)',
      code: 'MOCK_BRIDGE_ACTIVE'
    }, 503);
  }
  let body;
  try {
    body = await new Promise((resolve, reject) => {
      let buf = '';
      let size = 0;
      const max = 1024 * 1024;
      req.on('data', chunk => {
        size += chunk.length;
        if (size > max) { reject(new Error('body too large')); req.destroy(); return; }
        buf += chunk;
      });
      req.on('end', () => {
        if (!buf) return resolve({});
        try { resolve(JSON.parse(buf)); }
        catch { reject(new Error('Invalid JSON body')); }
      });
      req.on('error', reject);
    });
  } catch (err) {
    return ctx._json(req, res, { error: err.message || 'Invalid JSON body' }, 400);
  }
  if (!body || typeof body !== 'object') {
    return ctx._json(req, res, { error: 'JSON object body required' }, 400);
  }
  const router = ctx._getDriverRouter();
  try {
    const result = await router.invoke(driverName, body);
    return ctx._json(req, res, { ok: true, driver: driverName, action: body.action, result });
  } catch (err) {
    const code = err.code || 'DRIVER_ERROR';
    return ctx._json(req, res, {
      ok: false,
      driver: driverName,
      action: body.action,
      error: err.message,
      code
    }, code === 'UNKNOWN_DRIVER' || code === 'UNKNOWN_ACTION' || code === 'MISSING_ACTION' ? 400 : 500);
  }
}

module.exports = {
  ROUTES,
  handleDriverAction,
};