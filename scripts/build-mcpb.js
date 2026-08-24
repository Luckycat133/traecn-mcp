'use strict';

/**
 * Build a deterministic .mcpb bundle for the local TRAECNclaw MCP server.
 *
 * Pipeline: npm pack -> extract -> npm ci --omit=dev -> public metadata ->
 * manifest.json -> secret scan -> official pack -> normalized zip. The bundle carries the full server
 * plus production dependencies and no credentials, TraeCN profile data, or
 * persisted state; runtime configuration is limited to the local gateway
 * host/port, an optional bearer token, and an optional client ID.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { MCP_CONTRACT_VERSION, MCP_TOOL_NAMES } = require('../src/mcp/contract');
const { MCP_TOOLS } = require('../src/mcp/tool-metadata');
const { publicPackageJson, publicReadme } = require('./build-npm-package');
const { assertNoSecrets } = require('./package-security');

const FIXED_MTIME = new Date('2026-01-01T00:00:00Z');
const REPO_ROOT = path.resolve(__dirname, '..');
const MCPB_CLI_PACKAGE = '@anthropic-ai/mcpb@2.1.2';

function quoteNpmCallArg(value) {
  const text = String(value);
  if (text.includes('\0')) throw new Error('npm call arguments cannot contain NUL bytes');
  return `'${text.replace(/'/g, "'\"'\"'")}'`;
}

function buildMcpbNpmCall(args) {
  return ['mcpb', ...args].map(quoteNpmCallArg).join(' ');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || REPO_ROOT,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  });
  if (result.error) {
    throw new Error(`${command} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout || result.status}`);
  }
  return result.stdout;
}

function buildMcpbManifest({ version, description, keywords, includeToolSummaries = true }) {
  const manifest = {
    manifest_version: '0.3',
    name: 'traecnclaw-mcp',
    display_name: 'TRAECNclaw MCP',
    version,
    description,
    author: { name: 'Luckycat133', url: 'https://github.com/Luckycat133' },
    repository: {
      type: 'git',
      url: 'https://github.com/Luckycat133/traecnclaw-mcp-skill.git'
    },
    homepage: 'https://github.com/Luckycat133/traecnclaw-mcp-skill',
    documentation: 'https://github.com/Luckycat133/traecnclaw-mcp-skill#readme',
    support: 'https://github.com/Luckycat133/traecnclaw-mcp-skill/issues',
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
    compatibility: {
      platforms: ['darwin'],
      runtimes: { node: '>=22' }
    }
  };
  if (includeToolSummaries) {
    manifest.tools = MCP_TOOLS.map(tool => ({ name: tool.name, description: tool.description }));
    manifest.tools_generated = false;
  }
  return manifest;
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

function buildMcpb({ outDir, revision, packageInfo, smitheryCompatible = false }) {
  const workRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'traecn-mcpb-'));
  const stagingRoot = path.join(workRoot, 'staging');
  const suffix = smitheryCompatible ? '-smithery' : '';
  const outPath = path.join(outDir, `traecnclaw-mcp-${packageInfo.version}${suffix}.mcpb`);
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
    fs.copyFileSync(
      path.join(REPO_ROOT, 'distribution', 'public-mirror', 'LICENSE'),
      path.join(stagingRoot, 'LICENSE')
    );

    run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stagingRoot });
    fs.writeFileSync(
      path.join(stagingRoot, 'package.json'),
      `${JSON.stringify(publicPackageJson(packageInfo), null, 2)}\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(stagingRoot, 'README.md'),
      publicReadme({ packageInfo, revision }),
      'utf8'
    );

    const manifest = buildMcpbManifest({
      version: packageInfo.version,
      description: packageInfo.description,
      keywords: [...packageInfo.keywords],
      // Smithery CLI 4.11.1 incorrectly validates MCPB's optional tool
      // summaries as full MCP tool definitions. Omitting the optional array
      // preserves official MCPB 0.3 conformance; Smithery discovers the real
      // 20-tool contract from the running server after import.
      includeToolSummaries: !smitheryCompatible
    });
    fs.writeFileSync(path.join(stagingRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    assertNoSecrets(stagingRoot);

    // Pin timestamps on directories as well as files so the official packer
    // produces byte-identical bundles from the same staged tree.
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
    // npm 11 removed the historical `npm exec --yes --package ... --` form.
    // `--call` works across the supported npm eras; quote each generated path
    // before npm invokes the pinned official CLI through the POSIX shell.
    if (process.platform === 'win32') {
      throw new Error('MCPB release packaging requires the supported macOS/POSIX environment');
    }
    const npmCommand = 'npm';
    const mcpbArgs = ['exec', `--package=${MCPB_CLI_PACKAGE}`, '--call'];
    run(npmCommand, [
      ...mcpbArgs,
      buildMcpbNpmCall(['validate', path.join(stagingRoot, 'manifest.json')])
    ]);
    const officialPackPath = path.join(workRoot, path.basename(outPath));
    run(npmCommand, [...mcpbArgs, buildMcpbNpmCall(['pack', stagingRoot, officialPackPath])]);

    // The official packer currently stamps every ZIP entry with the build
    // time. Normalize its exact selected file set after packing so release
    // checksums remain reproducible without weakening official validation.
    const normalizedRoot = path.join(workRoot, 'normalized');
    fs.mkdirSync(normalizedRoot, { recursive: true });
    run('unzip', ['-q', officialPackPath, '-d', normalizedRoot]);
    pinMtimes(normalizedRoot);
    run('zip', ['-X', '-q', outPath, ...sortedStagedFiles(normalizedRoot)], {
      cwd: normalizedRoot
    });

    const meta = {
      file: path.basename(outPath),
      bytes: fs.statSync(outPath).size,
      sha256: sha256File(outPath),
      version: packageInfo.version,
      contractVersion: MCP_CONTRACT_VERSION,
      toolCount: MCP_TOOL_NAMES.length,
      sourceRevision: revision,
      deterministicMtime: FIXED_MTIME.toISOString()
    };
    if (smitheryCompatible) meta.smitheryCompatible = true;
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
    packageInfo,
    smitheryCompatible: process.argv.includes('--smithery-compatible')
  });
  console.log(`[build-mcpb] Wrote ${outPath}`);
  console.log(`[build-mcpb] sha256=${meta.sha256} bytes=${meta.bytes} revision=${meta.sourceRevision}`);
}

module.exports = {
  FIXED_MTIME,
  MCPB_CLI_PACKAGE,
  quoteNpmCallArg,
  buildMcpbNpmCall,
  buildMcpb,
  buildMcpbManifest,
  assertNoSecrets,
  sortedStagedFiles,
  sha256File
};
