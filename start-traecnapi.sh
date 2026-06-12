#!/bin/bash
# Linux launcher for TRAECNclaw.
# Mirrors start-traecnapi.command for macOS.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

if command -v npm >/dev/null 2>&1; then
  exec npm run quickstart
fi

if command -v node >/dev/null 2>&1; then
  exec node scripts/quickstart.js
fi

echo "Error: neither 'npm' nor 'node' is installed or on PATH." >&2
echo "Install Node.js >= 22 (https://nodejs.org) and retry." >&2
exit 1