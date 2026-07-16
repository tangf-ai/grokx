#!/usr/bin/env bash
# Copy staged engine artifacts into the Tauri resources directory.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-$ROOT/runtime-dist}"
DEST="$ROOT/apps/desktop/src-tauri/resources/runtime"

if [[ ! -d "$SRC" ]]; then
  echo "error: missing $SRC (run ./tools/build-engine.sh first)" >&2
  exit 1
fi

mkdir -p "$DEST"

if [[ -f "$SRC/grok" ]]; then
  cp "$SRC/grok" "$DEST/grok"
  chmod +x "$DEST/grok"
elif [[ -f "$SRC/grok.exe" ]]; then
  cp "$SRC/grok.exe" "$DEST/grok.exe"
else
  echo "error: no grok binary in $SRC" >&2
  exit 1
fi

if [[ -f "$SRC/version.json" ]]; then
  cp "$SRC/version.json" "$DEST/version.json"
else
  echo "warn: no version.json in $SRC" >&2
fi

echo ">> bundled runtime → $DEST"
ls -la "$DEST"
