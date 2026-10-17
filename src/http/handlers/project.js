'use strict';

const packageInfo = require('../../../package.json');
const { parseBody } = require('../request-gate');
const { rejectBadRequest } = require('./helpers');
const { readRuntimeEnv } = require('../../config/runtime-schema');

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
      "method": "GET",
      "path": "/api/workspace",
      "handler": "_handleWorkspaceContext",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": false
    },
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

function cleanString(value, maxLength) {
  const cleaned = Array.from(String(value || ''), character => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? ' ' : character;
  }).join('').trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

async function handleWorkspaceContext(req, res, ctx) {
  if (ctx.mockBridge) {
    const selectedPath = cleanString(ctx._selectedWorkspacePath, 4096) || '/mock/TRAECNclaw';
    return ctx._json(req, res, {
      folderName: 'TRAECNclaw',
      rootPath: selectedPath,
      selectedPath,
      title: 'TRAECNclaw — Mock workspace',
      hasExplorer: true,
      verified: true
    });
  }

  try {
    await ctx._ensureConnection();
    if (!ctx.driver || typeof ctx.driver.getWorkspaceContext !== 'function') {
      return ctx._json(req, res, {
        error: 'Workspace context is not supported by the active adapter',
        code: 'WORKSPACE_CONTEXT_UNSUPPORTED',
        folderName: null,
        rootPath: null,
        selectedPath: cleanString(ctx._selectedWorkspacePath, 4096),
        title: null,
        hasExplorer: false,
        verified: false
      }, 501);
    }

    const workspace = await ctx.driver.getWorkspaceContext();
    const rootPath = cleanString(workspace?.rootPath, 4096);
    const selectedPath = cleanString(ctx._selectedWorkspacePath, 4096);
    let verified = false;
    if (rootPath && selectedPath && typeof ctx._assertProjectWorkspace === 'function') {
      try {
        const assertion = await ctx._assertProjectWorkspace(selectedPath);
        verified = Boolean(assertion?.currentPath && assertion.currentPath === assertion.requestedPath);
      } catch {
        verified = false;
      }
    }

    return ctx._json(req, res, {
      folderName: cleanString(workspace?.folderName, 512),
      rootPath,
      selectedPath,
      title: cleanString(workspace?.title, 512),
      hasExplorer: workspace?.hasExplorer === true,
      verified
    });
  } catch {
    return ctx._json(req, res, {
      error: 'Workspace context is temporarily unavailable',
      code: 'WORKSPACE_CONTEXT_UNAVAILABLE',
      folderName: null,
      rootPath: null,
      selectedPath: cleanString(ctx._selectedWorkspacePath, 4096),
      title: null,
      hasExplorer: false,
      verified: false
    }, 503);
  }
}

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
      openProjectInExistingWindow,
      startTraeCN
    } = require('../../config/quickstart');

    const cdpHost = readRuntimeEnv('TRAECN_CDP_HOST');
    const cdpPort = readRuntimeEnv('TRAECN_REMOTE_DEBUGGING_PORT');

    const alreadyRunning = isTraeCNRunning();

    if (alreadyRunning && !newInstance) {
      try {
        await ctx._ensureConnection();
        const current = await ctx._assertProjectWorkspace(projectPath);
        if (current?.currentPath && current.currentPath === current.requestedPath) {
          ctx._selectedWorkspacePath = projectPath;
          ctx._json(req, res, {
            success: true,
            alreadyRunning: true,
            alreadyOpen: true,
            reusedWindow: false,
            projectPath,
            verifiedWorkspace: {
              folderName: current.currentFolder,
              rootPath: current.currentPath
            },
            cdp: { host: cdpHost, port: cdpPort }
          }, 200);
          return;
        }
      } catch {
        // A mismatch or temporarily unavailable CDP surface means the requested
        // workspace still needs to be opened. The post-switch verification below
        // remains authoritative.
      }

      const binPath = findTraeCNBinary();
      if (!binPath) {
        ctx._json(req, res, {
          success: false,
          projectPath,
          error: 'TraeCN binary not found. Set TRAECN_BIN environment variable.'
        }, 404);
        return;
      }

      const switchResult = await openProjectInExistingWindow({
        binPath,
        projectPath,
        timeoutMs: body.timeoutMs
      });
      const verifyTimeoutMs = Number.isFinite(body.verifyTimeoutMs) && body.verifyTimeoutMs > 0
        ? body.verifyTimeoutMs
        : 15000;
      const deadline = Date.now() + verifyTimeoutMs;
      let verifiedWorkspace = null;
      let lastVerificationError = null;

      while (Date.now() < deadline) {
        try {
          await ctx._ensureConnection();
          const verified = await ctx._assertProjectWorkspace(projectPath);
          if (!verified?.currentPath || verified.currentPath !== verified.requestedPath) {
            const error = new Error('TraeCN workspace root path is unavailable for exact verification');
            error.code = 'WORKSPACE_CONTEXT_UNAVAILABLE';
            throw error;
          }
          verifiedWorkspace = {
            folderName: verified.currentFolder,
            rootPath: verified.currentPath
          };
          break;
        } catch (error) {
          lastVerificationError = error;
          await new Promise(resolve => ctx._setTimeout(resolve, 250));
        }
      }

      if (!verifiedWorkspace) {
        const error = new Error(`Timed out verifying TraeCN workspace switch to ${projectPath}`);
        error.code = 'WORKSPACE_SWITCH_TIMEOUT';
        error.cause = lastVerificationError;
        throw error;
      }

      result = {
        success: true,
        alreadyRunning: true,
        reusedWindow: true,
        projectPath,
        binPath,
        command: switchResult.command,
        args: switchResult.args,
        verifiedWorkspace,
        cdp: { host: cdpHost, port: cdpPort }
      };
      ctx._selectedWorkspacePath = projectPath;
      ctx._json(req, res, result, 200);
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

  if (result && result.success === true) ctx._selectedWorkspacePath = projectPath;
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

module.exports = { ROUTES, handleWorkspaceContext, handleOpenProject, handleUpdateSelf };
