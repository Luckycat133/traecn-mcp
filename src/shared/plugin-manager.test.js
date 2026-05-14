'use strict';

const assert = require('assert');
const { PluginManager, createPluginManager, validatePlugin, sanitizeLog } = require('./plugin-manager');

let testsRun = 0;
let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
  testsRun++;
  try {
    fn();
    testsPassed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    testsFailed++;
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
  }
}

function describe(name, fn) {
  console.log(`\n${name}`);
  fn();
}

const mockLogger = {
  logs: [],
  log(...args) { this.logs.push(['log', args]); },
  warn(...args) { this.logs.push(['warn', args]); },
  error(...args) { this.logs.push(['error', args]); }
};

function createMockPlugin(overrides = {}) {
  return {
    name: 'test-plugin',
    version: '1.0.0',
    hooks: {},
    ...overrides
  };
}

function createGatewayMock() {
  return {
    host: '127.0.0.1',
    port: 8788,
    version: '1.0.0'
  };
}

describe('PluginManager', function() {
  describe('constructor', function() {
    test('should create a PluginManager with default options', function() {
      mockLogger.logs = [];
      const pm = new PluginManager();
      assert.ok(pm.plugins instanceof Map);
      assert.ok(Array.isArray(pm.hooks.beforeTask));
      assert.ok(Array.isArray(pm.hooks.afterTask));
      assert.ok(Array.isArray(pm.hooks.onError));
      assert.ok(Array.isArray(pm.hooks.onStartup));
      assert.ok(Array.isArray(pm.hooks.onShutdown));
      assert.ok(Array.isArray(pm.middlewares));
      assert.ok(Array.isArray(pm.routes));
    });

    test('should accept custom logger', function() {
      mockLogger.logs = [];
      const pm = new PluginManager({ logger: mockLogger });
      assert.strictEqual(pm.logger, mockLogger);
    });

    test('should parse enabled plugins from comma-separated string', function() {
      const pm = new PluginManager({ enabledPlugins: 'plugin1,plugin2,plugin3' });
      assert.deepStrictEqual(pm.enabledPlugins, ['plugin1', 'plugin2', 'plugin3']);
    });

    test('should return null for enabledPlugins when set to *', function() {
      const pm = new PluginManager({ enabledPlugins: '*' });
      assert.strictEqual(pm.enabledPlugins, null);
    });
  });

  describe('register', function() {
    test('should register a valid plugin', async function() {
      const pm = new PluginManager({ logger: mockLogger });
      const plugin = createMockPlugin();

      const result = await pm.register(plugin);
      assert.strictEqual(result, true);
      assert.strictEqual(pm.plugins.size, 1);
      assert.ok(pm.plugins.has('test-plugin'));
    });

    test('should throw when plugin name is missing', async function() {
      const pm = new PluginManager();
      const plugin = createMockPlugin({ name: undefined });

      try {
        await pm.register(plugin);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err.message.includes('must have a name'));
      }
    });

    test('should throw when plugin version is missing', async function() {
      const pm = new PluginManager();
      const plugin = createMockPlugin({ version: undefined });

      try {
        await pm.register(plugin);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err.message.includes('version'));
      }
    });

    test('should skip duplicate plugin registration', async function() {
      const pm = new PluginManager({ logger: mockLogger });
      const plugin = createMockPlugin();

      await pm.register(plugin);
      const result = await pm.register(plugin);

      assert.strictEqual(result, false);
      assert.strictEqual(pm.plugins.size, 1);
    });

    test('should skip disabled plugins based on enabledPlugins list', async function() {
      const pm = new PluginManager({
        logger: mockLogger,
        enabledPlugins: 'plugin1,plugin2'
      });
      const plugin = createMockPlugin({ name: 'plugin3' });

      const result = await pm.register(plugin);
      assert.strictEqual(result, false);
      assert.strictEqual(pm.plugins.size, 0);
    });

    test('should register plugin hooks correctly', async function() {
      const pm = new PluginManager({ logger: mockLogger });
      const beforeHook = async (ctx) => ctx;
      const afterHook = async (ctx, result) => result;
      const errorHook = async (ctx, err) => {};
      const startupHook = async (gateway) => {};
      const shutdownHook = async (gateway) => {};

      const plugin = createMockPlugin({
        hooks: {
          beforeTask: beforeHook,
          afterTask: afterHook,
          onError: errorHook,
          onStartup: startupHook,
          onShutdown: shutdownHook
        }
      });

      await pm.register(plugin);

      assert.strictEqual(pm.hooks.beforeTask.length, 1);
      assert.strictEqual(pm.hooks.afterTask.length, 1);
      assert.strictEqual(pm.hooks.onError.length, 1);
      assert.strictEqual(pm.hooks.onStartup.length, 1);
      assert.strictEqual(pm.hooks.onShutdown.length, 1);
    });

    test('should register middleware correctly', async function() {
      const pm = new PluginManager({ logger: mockLogger });
      const middleware = async (ctx, next) => next();
      const plugin = createMockPlugin({ middleware });

      await pm.register(plugin);

      assert.strictEqual(pm.middlewares.length, 1);
      assert.strictEqual(pm.middlewares[0].plugin, 'test-plugin');
    });

    test('should register routes correctly', async function() {
      const pm = new PluginManager({ logger: mockLogger });
      const handler = async () => {};
      const plugin = createMockPlugin({
        routes: [
          { method: 'GET', path: '/api/test', handler },
          { method: 'POST', path: '/api/data', handler }
        ]
      });

      await pm.register(plugin);

      assert.strictEqual(pm.routes.length, 2);
      assert.strictEqual(pm.routes[0].method, 'GET');
      assert.strictEqual(pm.routes[0].path, '/api/test');
      assert.strictEqual(pm.routes[1].method, 'POST');
    });

    test('should uppercase route methods', async function() {
      const pm = new PluginManager({ logger: mockLogger });
      const handler = async () => {};
      const plugin = createMockPlugin({
        routes: [{ method: 'get', path: '/api/test', handler }]
      });

      await pm.register(plugin);

      assert.strictEqual(pm.routes[0].method, 'GET');
    });
  });

  describe('unregister', function() {
    test('should unregister an existing plugin', async function() {
      const pm = new PluginManager({ logger: mockLogger });
      const plugin = createMockPlugin();

      await pm.register(plugin);
      const result = await pm.unregister('test-plugin');

      assert.strictEqual(result, true);
      assert.strictEqual(pm.plugins.size, 0);
    });

    test('should return false for non-existent plugin', async function() {
      const pm = new PluginManager();
      const result = await pm.unregister('non-existent');
      assert.strictEqual(result, false);
    });

    test('should remove hooks when unregistering', async function() {
      const pm = new PluginManager({ logger: mockLogger });
      const plugin = createMockPlugin({
        hooks: {
          beforeTask: async (ctx) => ctx,
          afterTask: async (ctx, result) => result
        }
      });

      await pm.register(plugin);
      assert.strictEqual(pm.hooks.beforeTask.length, 1);

      await pm.unregister('test-plugin');
      assert.strictEqual(pm.hooks.beforeTask.length, 0);
    });

    test('should remove middleware when unregistering', async function() {
      const pm = new PluginManager({ logger: mockLogger });
      const plugin = createMockPlugin({
        middleware: async (ctx, next) => next()
      });

      await pm.register(plugin);
      assert.strictEqual(pm.middlewares.length, 1);

      await pm.unregister('test-plugin');
      assert.strictEqual(pm.middlewares.length, 0);
    });

    test('should remove routes when unregistering', async function() {
      const pm = new PluginManager({ logger: mockLogger });
      const handler = async () => {};
      const plugin = createMockPlugin({
        routes: [{ method: 'GET', path: '/api/test', handler }]
      });

      await pm.register(plugin);
      assert.strictEqual(pm.routes.length, 1);

      await pm.unregister('test-plugin');
      assert.strictEqual(pm.routes.length, 0);
    });
  });

  describe('onStartup', function() {
    test('should execute all startup hooks', async function() {
      const pm = new PluginManager({ logger: mockLogger });
      let called = false;
      const plugin = createMockPlugin({
        hooks: {
          onStartup: async (gateway) => { called = true; }
        }
      });

      await pm.register(plugin);
      await pm.onStartup(createGatewayMock());

      assert.strictEqual(called, true);
    });

    test('should continue when one hook fails', async function() {
      const pm = new PluginManager({ logger: mockLogger });
      let called1 = false;
      let called2 = false;

      const plugin1 = createMockPlugin({
        name: 'plugin1',
        hooks: {
          onStartup: async () => { called1 = true; }
        }
      });

      const plugin2 = createMockPlugin({
        name: 'plugin2',
        hooks: {
          onStartup: async () => { throw new Error('Startup failed'); }
        }
      });

      const plugin3 = createMockPlugin({
        name: 'plugin3',
        hooks: {
          onStartup: async () => { called2 = true; }
        }
      });

      await pm.register(plugin1);
      await pm.register(plugin2);
      await pm.register(plugin3);
      await pm.onStartup(createGatewayMock());

      assert.strictEqual(called1, true);
      assert.strictEqual(called2, true);
    });
  });

  describe('onShutdown', function() {
    test('should execute all shutdown hooks', async function() {
      const pm = new PluginManager({ logger: mockLogger });
      let called = false;
      const plugin = createMockPlugin({
        hooks: {
          onShutdown: async (gateway) => { called = true; }
        }
      });

      await pm.register(plugin);
      await pm.onShutdown(createGatewayMock());

      assert.strictEqual(called, true);
    });
  });

  describe('beforeTask', function() {
    test('should pass context through beforeTask hooks', async function() {
      const pm = new PluginManager({ logger: mockLogger });
      const plugin = createMockPlugin({
        hooks: {
          beforeTask: async (ctx) => {
            ctx.modified = true;
            return ctx;
          }
        }
      });

      await pm.register(plugin);
      const ctx = { task: 'test' };
      const result = await pm.beforeTask(ctx);

      assert.strictEqual(result.modified, true);
    });

    test('should continue when one hook fails', async function() {
      const pm = new PluginManager({ logger: mockLogger });

      const plugin1 = createMockPlugin({
        name: 'plugin1',
        hooks: {
          beforeTask: async (ctx) => {
            ctx.fromPlugin1 = true;
            return ctx;
          }
        }
      });

      const plugin2 = createMockPlugin({
        name: 'plugin2',
        hooks: {
          beforeTask: async () => {
            throw new Error('Hook failed');
          }
        }
      });

      await pm.register(plugin1);
      await pm.register(plugin2);
      const ctx = { task: 'test' };
      const result = await pm.beforeTask(ctx);

      assert.strictEqual(result.fromPlugin1, true);
    });
  });

  describe('afterTask', function() {
    test('should pass result through afterTask hooks', async function() {
      const pm = new PluginManager({ logger: mockLogger });
      const plugin = createMockPlugin({
        hooks: {
          afterTask: async (ctx, result) => {
            result.modified = true;
            return result;
          }
        }
      });

      await pm.register(plugin);
      const ctx = { task: 'test' };
      const result = { text: 'hello' };
      const finalResult = await pm.afterTask(ctx, result);

      assert.strictEqual(finalResult.modified, true);
    });
  });

  describe('onError', function() {
    test('should call error handlers', async function() {
      const pm = new PluginManager({ logger: mockLogger });
      let called = false;
      const plugin = createMockPlugin({
        hooks: {
          onError: async (ctx, error) => {
            called = true;
          }
        }
      });

      await pm.register(plugin);
      await pm.onError({}, new Error('Test error'));

      assert.strictEqual(called, true);
    });

    test('should continue when one error handler fails', async function() {
      const pm = new PluginManager({ logger: mockLogger });
      let called = false;

      const plugin1 = createMockPlugin({
        name: 'plugin1',
        hooks: {
          onError: async () => { called = true; }
        }
      });

      const plugin2 = createMockPlugin({
        name: 'plugin2',
        hooks: {
          onError: async () => { throw new Error('Error handler failed'); }
        }
      });

      await pm.register(plugin1);
      await pm.register(plugin2);
      await pm.onError({}, new Error('Test error'));

      assert.strictEqual(called, true);
    });
  });

  describe('runMiddlewares', function() {
    test('should execute middlewares in order', async function() {
      const pm = new PluginManager({ logger: mockLogger });
      const order = [];

      const plugin1 = createMockPlugin({
        name: 'plugin1',
        middleware: async (ctx, next) => {
          order.push('plugin1-before');
          const result = await next();
          order.push('plugin1-after');
          return result;
        }
      });

      const plugin2 = createMockPlugin({
        name: 'plugin2',
        middleware: async (ctx, next) => {
          order.push('plugin2-before');
          const result = await next();
          order.push('plugin2-after');
          return result;
        }
      });

      await pm.register(plugin1);
      await pm.register(plugin2);

      const ctx = {};
      await pm.runMiddlewares(ctx, async () => {
        order.push('final');
        return { success: true };
      });

      assert.deepStrictEqual(order, [
        'plugin1-before',
        'plugin2-before',
        'final',
        'plugin2-after',
        'plugin1-after'
      ]);
    });

    test('should throw when no middlewares and handler throws', async function() {
      const pm = new PluginManager({ logger: mockLogger });
      const ctx = {};

      try {
        await pm.runMiddlewares(ctx, async () => {
          throw new Error('Handler error');
        });
        assert.fail('Should have thrown');
      } catch (err) {
        assert.strictEqual(err.message, 'Handler error');
      }
    });
  });

  describe('getPlugin', function() {
    test('should return registered plugin', async function() {
      const pm = new PluginManager({ logger: mockLogger });
      const plugin = createMockPlugin();

      await pm.register(plugin);
      const result = pm.getPlugin('test-plugin');

      assert.strictEqual(result.name, 'test-plugin');
    });

    test('should return null for non-existent plugin', function() {
      const pm = new PluginManager();
      const result = pm.getPlugin('non-existent');
      assert.strictEqual(result, null);
    });
  });

  describe('getPluginList', function() {
    test('should return list of registered plugins', async function() {
      const pm = new PluginManager({ logger: mockLogger });
      const plugin1 = createMockPlugin({ name: 'plugin1', version: '1.0.0' });
      const plugin2 = createMockPlugin({ name: 'plugin2', version: '2.0.0' });

      await pm.register(plugin1);
      await pm.register(plugin2);

      const list = pm.getPluginList();

      assert.strictEqual(list.length, 2);
      assert.ok(list.some(p => p.name === 'plugin1' && p.version === '1.0.0'));
      assert.ok(list.some(p => p.name === 'plugin2' && p.version === '2.0.0'));
    });
  });

  describe('getRoutes', function() {
    test('should return list of registered routes', async function() {
      const pm = new PluginManager({ logger: mockLogger });
      const handler = async () => {};
      const plugin = createMockPlugin({
        routes: [
          { method: 'GET', path: '/api/test', handler },
          { method: 'POST', path: '/api/data', handler }
        ]
      });

      await pm.register(plugin);

      const routes = pm.getRoutes();

      assert.strictEqual(routes.length, 2);
      assert.strictEqual(routes[0].plugin, 'test-plugin');
      assert.strictEqual(routes[0].method, 'GET');
      assert.strictEqual(routes[0].path, '/api/test');
    });
  });

  describe('reload', function() {
    test('should unload all plugins and reload from directory', async function() {
      const pm = new PluginManager({ logger: mockLogger });
      const plugin = createMockPlugin();

      await pm.register(plugin);
      assert.strictEqual(pm.plugins.size, 1);

      const results = await pm.reload();

      assert.strictEqual(pm.plugins.size, 0);
      assert.ok(Array.isArray(results.plugins));
    });
  });
});

