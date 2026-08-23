'use strict';

/**
 * Build a deterministic .mcpb bundle for the local TRAECNclaw MCP server.
 *
 * Pipeline: npm pack -> extract -> npm ci --omit=dev -> manifest.json ->
 * secret scan -> fixed-timestamp zip. The bundle carries the full server
 * plus production dependencies and no credentials, TraeCN profile data, or
 * persisted state; runtime configuration is limited to the local gateway
 * host/port, an optional bearer token, and an optional client ID.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { MCP_CONTRACT_VERSION, MCP_TOOL_NAMES } = require('../src/mcp/contract');

const FIXED_MTIME = new Date('2026-01-01T00:00:00Z').getTime();
const REPO_ROOT = path.resolve(__dirname, '..');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || REPO_ROOT,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout || result.status}`);
  }
  return result.stdout;
}

function buildMcpbManifest({ version, description, keywords }) {
  return {
    manifest_version: '0.3',
    name: 'traecnclaw-mcp',
    display_name: 'TRAECNclaw MCP',
    version,
    description,
    author: { name: 'Luckycat133', url: 'https://github.com/Luckycat133' },
    repository: 'https://github.com/Luckycat133/TRAECNclaw',
    homepage: 'https://github.com/Luckycat133/traecnclaw-mcp-skill',
    support: 'https://github.com/Luckycat133/TRAECNclaw/issues',
    license: 'MIT',
    keywords,
    server: {
      type: 'node',
      entry_point: 'mcp-server.js',
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/mcp-server.js'],
        env: {
          TRAECN_GATEWAY_HOST: '${user_config.gateway_host}',
          TRAECN_GATEWAY_PORT: '${user_config.gateway_port}',
          TRAECN_GATEWAY_TOKEN: '${user_config.gateway_token}',
          TRAECN_MCP_CLIENT_ID: '${user_config.client_id}'
        }
      }
    },
    user_config: {
      gateway_host: {
        type: 'string',
        title: 'Gateway host',
        description: 'Host of the local TRAECNclaw gateway.',
        default: '127.0.0.1',
        required: false
      },
      gateway_port: {
        type: 'string',
        title: 'Gateway port',
        description: 'Port of the local TRAECNclaw gateway.',
        default: '8788',
        required: false
      },
      gateway_token: {
        type: 'string',
        title: 'Gateway token',
        description: 'Bearer token for the local gateway; leave empty when the gateway runs without authorization.',
        default: '',
        required: false,
        sensitive: true
      },
      client_id: {
        type: 'string',
        title: 'MCP client ID',
        description: 'Stable client identifier recorded by the gateway; leave empty to derive one from the host name.',
        default: '',
        required: false
      }
    },
    tools: [...MCP_TOOL_NAMES],
    compatibility: {
      platforms: ['darwin'],
      runtimes: { node: '>=22' }
    }
  };
}

const SECRET_FILE_PATTERN = /(^|\/)\.env(?!\.example$)([^/]*$)/;
const SECRET_CONTENT_PATTERN = /\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|(?:api[-_]?key|token|password)\s*[:=]\s*["'][^"'\s]{16,}["'])/i;

function assertNoSecrets(stagingRoot) {
  const offenders = [];
  function visit(currentPath, relativePath = '') {
    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      const childRelative = path.join(relativePath, entry.name);
      const childPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        visit(childPath, childRelative);
        continue;
      }
      if (!entry.isFile()) continue;
      if (SECRET_FILE_PATTERN.test(childRelative)) {
        offenders.push(`${childRelative} (credential-looking filename)`);
        continue;
      }
      const stat = fs.statSync(childPath);
      if (stat.size > 4 * 1024 * 1024) continue;
      const text = fs.readFileSync(childPath, 'utf8');
      if (SECRET_CONTENT_PATTERN.test(text)) offenders.push(`${childRelative} (credential-looking content)`);
    }
  }
  visit(stagingRoot);
  if (offenders.length) {
    throw new Error(`MCPB staging contains credential-looking files:\n${offenders.join('\n')}`);
  }
}

function sortedStagedFiles(stagingRoot) {
  const files = [];
  function visit(currentPath, relativePath = '') {
    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRelative = path.join(relativePath, entry.name);
      const childPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) visit(childPath, childRelative);
      else if (entry.isFile()) files.push(childRelative.split(path.sep).join('/'));
    }
  }
  visit(stagingRoot);
  return files;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function buildMcpb({ outDir, revision, packageInfo }) {
  const workRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'traecn-mcpb-'));
  const stagingRoot = path.join(workRoot, 'staging');
  const outPath = path.join(outDir, `traecnclaw-mcp-${packageInfo.version}.mcpb`);
  try {
    fs.mkdirSync(stagingRoot, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });

    run('npm', ['pack', '--pack-destination', workRoot]);
    const tarball = fs.readdirSync(workRoot).find(name => name.endsWith('.tgz'));
    if (!tarball) throw new Error('npm pack produced no tarball');
    run('tar', ['-xzf', tarball, '-C', stagingRoot], { cwd: workRoot });
    const packageDir = path.join(stagingRoot, 'package');
    for (const entry of fs.readdirSync(packageDir)) {
      fs.renameSync(path.join(packageDir, entry), path.join(stagingRoot, entry));
    }
    fs.rmdirSync(packageDir);
    // The published tarball omits the lockfile; restore it so dependency
    // installation stays pinned to the audited tree.
    fs.copyFileSync(path.join(REPO_ROOT, 'package-lock.json'), path.join(stagingRoot, 'package-lock.json'));

    run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stagingRoot });

    const manifest = buildMcpbManifest({
      version: packageInfo.version,
      description: packageInfo.description,
      keywords: [...packageInfo.keywords]
    });
    fs.writeFileSync(path.join(stagingRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    assertNoSecrets(stagingRoot);

    // Pin timestamps on directories as well as files: zip stores directory
    // entries too, and their creation-time mtimes would break determinism.
    function pinMtimes(currentPath) {
      fs.utimesSync(currentPath, FIXED_MTIME, FIXED_MTIME);
      for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
        const childPath = path.join(currentPath, entry.name);
        if (entry.isDirectory()) pinMtimes(childPath);
        else if (entry.isFile()) fs.utimesSync(childPath, FIXED_MTIME, FIXED_MTIME);
      }
    }
    pinMtimes(stagingRoot);
    fs.rmSync(outPath, { force: true });
    run('zip', ['-X', '-rq', outPath, '.'], { cwd: stagingRoot });

    const meta = {
      file: path.basename(outPath),
      bytes: fs.statSync(outPath).size,
      sha256: sha256File(outPath),
      version: packageInfo.version,
      contractVersion: MCP_CONTRACT_VERSION,
      toolCount: MCP_TOOL_NAMES.length,
      sourceRevision: revision,
      deterministicMtime: new Date(FIXED_MTIME).toISOString()
    };
    fs.writeFileSync(
      path.join(outDir, `${path.basename(outPath)}.meta.json`),
      `${JSON.stringify(meta, null, 2)}\n`,
      'utf8'
    );
    return { outPath, meta };
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

if (require.main === module) {
  const packageInfo = require(path.join(REPO_ROOT, 'package.json'));
  const revisionResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (revisionResult.status !== 0) throw new Error('git rev-parse HEAD failed');
  const { outPath, meta } = buildMcpb({
    outDir: path.resolve(argValue('--out') || path.join(REPO_ROOT, 'dist')),
    revision: argValue('--revision') || revisionResult.stdout.trim(),
    packageInfo
  });
  console.log(`[build-mcpb] Wrote ${outPath}`);
  console.log(`[build-mcpb] sha256=${meta.sha256} bytes=${meta.bytes} revision=${meta.sourceRevision}`);
}

module.exports = {
  FIXED_MTIME,
  buildMcpb,
  buildMcpbManifest,
  assertNoSecrets,
  sortedStagedFiles,
  sha256File
};
