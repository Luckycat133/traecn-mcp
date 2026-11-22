#!/usr/bin/env bash
# Used only by the opt-in v0.7.1 workflow. It never signs into or starts TraeCN.
set -euo pipefail

tag=v0.7.1
version=0.7.1
repo=Luckycat133/traecn-mcp
marker=.release/approve-v0.7.1

die() {
  printf 'Release launch refused: %s\n' "$*" >&2
  exit 1
}

preflight() {
  [[ "${GITHUB_EVENT_NAME:-}" == push ]] || die "expected a push event"
  [[ "${GITHUB_REPOSITORY:-}" == "$repo" ]] || die "repository mismatch"
  [[ "${GITHUB_REF:-}" == refs/heads/main ]] || die "not the main branch"
  [[ "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || die "invalid event SHA"
  [[ "${LAUNCH_BEFORE:-}" =~ ^[0-9a-f]{40}$ ]] || die "invalid before SHA"

  local head changes main actual_version status
  head="$(git rev-parse HEAD)" || die "cannot resolve checkout"
  [[ "$head" == "$GITHUB_SHA" ]] || die "checkout SHA mismatch"
  changes="$(git diff --name-status --no-renames "$LAUNCH_BEFORE" "$GITHUB_SHA")" || die "cannot compare the main event"
  [[ "$changes" == $'A\t'"$marker" ]] || die "the event must only add the marker"
  cmp -s "$marker" <(printf '%s\n' "$tag") || die "release marker contents mismatch"
  main="$(git ls-remote --exit-code origin refs/heads/main | cut -f1)" || die "cannot resolve origin/main"
  [[ "$main" == "$GITHUB_SHA" ]] || die "origin/main moved or does not match the event"
  actual_version="$(node -p 'require("./package.json").version')" || die "cannot read package version"
  [[ "$actual_version" == "$version" ]] || die "package version mismatch"
  status="$(git status --porcelain)" || die "cannot inspect checkout status"
  [[ -z "$status" ]] || die "checkout is dirty"
}

assets=(
  'dist/traecn-mcp-0.7.1.mcpb'
  'dist/traecn-mcp-0.7.1.mcpb.meta.json'
  'dist/traecn-mcp-release.json'
  'dist/traecn-mcp-skill.tgz'
  'dist/traecn-mcp-skill.zip'
  'dist/traecnclaw-0.7.1.tgz'
)

check_artifacts() {
  local root="${1:-.}"
  node - "$root" "$version" "$GITHUB_SHA" "${assets[@]}" <<'JS'
const assert = require('node:assert/strict');
const path = require('node:path');
const { verifyManifest } = require('./scripts/verify-release');
const [repoRoot, version, revision, ...assets] = process.argv.slice(2);
const manifestPath = path.resolve(repoRoot, 'dist/traecn-mcp-release.json');
assert.deepEqual(verifyManifest({ repoRoot, manifestPath, version, revision }), []);
const manifest = require(manifestPath);
assert.deepEqual(
  [...manifest.artifacts.map(a => a.path), manifest.serverPackage.artifact.path, 'dist/traecn-mcp-release.json'].sort(),
  assets.sort(),
  'Unexpected release artifact set'
);
JS
}

verify_public_release() {
  local root="${1:-.}"
  local release
  release="$(gh api "repos/$repo/releases/tags/$tag")"
  RELEASE_METADATA="$release" node - "$root" "${assets[@]}" <<'JS'
const assert = require('node:assert/strict');
const path = require('node:path');
const { sha256File } = require('./scripts/build-npm-package');
const release = JSON.parse(process.env.RELEASE_METADATA);
const [root, ...local] = process.argv.slice(2);
assert.equal(release.draft, false);
assert.equal(release.prerelease, false);
assert.deepEqual(release.assets.map(a => a.name).sort(), local.map(p => path.basename(p)).sort());
for (const file of local) {
  const asset = release.assets.find(a => a.name === path.basename(file));
  assert.equal(asset.digest, `sha256:${sha256File(path.join(root, file))}`, `Published digest mismatch: ${asset.name}`);
}
JS
}

case "${1:-}" in
  preflight) preflight ;;
  artifacts) preflight; check_artifacts ;;
  publish)
    preflight
    check_artifacts
    if existing_ref="$(git ls-remote --exit-code origin "refs/tags/$tag")"; then
      [[ "$(cut -f1 <<< "$existing_ref")" == "$GITHUB_SHA" ]] || die "existing tag points to a different SHA"
    else
      status=$?
      [[ "$status" == 2 ]] || die "tag lookup failed" # 2 means no matching refs
      existing="$(gh api --paginate "repos/$repo/releases" --jq '.[].tag_name')" || die "release lookup failed"
      if grep -Fxq "$tag" <<< "$existing"; then
        die "release exists without the expected tag"
      fi
      created="$(gh api --method POST "repos/$repo/git/refs" -f "ref=refs/tags/$tag" \
        -f "sha=$GITHUB_SHA" --jq '.object.sha')" || die "create-only tag request failed"
      [[ "$created" == "$GITHUB_SHA" ]] || die "tag creation reported a different SHA"
    fi
    [[ "$(git ls-remote --exit-code origin "refs/tags/$tag" | cut -f1)" == "$GITHUB_SHA" ]] || die "tag SHA mismatch"
    existing="$(gh api --paginate "repos/$repo/releases" --jq '.[].tag_name')" || die "release lookup failed"
    if grep -Fxq "$tag" <<< "$existing"; then
      prior="$(mktemp -d)"
      trap 'rm -rf "$prior"' EXIT
      mkdir "$prior/dist"
      gh release download "$tag" --repo "$repo" --dir "$prior/dist"
      check_artifacts "$prior"
      verify_public_release "$prior"
      echo "$tag already exists at this SHA with a verified public manifest and assets."
      exit 0
    fi
    gh release create "$tag" "${assets[@]}" --repo "$repo" --verify-tag --target "$GITHUB_SHA" \
      --title "TraeCN MCP $tag" --generate-notes --notes-start-tag v0.7.0
    [[ "$(git ls-remote --exit-code origin "refs/tags/$tag" | cut -f1)" == "$GITHUB_SHA" ]] || die "published tag SHA mismatch"
    verify_public_release
    ;;
  *) exit 2 ;;
esac