describe('validatePlugin', function() {
  test('should return empty array for valid plugin', function() {
    const plugin = {
      name: 'test',
      version: '1.0.0'
    };

    const errors = validatePlugin(plugin, 'test');
    assert.deepStrictEqual(errors, []);
  });

  test('should return error for missing name', function() {
    const errors = validatePlugin({}, 'test');
    assert.ok(errors.length > 0);
    assert.ok(errors.some(e => e.includes('name')));
  });

  test('should return error for missing version', function() {
    const plugin = { name: 'test' };
    const errors = validatePlugin(plugin, 'test');
    assert.ok(errors.length > 0);
    assert.ok(errors.some(e => e.includes('version')));
  });

  test('should return error for invalid hook type', function() {
    const plugin = {
      name: 'test',
      version: '1.0.0',
      hooks: { beforeTask: 'not a function' }
    };

    const errors = validatePlugin(plugin, 'test');
    assert.ok(errors.some(e => e.includes('beforeTask') && e.includes('function')));
  });

  test('should return error for non-function middleware', function() {
    const plugin = {
      name: 'test',
      version: '1.0.0',
      middleware: 'not a function'
    };

    const errors = validatePlugin(plugin, 'test');
    assert.ok(errors.some(e => e.includes('middleware') && e.includes('function')));
  });

  test('should return error for invalid routes format', function() {
    const plugin = {
      name: 'test',
      version: '1.0.0',
      routes: 'not an array'
    };

    const errors = validatePlugin(plugin, 'test');
    assert.ok(errors.some(e => e.includes('routes') && e.includes('array')));
  });

  test('should return error for route missing method', function() {
    const plugin = {
      name: 'test',
      version: '1.0.0',
      routes: [{ path: '/api', handler: () => {} }]
    };

    const errors = validatePlugin(plugin, 'test');
    assert.ok(errors.some(e => e.includes('route[0]') && e.includes('method')));
  });

  test('should return error for route missing handler', function() {
    const plugin = {
      name: 'test',
      version: '1.0.0',
      routes: [{ method: 'GET', path: '/api' }]
    };

    const errors = validatePlugin(plugin, 'test');
    assert.ok(errors.some(e => e.includes('route[0]') && e.includes('handler')));
  });
});

