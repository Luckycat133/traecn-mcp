#!/usr/bin/env node
'use strict';

/**
 * Build the deliberately public, scoped npm package without making the
 * canonical private-source package publishable by accident.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { assertNoSecrets } = require('./package-security');

const REPO_ROOT = path.resolve(__dirname, '..');
const PUBLIC_PACKAGE_NAME = '@luckycat133/traecnclaw';
const PUBLIC_REPOSITORY = 'https://github.com/Luckycat133/traecn-mcp';
const PUBLIC_README_TEMPLATE = path.join(
  REPO_ROOT,
  'distribution',
  'public-mirror',
  'README.md.template'
);
const PUBLIC_SCRIPT_NAMES = Object.freeze([
  'start',
  'doctor',
  'quickstart',
  'setup:mcp',
  'start:traecn',
  'start:gateway',
  'service:install',
  'service:start',
  'service:stop',
  'service:status',
  'service:uninstall',
  'inspect:traecn',
  'inspect:verify',
  'mcp'
]);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function publicPackageJson(packageInfo) {
  const scripts = Object.fromEntries(
    PUBLIC_SCRIPT_NAMES
      .filter((name) => packageInfo.scripts?.[name])
      .map((name) => [name, packageInfo.scripts[name]])
  );
  const published = {
    ...packageInfo,
    name: PUBLIC_PACKAGE_NAME,
    homepage: PUBLIC_REPOSITORY,
    repository: { type: 'git', url: `${PUBLIC_REPOSITORY}.git` },
    bugs: { url: `${PUBLIC_REPOSITORY}/issues` },
    os: ['darwin'],
    publishConfig: { access: 'public' },
    scripts,
    files: [
      ...(packageInfo.files || []),
      '!docs/CHANNEL-LEDGER.md',
      '!docs/DISTRIBUTION.md',
      '!docs/LAUNCH-KIT.md'
    ]
  };
  delete published.private;
  return published;
}

function publicReadme({ packageInfo, revision, template = fs.readFileSync(PUBLIC_README_TEMPLATE, 'utf8') }) {
  if (!/^[a-f0-9]{40}$/.test(revision || '')) throw new Error('source revision must be a full Git commit');
  const rendered = template
    .replaceAll('{{VERSION}}', packageInfo.version)
    .replaceAll('{{SOURCE_REVISION}}', revision);
  if (rendered.includes('{{')) throw new Error('public README still contains template markers');
  return rendered;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function buildNpmPackage({
  outDir,
  packageInfo = require('../package.json'),
  revision = run('git', ['rev-parse', 'HEAD'])
}) {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'traecn-npm-package-'));
  const stagingRoot = path.join(workRoot, 'staging');
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const outPath = path.join(outDir, `traecnclaw-${packageInfo.version}.tgz`);

  try {
    fs.mkdirSync(stagingRoot, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });

    const sourcePack = JSON.parse(run(npmCommand, [
      'pack', '--pack-destination', workRoot, '--json'
    ]))[0];
    if (!sourcePack?.filename) throw new Error('npm pack did not report a source artifact');
    run('tar', ['-xzf', path.join(workRoot, sourcePack.filename), '-C', stagingRoot]);

    const packageRoot = path.join(stagingRoot, 'package');
    const publishedInfo = publicPackageJson(packageInfo);
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      `${JSON.stringify(publishedInfo, null, 2)}\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(packageRoot, 'README.md'),
      publicReadme({ packageInfo, revision }),
      'utf8'
    );
    fs.copyFileSync(
      path.join(REPO_ROOT, 'distribution', 'public-mirror', 'LICENSE'),
      path.join(packageRoot, 'LICENSE')
    );
    assertNoSecrets(packageRoot);

    const publicPack = JSON.parse(run(npmCommand, [
      'pack', '--pack-destination', workRoot, '--json'
    ], { cwd: packageRoot }))[0];
    if (!publicPack?.filename) throw new Error('npm pack did not report a public artifact');

    fs.rmSync(outPath, { force: true });
    fs.copyFileSync(path.join(workRoot, publicPack.filename), outPath);
    return {
      outPath,
      package: {
        name: PUBLIC_PACKAGE_NAME,
        version: packageInfo.version,
        mcpName: packageInfo.mcpName,
        registry: 'npm',
        public: true,
        os: ['darwin']
      },
      bytes: fs.statSync(outPath).size,
      sha256: sha256File(outPath)
    };
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const outIndex = process.argv.indexOf('--out');
  const outDir = path.resolve(outIndex === -1 ? path.join(REPO_ROOT, 'dist') : process.argv[outIndex + 1]);
  const result = buildNpmPackage({ outDir });
  console.log(`[build-npm-package] Wrote ${result.outPath}`);
  console.log(`[build-npm-package] sha256=${result.sha256} bytes=${result.bytes}`);
}

module.exports = {
  PUBLIC_PACKAGE_NAME,
  PUBLIC_README_TEMPLATE,
  PUBLIC_REPOSITORY,
  PUBLIC_SCRIPT_NAMES,
  buildNpmPackage,
  publicPackageJson,
  publicReadme,
  sha256File
};
