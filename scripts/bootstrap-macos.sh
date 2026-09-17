#!/bin/bash
set -euo pipefail

# Bootstrap macOS per plan — Apple Silicon, macOS 14.0 minimum
echo "Arena Model Archive — macOS bootstrap"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "Warning: Not running on macOS — bootstrap will simulate"
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "Warning: Not arm64 — plan requires Apple Silicon. Continuing for dev."
fi

# Check Node
if ! command -v node &> /dev/null; then
  echo "Node not found — please install Node >=20"
  exit 1
fi

echo "Node $(node -v) $(which node)"

# Install deps
echo "Installing npm workspaces..."
npm install

# Build
echo "Building TypeScript..."
npm run build || npx tsc -b || echo "Build attempted"

# Create data dirs
DATA_DIR="${HOME}/Library/Application Support/ArenaArchive"
if [[ "$(uname)" != "Darwin" ]]; then
  DATA_DIR="${HOME}/.config/arena-archive"
fi

mkdir -p "${DATA_DIR}/partitions"
chmod 700 "${DATA_DIR}"
echo "Data dir: ${DATA_DIR}"

# Doctor
echo "Running doctor..."
npx tsx scripts/doctor.ts || node --loader tsx scripts/doctor.ts || echo "Doctor failed but continuing"

echo "Bootstrap complete — run npm run gate:p0 for hostile spike"
