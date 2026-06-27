'use strict';

const { parseBody } = require('../request-gate');

/**
 * settings handlers.
 *
 * Moved verbatim from src/http/gateway.js. Each handler is now an
 * exported function with signature `function handleX(req, res, ctx, ...pathParams)`
 * taking the gateway instance as `ctx`. Behavior is preserved 1:1.
 *
 * The Gateway retains thin delegating shims (e.g. `_handleCreateSession`) so
 * existing gateway.test.js cases that call `gateway._handleCreateSession(...)`
 * continue to work unchanged.
 */

const ROUTES = [
    {
      "method": "GET",
      "path": "/api/settings/read-all",
      "handler": "_handleSettingsReadAll",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": false
    },
    {
      "method": "GET",
      "path": "/api/settings/read",
      "handler": "_handleSettingsRead",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": false
    },
    {
      "method": "GET",
      "path": "/api/settings",
      "handler": "_handleSettingsRead",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": false
    },
    {
      "method": "POST",
      "path": "/api/settings/set",
      "handler": "_handleSettingsSet",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": true
    },
    {
      "method": "POST",
      "path": "/api/settings",
      "handler": "_handleSettingsSet",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": true
    },
    {
      "method": "POST",
      "path": "/api/settings/switch-tab",
      "handler": "_handleSettingsSwitchTab",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": true
    },
    {
      "method": "POST",
      "path": "/api/settings/back-to-chat",
      "handler": "_handleSettingsBackToChat",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": true
    }
  ];

async function handleSettingsReadAll(req, res, ctx) {
  await ctx._ensureConnection();
  const hardLimitMs = 35000;
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = ctx._setTimeout(
      () => reject(new Error('settings/read-all hard limit (' + hardLimitMs + 'ms)')),
      hardLimitMs
    );
  });
  try {
    const data = await Promise.race([
      ctx._withUiActionLock(() => ctx.driver.settings.readAll()),
      timeoutPromise
    ]);
    ctx._json(req, res, { sections: Object.keys(data || {}), data });
  } catch (e) {
    ctx._json(req, res, { error: e.message, sections: [], data: {} }, 504);
  } finally {
    if (timeoutId) ctx._clearTimeout(timeoutId);
  }
}
async function handleSettingsRead(req, res, ctx) {
  const parsedUrl = new URL(req._normalizedUrl || req.url, `http://${req.headers.host}`);
  const raw = parsedUrl.searchParams.get('section') || null;
  const SECTION_ALIASES = {
    general: '通用', account: '账号', accounts: '账号',
    agents: '智能体', mcp: 'MCP', flow: '对话流', dialog: '对话流',
    cue: 'CUE', model: '模型', models: '模型',
    context: '上下文', rules: '规则和技能', skills: '规则和技能',
    beta: 'Beta', about: '关于 TRAE'
  };
  const section = raw ? (SECTION_ALIASES[raw] || (() => {
    try { return decodeURIComponent(raw); } catch(e) { return raw; }
  })()) : null;

  await ctx._ensureConnection();

  const switchResult = await ctx.driver.settings.switchTab(section);

  let data;
  try {
    data = await ctx.driver.settings.getContent();
  } catch(e) {
    return ctx._json(req, res, { error: e.message }, 500);
  }

  ctx._json(req, res, { section: section || 'current', ...data });
}
async function handleSettingsSet(req, res, ctx) {
  const body = await parseBody(req);
  if (!body.label) {
    return ctx._json(req, res, { error: 'label is required' }, 400);
  }
  if (body.value === undefined || body.value === null) {
    return ctx._json(req, res, { error: 'value is required' }, 400);
  }
  const confirmationFailure = ctx._confirmationFailure(req, body, 'settings_set', {
    label: body.label,
    value: body.value,
    ...(body.section ? { section: body.section } : {})
  });
  if (confirmationFailure) return ctx._json(req, res, confirmationFailure, 409);

  await ctx._ensureConnection();

  // If section is specified, navigate there first
  if (body.section) {
    await ctx.driver.settings.switchTab(body.section);
  }

  const result = await ctx.driver.settings.set(body.label, body.value);
  ctx._json(req, res, { label: body.label, value: body.value, result });
}
async function handleSettingsSwitchTab(req, res, ctx) {
  const body = await parseBody(req);
  if (!body.section) {
    return ctx._json(req, res, { error: 'section is required' }, 400);
  }

  await ctx._ensureConnection();
  const result = await ctx.driver.settings.switchTab(body.section);
  ctx._json(req, res, result);
}
async function handleSettingsBackToChat(req, res, ctx) {
  await ctx._ensureConnection();
  const result = await ctx.driver.settings.backToChat();
  ctx._json(req, res, { result });
}

module.exports = { ROUTES, handleSettingsReadAll, handleSettingsRead, handleSettingsSet, handleSettingsSwitchTab, handleSettingsBackToChat };