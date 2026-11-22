#!/usr/bin/env bash
# Native cloud CI only; installs from the verified staged archive, not a public candidate URL.
set -euo pipefail
[[ "$(node -p process.platform)" == darwin ]] || exit 1
temp="$(mktemp -d "${RUNNER_TEMP:?}/traecn-brew.XXXXXX")"
trap 'rm -rf "$temp"' EXIT
canonical="$temp/traecnclaw.rb"
npm run build:homebrew-formula -- --manifest dist/traecn-mcp-release.json --out "$canonical"
ruby -c "$canonical"
brew tap-new --no-git luckycat-ci/traecn-candidate
tap_path="$(brew --repository luckycat-ci/traecn-candidate)"
node scripts/stage-homebrew-candidate.js "$canonical" "$tap_path/Formula/traecnclaw.rb"
brew install --formula luckycat-ci/traecn-candidate/traecnclaw
brew test luckycat-ci/traecn-candidate/traecnclaw
