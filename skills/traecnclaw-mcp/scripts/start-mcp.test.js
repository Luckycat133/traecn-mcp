'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

console.log('[start-mcp Test] Running tests...');

const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

function expect(value) {
  return {
    toBe(expected) {
      if (value !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`);
      }
    },
    toEqual(expected) {
      if (JSON.stringify(value) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`);
      }
    },
    toBeDefined() {
      if (value === undefined) {
        throw new Error('Expected value to be defined');
      }
    },
    toBeNull() {
      if (value !== null) {
        throw new Error(`Expected null, got ${JSON.stringify(value)}`);
      }
    },
    toBeTruthy() {
      if (!value) {
        throw new Error(`Expected truthy value, got ${value}`);
      }
    },
    toContain(expected) {
      if (!value.includes(expected)) {
        throw new Error(`Expected ${JSON.stringify(value)} to contain ${JSON.stringify(expected)}`);
      }
    },
    not: {
      toBe(expected) {
        if (value === expected) {
          throw new Error(`Expected ${JSON.stringify(value)} not to be ${JSON.stringify(expected)}`);
        }
      }
    }
  };
}

// --- Test fixtures ---

/**
 * Create a temporary directory with a fake mcp-server.js file inside.
 * Returns { dir, serverFile } where serverFile is the path to the fake file.
 */
function makeFakeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-mcp-test-'));
  const serverFile = path.join(dir, 'mcp-server.js');
  fs.writeFileSync(serverFile, 'module.exports = { startStdioServer() {} };\n');
  return { dir, serverFile };
}

/**
 * Build a fake scripts dir structure so that `path.resolve(scriptDir, '../../..')`
 * points at `repoDir`. Structure: repoDir/x/y/scripts (scriptDir = repoDir/x/y/scripts).
 */
function makeFakeScriptDir(repoDir) {
  const scriptDir = path.join(repoDir, 'a', 'b', 'scripts');
  fs.mkdirSync(scriptDir, { recursive: true });
  return scriptDir;
}

// --- Tests ---

test('module exports resolveServerPath and main', () => {
  const mod = require('./start-mcp');
  expect(typeof mod.resolveServerPath).toBe('function');
  expect(typeof mod.main).toBe('function');
});

test('resolveServerPath never loads an arbitrary server path from the environment', () => {
  const { dir, serverFile } = makeFakeRepo();
  try {
    const env = { TRAECN_MCP_SERVER_PATH: serverFile };
    const scriptDir = makeFakeScriptDir(path.join(dir, 'skill-root'));
    const result = require('./start-mcp').resolveServerPath(env, scriptDir, { cwd: dir });
    expect(result).toBeNull();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveServerPath falls back to in-repo path when env var is not set', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-mcp-repo-'));
  const scriptDir = makeFakeScriptDir(repoDir);
  const expectedServer = path.join(repoDir, 'mcp-server.js');
  fs.writeFileSync(expectedServer, 'module.exports = {};\n');
  try {
    const env = {};
    const result = require('./start-mcp').resolveServerPath(env, scriptDir, { cwd: repoDir });
    expect(result).toBe(path.resolve(expectedServer));
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('resolveServerPath returns null when no candidate exists', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-mcp-empty-'));
  const scriptDir = makeFakeScriptDir(repoDir);
  try {
    const env = { TRAECN_MCP_SERVER_PATH: '/nonexistent/path/server.js' };
    const result = require('./start-mcp').resolveServerPath(env, scriptDir, { cwd: repoDir });
    expect(result).toBeNull();
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('resolveServerPath rejects directories even if they exist', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-mcp-dir-'));
  const scriptDir = makeFakeScriptDir(repoDir);
  try {
    // TRAECN_MCP_SERVER_PATH points at a directory, not a file
    const env = { TRAECN_MCP_SERVER_PATH: repoDir };
    const result = require('./start-mcp').resolveServerPath(env, scriptDir, { cwd: repoDir });
    expect(result).toBeNull();
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('resolveServerPath prefers the repository entry point over an environment override', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-mcp-prio-'));
  const scriptDir = makeFakeScriptDir(repoDir);
  const inRepoServer = path.join(repoDir, 'mcp-server.js');
  fs.writeFileSync(inRepoServer, 'module.exports = {};\n');
  const envServer = path.join(repoDir, 'custom-server.js');
  fs.writeFileSync(envServer, 'module.exports = {};\n');
  try {
    const env = { TRAECN_MCP_SERVER_PATH: envServer };
    const result = require('./start-mcp').resolveServerPath(env, scriptDir);
    expect(result).toBe(path.resolve(inRepoServer));
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('resolveServerPath ignores empty string env var', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-mcp-empty-env-'));
  const scriptDir = makeFakeScriptDir(repoDir);
  const inRepoServer = path.join(repoDir, 'mcp-server.js');
  fs.writeFileSync(inRepoServer, 'module.exports = {};\n');
  try {
    const env = { TRAECN_MCP_SERVER_PATH: '' };
    const result = require('./start-mcp').resolveServerPath(env, scriptDir);
    expect(result).toBe(path.resolve(inRepoServer));
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('resolveServerPath finds the installed traecnclaw package from the launch directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'start-mcp-package-'));
  const scriptDir = makeFakeScriptDir(path.join(root, 'skill-root'));
  const packageDir = path.join(root, 'runtime', 'node_modules', 'traecnclaw');
  const serverFile = path.join(packageDir, 'mcp-server.js');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
    name: 'traecnclaw',
    exports: { './mcp': './mcp-server.js' }
  }));
  fs.writeFileSync(serverFile, 'module.exports = { startStdioServer() {} };\n');
  try {
    const result = require('./start-mcp').resolveServerPath({}, scriptDir, {
      cwd: path.join(root, 'runtime')
    });
    expect(result).toBe(fs.realpathSync(serverFile));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveServerPath falls back to a traecnclaw-mcp executable on PATH', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'start-mcp-path-'));
  const scriptDir = makeFakeScriptDir(path.join(root, 'skill-root'));
  const binDir = path.join(root, 'bin');
  const serverFile = path.join(binDir, 'traecnclaw-mcp');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(serverFile, '#!/usr/bin/env node\nmodule.exports = { startStdioServer() {} };\n');
  fs.chmodSync(serverFile, 0o755);
  try {
    const result = require('./start-mcp').resolveServerPath({ PATH: binDir }, scriptDir, {
      cwd: root,
      platform: 'darwin'
    });
    expect(result).toBe(path.resolve(serverFile));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- Runner ---

async function runTests() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${err.message}`);
      failed++;
    }
  }

  console.log(`\n[start-mcp Test] Results: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

runTests().then(success => {
  process.exit(success ? 0 : 1);
}).catch(err => {
  console.error('[start-mcp Test] Fatal error:', err);
  process.exit(1);
});
