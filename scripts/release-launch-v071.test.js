'use strict';

const assert = require('node:assert/strict');
const { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sha256File } = require('./build-npm-package');

const launch = path.join(__dirname, 'release-launch-v071.sh');
const fixture = mkdtempSync(path.join(os.tmpdir(), 'traecn-release-launch-'));
const sha = '1'.repeat(40);
const before = '2'.repeat(40);
const env = {
  ...process.env,
  PATH: `${fixture}/bin:${process.env.PATH}`,
  GITHUB_EVENT_NAME: 'push',
  GITHUB_REPOSITORY: 'Luckycat133/traecn-mcp',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: sha,
  LAUNCH_BEFORE: before,
  FIXTURE: fixture
};

function run(mode, changes = {}) {
  const result = spawnSync('bash', [launch, mode], {
    env: { ...env, ...changes }, cwd: fixture, encoding: 'utf8'
  });
  assert.ifError(result.error);
  return result;
}

function write(relative, contents, mode) {
  writeFileSync(path.join(fixture, relative), contents, { mode });
}

try {
  for (const dir of ['bin', 'scripts', 'dist', '.release']) mkdirSync(path.join(fixture, dir));
  for (const file of ['verify-release.js', 'build-npm-package.js', 'package-security.js']) {
    cpSync(path.join(__dirname, file), path.join(fixture, 'scripts', file));
  }
  write('package.json', JSON.stringify({ version: '0.7.1' }));
  write('.release/approve-v0.7.1', 'v0.7.1\n');
  write('bin/git', `#!/bin/bash
case "$1 $2" in
  "rev-parse HEAD") printf '%s\\n' "$GITHUB_SHA" ;;
  "diff --name-status") printf '%b\\n' "${'$'}{TEST_DIFF:-A\\t.release/approve-v0.7.1}" ;;
  "status --porcelain") : ;;
  "ls-remote --exit-code")
    if [[ "$4" == refs/heads/main ]]; then
      printf '%s\\t%s\\n' "${'$'}{TEST_MAIN:-$GITHUB_SHA}" "$4"
    elif [[ -f "$FIXTURE/tag" ]]; then
      printf '%s\\t%s\\n' "$(cat "$FIXTURE/tag")" "$4"
    else
      exit 2
    fi ;;
  *) exit 7 ;;
esac
`, 0o755);
  write('bin/gh', `#!/bin/bash
case "$1 $2" in
  "api --paginate")
    if [[ -f "$FIXTURE/published" ]]; then printf 'v0.7.1\\n'; fi ;;
  "api --method")
    [[ "$3" == POST && "$4" == repos/Luckycat133/traecn-mcp/git/refs && "$6" == ref=refs/tags/v0.7.1 && "$8" == "sha=$GITHUB_SHA" ]] || exit 7
    [[ ! -e "$FIXTURE/tag" && "${'$'}{TEST_REF_RACE:-}" != yes ]] || exit 7
    printf '%s' "$GITHUB_SHA" > "$FIXTURE/tag"
    printf 'create-only\\n' >> "$FIXTURE/ref-writes"
    printf '%s\\n' "$GITHUB_SHA" ;;
  "api repos/Luckycat133/traecn-mcp/releases/tags/v0.7.1") cat "$FIXTURE/public.json" ;;
  "release create")
    [[ "$(cat "$FIXTURE/tag")" == "$GITHUB_SHA" ]] || exit 7
    printf '%s\\n' "$@" >> "$FIXTURE/writes"
    mkdir -p "$FIXTURE/public-dist"
    cp "$FIXTURE"/dist/* "$FIXTURE/public-dist/"
    touch "$FIXTURE/published" ;;
  "release download") cp "$FIXTURE"/public-dist/* "$7/" ;;
  *) exit 7 ;;
esac
`, 0o755);

  const names = [
    'traecn-mcp-0.7.1.mcpb', 'traecn-mcp-0.7.1.mcpb.meta.json',
    'traecn-mcp-skill.tgz', 'traecn-mcp-skill.zip', 'traecnclaw-0.7.1.tgz'
  ];
  for (const name of names) write(`dist/${name}`, name);
  const entries = names.map(name => ({
    path: `dist/${name}`, bytes: Buffer.byteLength(name), sha256: sha256File(path.join(fixture, 'dist', name))
  }));
  write('dist/traecn-mcp-release.json', JSON.stringify({
    sourceRevision: sha, sourceDirty: false, version: '0.7.1',
    artifacts: entries.slice(0, -1), serverPackage: { version: '0.7.1', artifact: entries.at(-1) }
  }));
  write('public.json', JSON.stringify({
    draft: false, prerelease: false,
    assets: [...names, 'traecn-mcp-release.json'].map(name => ({
      name, digest: `sha256:${sha256File(path.join(fixture, 'dist', name))}`
    }))
  }));
  for (const changes of [
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_REF: 'refs/heads/topic' },
    { GITHUB_REPOSITORY: 'other/traecn-mcp' },
    { TEST_DIFF: 'M\\t.release/approve-v0.7.1' },
    { TEST_DIFF: 'A\\t.release/approve-v0.7.1\\nM\\tpackage.json' },
    { TEST_MAIN: before }
  ]) {
    const refused = run('publish', changes);
    assert.notEqual(refused.status, 0, JSON.stringify(changes));
    assert.match(refused.stderr, /Release launch refused:/);
  }
  assert.throws(() => readFileSync(path.join(fixture, 'writes')), /ENOENT/);
  assert.equal(run('artifacts').status, 0);
  const raced = run('publish', { TEST_REF_RACE: 'yes' });
  assert.notEqual(raced.status, 0);
  assert.throws(() => readFileSync(path.join(fixture, 'writes')), /ENOENT/);
  const published = run('publish');
  assert.equal(published.status, 0, published.stderr);
  const writes = readFileSync(path.join(fixture, 'writes'), 'utf8');
  assert.ok(writes.includes(`--verify-tag\n--target\n${sha}\n`));
  assert.equal(readFileSync(path.join(fixture, 'ref-writes'), 'utf8'), 'create-only\n');
  assert.equal(writes.match(/^dist\//gm).length, 6);
  const replay = run('publish');
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(readFileSync(path.join(fixture, 'writes'), 'utf8'), writes);
  const manifestFile = path.join(fixture, 'dist/traecn-mcp-release.json');
  const original = readFileSync(manifestFile, 'utf8');
  writeFileSync(manifestFile, JSON.stringify({ ...JSON.parse(original), generatedAt: 'another build' }));
  const mismatch = run('publish');
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /independently staged assets/);
  assert.match(mismatch.stderr, /dist\/traecn-mcp-release.json/);
  assert.equal(readFileSync(path.join(fixture, 'writes'), 'utf8'), writes);
  writeFileSync(manifestFile, original);
  rmSync(path.join(fixture, 'published'));
  const recovered = run('publish');
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(readFileSync(path.join(fixture, 'ref-writes'), 'utf8'), 'create-only\n');
  assert.equal(readFileSync(path.join(fixture, 'writes'), 'utf8'), writes + writes);
  write('tag', before);
  assert.notEqual(run('publish').status, 0);
  assert.equal(readFileSync(path.join(fixture, 'writes'), 'utf8'), writes + writes);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.log('[release-launch-v071.test.js] PASS (no network or release writes)');