describe('sanitizeLog', function() {
  test('should return non-objects as-is', function() {
    assert.strictEqual(sanitizeLog(null), null);
    assert.strictEqual(sanitizeLog('string'), 'string');
    assert.strictEqual(sanitizeLog(123), 123);
  });

  test('should redact sensitive keys', function() {
    const input = {
      username: 'test',
      password: 'secret123',
      apiToken: 'token123',
      data: { secret_key: 'value' }
    };

    const result = sanitizeLog(input);

    assert.strictEqual(result.username, 'test');
    assert.strictEqual(result.password, '[REDACTED]');
    assert.strictEqual(result.apiToken, '[REDACTED]');
    assert.strictEqual(result.data.secret_key, '[REDACTED]');
  });

  test('should handle arrays', function() {
    const input = [{ token: 'abc' }, { token: 'def' }];
    const result = sanitizeLog(input);

    assert.strictEqual(result[0].token, '[REDACTED]');
    assert.strictEqual(result[1].token, '[REDACTED]');
  });

  test('should not modify non-sensitive keys', function() {
    const input = {
      name: 'test',
      url: 'http://example.com',
      count: 42,
      enabled: true
    };

    const result = sanitizeLog(input);

    assert.strictEqual(result.name, 'test');
    assert.strictEqual(result.url, 'http://example.com');
    assert.strictEqual(result.count, 42);
    assert.strictEqual(result.enabled, true);
  });
});

describe('createPluginManager', function() {
  test('should create a PluginManager instance', function() {
    const pm = createPluginManager();
    assert.ok(pm instanceof PluginManager);
  });

  test('should pass options to PluginManager', function() {
    const customLogger = { log: () => {} };
    const pm = createPluginManager({
      logger: customLogger,
      enabledPlugins: 'a,b,c'
    });

    assert.strictEqual(pm.logger, customLogger);
    assert.deepStrictEqual(pm.enabledPlugins, ['a', 'b', 'c']);
  });
});

console.log('\n========================================');
console.log(`Tests: ${testsRun} run, ${testsPassed} passed, ${testsFailed} failed`);
console.log('========================================');

if (testsFailed > 0) {
  process.exit(1);
}
