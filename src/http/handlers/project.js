'use strict';

const packageInfo = require('../../../package.json');
const { parseBody } = require('../request-gate');
const { rejectBadRequest } = require('./helpers');

/**
 * project handlers.
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
      "method": "POST",
      "path": "/api/open-project",
      "handler": "_handleOpenProject",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": true
    },
    {
      "method": "POST",
      "path": "/api/update-self",
      "handler": "_handleUpdateSelf",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": true
    }
  ];

async function handleOpenProject(req, res, ctx) {
  const body = await parseBody(req);
  if (!body.projectPath) {
    return rejectBadRequest(req, res, ctx, 'projectPath is required');
  }

  const projectPath = body.projectPath;
  const newInstance = body.newInstance === true;
  let result;

  try {
    // Use the existing quickstart machinery so we honor TRAECN_BIN / platform-specific
    // binary resolution (.app bundles on macOS, .exe on Windows) instead of relying on
    // a `trae-cn` shim that does not exist on this machine.
    const {
      findTraeCNBinary,
      isTraeCNRunning,
      startTraeCN
    } = require('../../config/quickstart');

    const cdpHost = process.env.TRAECN_CDP_HOST || process.env.TRAE_CDP_HOST || '127.0.0.1';
    const cdpPort = process.env.TRAECN_REMOTE_DEBUGGING_PORT || process.env.TRAE_REMOTE_DEBUGGING_PORT || '9222';

    const alreadyRunning = isTraeCNRunning();

    if (alreadyRunning && !newInstance) {
      // TraeCN is already running. Restarting it would lose the user's session,
      // unsaved buffers, and AI chat context. We refuse to spawn a duplicate and
      // report the current surface so the caller can decide what to do (e.g.
      // ask the user to switch projects manually, or call --newInstance=true
      // to opt into spawning a separate window).
      let currentSurface = null;
      try {
        const { fetchCDPTargets } = require('../../cdp/discovery');
        const targets = await fetchCDPTargets(cdpHost, cdpPort);
        const page = targets.find(t => t.type === 'page');
        if (page) {
          currentSurface = {
            targetId: page.id,
            title: page.title,
            url: page.url
          };
        }
      } catch {
        // CDP probe failed — TraeCN may be running but unreachable. Fall through
        // to the not-running path so the caller can still try to start a fresh
        // instance.
      }

      result = {
        success: false,
        alreadyRunning: true,
        projectPath,
        currentSurface,
        cdp: { host: cdpHost, port: cdpPort },
        hint: 'TraeCN is already running. Pass newInstance=true to spawn a separate window, or stop TraeCN first.',
        error: currentSurface
          ? `TraeCN is already running on workspace "${currentSurface.title || '(untitled)'}".`
          : 'TraeCN is already running but CDP did not return any page target.'
      };
      ctx._json(req, res, result, 409);
      return;
    }

    // TraeCN is not running (or caller asked for a separate window). Start it
    // with the project via the canonical quickstart helper so we get the right
    // binary path, --remote-debugging-port, and platform-correct spawn args.
    const binPath = findTraeCNBinary();
    if (!binPath) {
      result = {
        success: false,
        projectPath,
        error: 'TraeCN binary not found. Set TRAECN_BIN environment variable.'
      };
      ctx._json(req, res, result, 404);
      return;
    }

    const startResult = await startTraeCN({ binPath, projectPath, newInstance });
    result = {
      success: true,
      projectPath,
      binPath,
      pid: startResult.pid,
      command: startResult.command,
      args: startResult.args,
      cdp: { host: cdpHost, port: cdpPort },
      started: true,
      cdpReady: startResult.cdpReady
    };

    // Poll for CDP target readiness (replaces hardcoded sleep)
    const { fetchCDPTargets } = require('../../cdp/discovery');
    const maxWaitMs = 15000;
    const pollIntervalMs = 1000;
    const startTime = Date.now();

    let pageTarget = null;
    while (Date.now() - startTime < maxWaitMs) {
      try {
        const targets = await fetchCDPTargets(cdpHost, cdpPort);
        pageTarget = targets.find(t => t.type === 'page');
        if (pageTarget && pageTarget.webSocketDebuggerUrl) break;
      } catch {
        // CDP not ready yet — retry
      }
      await new Promise(r => ctx._setTimeout(r, pollIntervalMs));
    }

    // Try to check for restricted mode dialog via CDP
    try {
      const { CDPClient } = require('../../cdp/client');

      if (pageTarget && pageTarget.webSocketDebuggerUrl) {
        const cdpClient = new CDPClient(pageTarget.webSocketDebuggerUrl);
        await cdpClient.connect();
        await cdpClient.send('DOM.enable');
        await cdpClient.send('Runtime.enable');
        const { DomDriver } = require('../../cdp/dom-driver');
        const tempDriver = new DomDriver(cdpClient);
        const restrictedCheck = await tempDriver.checkRestrictedMode();
        await cdpClient.close();

        if (restrictedCheck && restrictedCheck.restricted) {
          result.restrictedMode = true;
          result.restrictedInfo = restrictedCheck;
          result.message = '受限模式已启用，请在Trae CN窗口手动点击「信任」以继续';
        }
      }
    } catch (cdpErr) {
      // CDP not available yet (gateway just started, browser not ready) — non-fatal
      result._cdpCheckNote = 'CDP check skipped: ' + cdpErr.message;
    }
  } catch (err) {
    result = { success: false, projectPath, error: err.message };
  }

  ctx._json(req, res, result);
}
async function handleUpdateSelf(req, res, ctx) {
  const body = await parseBody(req);
  ctx._json(req, res, {
    success: false,
    version: packageInfo.version,
    force: body.force === true,
    message: 'Automatic self-update is not enabled. Pull the latest repository revision and run npm install.',
    currentVersion: packageInfo.version
  }, 200);
}

module.exports = { ROUTES, handleOpenProject, handleUpdateSelf };
