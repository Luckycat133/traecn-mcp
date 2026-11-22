#!/usr/bin/env bash
# Run from the repository root, never with publish credentials.
set -euo pipefail

mode="${1:-check}"
canonical=Formula/traecnclaw.rb
repo=Luckycat133/traecn-mcp
[[ "$mode" == render || "$mode" == check || "$mode" == native ]] || exit 2

version="$(node -p 'require("./distribution/homebrew/public-release.json").version')"
release_sha="$(node -p 'require("./distribution/homebrew/public-release.json").sourceRevision')"
[[ "$version" =~ ^0\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || exit 2
[[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] || exit 2
tag="v$version"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/dist"

remote=https://github.com/$repo.git
ref="refs/tags/$tag"
git ls-remote --exit-code "$remote" "$ref" "$ref^{}" > "$tmp/tag"
actual="$(awk -v ref="$ref" '$2==ref { plain=$1 } $2==ref "^{}" { peeled=$1 } END { print peeled ? peeled : plain }' "$tmp/tag")"
[[ "$actual" == "$release_sha" ]] || { echo 'Public tag does not resolve to the pinned source revision' >&2; exit 1; }

archive="traecnclaw-$version.tgz"
assets=(
  "traecn-mcp-$version.mcpb"
  "traecn-mcp-$version.mcpb.meta.json"
  "traecn-mcp-release.json"
  "traecn-mcp-skill.tgz"
  "traecn-mcp-skill.zip"
  "$archive"
)
download() {
  curl --fail --silent --show-error --location --retry 3 --proto '=https' --proto-redir '=https' "$@"
}
download "https://api.github.com/repos/$repo/releases/tags/$tag" --output "$tmp/release-api.json"
for filename in "${assets[@]}"; do
  download "https://github.com/$repo/releases/download/$tag/$filename" --output "$tmp/dist/$filename"
done

node - "$tmp" "$tag" "$release_sha" "${assets[@]}" <<'JS'
const assert = require('node:assert/strict');
const path = require('node:path');
const { verifyManifest } = require('./scripts/verify-release');
const { sha256File } = require('./scripts/build-npm-package');
const [root, tag, revision, ...files] = process.argv.slice(2);
const release = require(path.join(root, 'release-api.json'));
const manifestFile = path.join(root, 'dist/traecn-mcp-release.json');
const manifest = require(manifestFile);
assert.equal(release.tag_name, tag);
assert.equal(release.draft, false);
assert.equal(release.prerelease, false);
assert.ok(release.published_at);
assert.deepEqual(release.assets.map(asset => asset.name).sort(), [...files].sort());
assert.deepEqual(verifyManifest({ repoRoot: root, manifestPath: manifestFile, revision, version: tag.slice(1) }), []);
assert.deepEqual(
  [...manifest.artifacts.map(a => a.path), manifest.serverPackage.artifact.path, 'dist/traecn-mcp-release.json'].sort(),
  files.map(file => `dist/${file}`).sort()
);
for (const file of files) {
  const entry = release.assets.find(asset => asset.name === file);
  assert.equal(entry.state, 'uploaded');
  assert.equal(entry.digest, `sha256:${sha256File(path.join(root, 'dist', file))}`, file);
}
console.log(`Verified ${tag} at ${revision}: six public asset bytes and GitHub digests.`);
JS

node scripts/homebrew-formula.js --manifest "$tmp/dist/traecn-mcp-release.json" --out "$tmp/traecnclaw.rb"
if [[ "$mode" == render ]]; then
  [[ -n "${2:-}" && ! -e "$2" ]] || { echo 'Supply a new local output path' >&2; exit 2; }
  cp "$tmp/traecnclaw.rb" "$2"
  exit 0
fi
cmp "$tmp/traecnclaw.rb" "$canonical"
if [[ "$mode" == native ]]; then
  [[ "$(node -p process.platform)" == darwin ]] || exit 2
  ruby -c "$canonical"
  export HOMEBREW_CACHE="$tmp/fresh-homebrew-cache"
  export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_ANALYTICS=1
  tap=luckycat-ci/traecn-public-verification
  brew tap-new --no-git "$tap"
  tap_path="$(brew --repository "$tap")"
  mkdir -p "$tap_path/Formula"
  cp "$canonical" "$tap_path/Formula/traecnclaw.rb"
  brew install --formula "$tap/traecnclaw"
  brew test "$tap/traecnclaw"
  "$(brew --prefix "$tap/traecnclaw")/bin/traecn-mcp" help
fi
