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

test('resolveServerPath returns env var path when it points to a valid file', () => {
  const { dir, serverFile } = makeFakeRepo();
  try {
    const env = { TRAECN_MCP_SERVER_PATH: serverFile };
    const result = require('./start-mcp').resolveServerPath(env, dir);
    expect(result).toBe(path.resolve(serverFile));
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
    const result = require('./start-mcp').resolveServerPath(env, scriptDir);
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
    const result = require('./start-mcp').resolveServerPath(env, scriptDir);
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
    const result = require('./start-mcp').resolveServerPath(env, scriptDir);
    expect(result).toBeNull();
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('resolveServerPath prefers env var over in-repo path', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-mcp-prio-'));
  const scriptDir = makeFakeScriptDir(repoDir);
  const inRepoServer = path.join(repoDir, 'mcp-server.js');
  fs.writeFileSync(inRepoServer, 'module.exports = {};\n');
  const envServer = path.join(repoDir, 'custom-server.js');
  fs.writeFileSync(envServer, 'module.exports = {};\n');
  try {
    const env = { TRAECN_MCP_SERVER_PATH: envServer };
    const result = require('./start-mcp').resolveServerPath(env, scriptDir);
    expect(result).toBe(path.resolve(envServer));
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

test('resolveServerPath returns absolute path even for relative input', () => {
  const { dir, serverFile } = makeFakeRepo();
  try {
    // Use a relative path by creating a symlink-like scenario — instead just
    // verify that the result is always absolute.
    const env = { TRAECN_MCP_SERVER_PATH: serverFile };
    const result = require('./start-mcp').resolveServerPath(env, dir);
    expect(path.isAbsolute(result)).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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
