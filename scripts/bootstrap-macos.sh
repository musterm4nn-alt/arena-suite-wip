#!/bin/bash
set -euo pipefail

# bootstrap-macos.sh — per §17
# Sets up macOS 14.0+ dev environment for Arena Archive (Electron arm64)

echo "=== Arena Archive Bootstrap (macOS) ==="

# Check macOS version
if [[ "$(uname)" != "Darwin" ]]; then
  echo "Warning: not running on macOS, but continuing for CI"
else
  OS_VER=$(sw_vers -productVersion)
  echo "macOS version: $OS_VER (required >=14.0)"
fi

# Check arch
ARCH=$(uname -m)
echo "Arch: $ARCH (release artifact arm64 only, x64 allowed for CI)"

# Node >=20
NODE_VER=$(node --version 2>/dev/null || echo "not found")
echo "Node: $NODE_VER (required >=20)"
if ! node --version | grep -E "v2[0-9]\."; then
  echo "Please install Node >=20 via https://nodejs.org or nvm"
  exit 1
fi

# npm
echo "npm: $(npm --version)"

# Install deps
echo "Installing npm workspaces..."
npm install

# Build all packages
echo "Building packages..."
npm run build || (echo "Build failed, trying tsc -b"; npx tsc -b)

# Doctor
echo "Running doctor..."
npx tsx scripts/doctor.ts

# Gates P0/P1
echo "Running P0 gate (mock)..."
npx tsx scripts/gate-p0.ts

echo "Running P1 gate (mock)..."
npx tsx scripts/gate-p1.ts

echo ""
echo "Bootstrap complete."
echo "For Electron dev (macOS):"
echo "  npm run dev --workspace=apps/desktop"
echo ""
echo "MCP bridge:"
echo "  npm run dev --workspace=apps/mcp-bridge -- --socket-server"
echo ""
echo "Gate artifacts:"
echo "  cat artifacts/gates/p0.json"
echo "  cat artifacts/gates/p1.json"
