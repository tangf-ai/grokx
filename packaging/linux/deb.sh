#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DESKTOP_DIR="$ROOT/apps/desktop"
BUNDLE_DIR="$ROOT/target/release/bundle/deb"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "error: Debian packages must be built on Linux" >&2
  exit 1
fi

for command in cargo pnpm; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "error: $command is required to build the Debian package" >&2
    exit 1
  fi
done

cd "$DESKTOP_DIR"
pnpm install --frozen-lockfile
pnpm tauri build --bundles deb

echo ">> Debian package:"
find "$BUNDLE_DIR" -maxdepth 1 -type f -name '*.deb' -print
