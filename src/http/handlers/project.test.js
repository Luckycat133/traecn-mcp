'use strict';

const assert = require('assert');
const { createRunner } = require('../../shared/test-runner');
const { makeReqRes } = require('../../shared/test-helpers');
const { Gateway } = require('../gateway');
const { generateOpenAPISpec } = require('../openapi');
const { ROUTES, handleWorkspaceContext } = require('./project');

const runner = createRunner('handlers/project.test.js');
const { test, asyncTest, pendingAsyncTests, summary } = runner;

console.log('\n[handlers/project.test.js] Running project handler tests...\n');

function makeContext(overrides = {}) {
  return {
    mockBridge: false,
    _selectedWorkspacePath: null,
    _ensureConnection: async () => {},
    _json(_req, res, data, statusCode = 200) {
      res.statusCode = statusCode;
      res._body = JSON.stringify(data);
      return data;
    },
    ...overrides,
  };
}

test('project routes expose authenticated read-only workspace context', () => {
  const route = ROUTES.find((item) => item.path === '/api/workspace');
  assert.ok(route);
  assert.strictEqual(route.method, 'GET');
  assert.strictEqual(route.handler, '_handleWorkspaceContext');
  assert.strictEqual(route.requiresAuth, true);
  assert.strictEqual(route.requiresRateLimit, true);
  assert.strictEqual(route.requiresBody, false);
});

asyncTest('mock workspace context is deterministic and bypasses the DOM driver', async () => {
  const { req, res } = makeReqRes({}, '/api/workspace', 'GET');
  const ctx = makeContext({
    mockBridge: true,
    driver: {
      getWorkspaceContext: async () => {
        throw new Error('mock workspace must not call the DOM driver');
      },
    },
  });

  await handleWorkspaceContext(req, res, ctx);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(res._body), {
    folderName: 'TRAECNclaw',
    rootPath: '/mock/TRAECNclaw',
    selectedPath: '/mock/TRAECNclaw',
    title: 'TRAECNclaw — Mock workspace',
    hasExplorer: true,
    verified: true,
  });
});

asyncTest('live workspace is verified only through exact canonical path evidence', async () => {
  const { req, res } = makeReqRes({}, '/api/workspace', 'GET');
  let assertionPath = null;
  const ctx = makeContext({
    _selectedWorkspacePath: '/workspace/TRAECNclaw',
    driver: {
      getWorkspaceContext: async () => ({
        folderName: 'TRAECNclaw',
        rootPath: '/workspace/TRAECNclaw',
        title: '设置 — TRAECNclaw',
        hasExplorer: true,
        profilePath: '/private/profile/should-not-leak',
        rawDom: '<main>private</main>',
      }),
    },
    _assertProjectWorkspace: async (requestedPath) => {
      assertionPath = requestedPath;
      return {
        requestedPath: '/workspace/TRAECNclaw',
        currentPath: '/workspace/TRAECNclaw',
      };
    },
  });

  await handleWorkspaceContext(req, res, ctx);
  const body = JSON.parse(res._body);
  assert.strictEqual(assertionPath, '/workspace/TRAECNclaw');
  assert.strictEqual(body.verified, true);
  assert.strictEqual(body.rootPath, '/workspace/TRAECNclaw');
  assert.strictEqual(body.selectedPath, '/workspace/TRAECNclaw');
  assert.strictEqual(body.profilePath, undefined);
  assert.strictEqual(body.rawDom, undefined);
});

asyncTest('folder or title inference alone never becomes exact verification', async () => {
  const { req, res } = makeReqRes({}, '/api/workspace', 'GET');
  let assertions = 0;
  const ctx = makeContext({
    _selectedWorkspacePath: '/workspace/TRAECNclaw',
    driver: {
      getWorkspaceContext: async () => ({
        folderName: 'TRAECNclaw',
        rootPath: null,
        title: 'TRAECNclaw',
        hasExplorer: false,
      }),
    },
    _assertProjectWorkspace: async () => {
      assertions++;
      return { requestedPath: '/workspace/TRAECNclaw', currentPath: null };
    },
  });

  await handleWorkspaceContext(req, res, ctx);
  const body = JSON.parse(res._body);
  assert.strictEqual(body.verified, false);
  assert.strictEqual(body.rootPath, null);
  assert.strictEqual(assertions, 0);
});

asyncTest('workspace errors are sanitized and do not leak profile or selector data', async () => {
  const { req, res } = makeReqRes({}, '/api/workspace', 'GET');
  const ctx = makeContext({
    _selectedWorkspacePath: '/workspace/TRAECNclaw',
    driver: {
      getWorkspaceContext: async () => {
        throw new Error(
          'Failed under /Users/private/Library/Application Support profile selector .secret'
        );
      },
    },
  });

  await handleWorkspaceContext(req, res, ctx);
  const body = JSON.parse(res._body);
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(body.code, 'WORKSPACE_CONTEXT_UNAVAILABLE');
  assert.strictEqual(body.error, 'Workspace context is temporarily unavailable');
  assert.doesNotMatch(res._body, /Users|Application Support|selector|\.secret/);
});

asyncTest('gateway enforces workspace authentication before invoking the driver', async () => {
  const gateway = new Gateway();
  gateway.token = 'workspace-private-token';
  gateway.driver = {
    getWorkspaceContext: async () => {
      throw new Error('driver must not run before authentication');
    },
  };
  const { req, res } = makeReqRes({}, '/api/workspace', 'GET');

  await gateway.handleRequest(req, res);
  assert.strictEqual(res.statusCode, 401);
  assert.deepStrictEqual(JSON.parse(res._body), { error: 'Unauthorized' });
});

test('OpenAPI documents the workspace response and failure boundaries', () => {
  const operation = generateOpenAPISpec().paths['/api/workspace'].get;
  assert.strictEqual(operation.operationId, 'getWorkspaceContext');
  assert.deepStrictEqual(operation.security, [{ bearerAuth: [] }]);
  const schema = operation.responses['200'].content['application/json'].schema;
  assert.strictEqual(schema.properties.rootPath.nullable, true);
  assert.match(schema.properties.verified.description, /exact detected root path/i);
  assert.ok(operation.responses['401']);
  assert.ok(operation.responses['501']);
  assert.ok(operation.responses['503']);
});

(async () => {
  await pendingAsyncTests();
  summary();
  if (runner.failed > 0) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
