#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DESKTOP_DIR="$ROOT/apps/desktop"
BUNDLE_DIR="$ROOT/target/release/bundle/deb"
RUNTIME_BIN="$DESKTOP_DIR/src-tauri/resources/runtime/grok"

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

if [[ ! -x "$RUNTIME_BIN" ]]; then
  if ! command -v dotslash >/dev/null 2>&1 && ! command -v protoc >/dev/null 2>&1; then
    echo "error: dotslash or protoc is required to build the bundled runtime" >&2
    echo "install dotslash with: cargo install dotslash" >&2
    exit 1
  fi

  echo ">> bundled runtime missing; building Grok Build"
  "$ROOT/tools/build-engine.sh"
  "$ROOT/packaging/bundle_runtime.sh"
fi

cd "$DESKTOP_DIR"
pnpm install --frozen-lockfile
pnpm tauri build --bundles deb

echo ">> Debian package:"
find "$BUNDLE_DIR" -maxdepth 1 -type f -name '*.deb' -print
