#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo ">> checking toolchains"
command -v cargo >/dev/null || { echo "install Rust (rustup)"; exit 1; }
command -v pnpm >/dev/null || { echo "install pnpm"; exit 1; }
command -v node >/dev/null || { echo "install node"; exit 1; }

echo ">> cargo fetch/check product crates"
cargo check -p domain -p app-config -p agent-process -p acp-bridge -p permissions -p session-store -p app-core

echo ">> desktop frontend deps"
(cd apps/desktop && pnpm install)

echo "bootstrap ok"
