#!/usr/bin/env bash
# bootstrap-macos.sh — one-shot dev setup on Apple Silicon macOS 14+.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "bootstrap-macos.sh is for macOS (this host: $(uname -s))." >&2
  exit 1
fi
if [[ "$(uname -m)" != "arm64" ]]; then
  echo "Apple Silicon (arm64) required; this host: $(uname -m)." >&2
  exit 1
fi

command -v node >/dev/null || { echo "node >= 20 required (https://nodejs.org)"; exit 1; }

cd "$(dirname "$0")/.."
npm install
npx tsx scripts/doctor.ts
npm run build
npx vitest run
npx tsx scripts/gate-p0.ts

echo "bootstrap complete. Next: set ARENA_ACCOUNTS=<uuid,...> and run the Electron shell."
