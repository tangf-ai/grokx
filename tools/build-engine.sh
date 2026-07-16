#!/usr/bin/env bash
# Build the vendored Grok Build engine and stage artifacts under runtime-dist/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENGINE_DIR="$ROOT/engine/grok-build"
OUT_DIR="$ROOT/runtime-dist"

if [[ ! -d "$ENGINE_DIR" ]]; then
  echo "error: missing $ENGINE_DIR (run git subtree add first)" >&2
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "error: cargo not found. Install Rust via https://rustup.rs" >&2
  exit 1
fi

echo ">> building engine in $ENGINE_DIR"
cd "$ENGINE_DIR"

# Prefer a binary target named grok if present; fall back to --release workspace default.
if cargo metadata --no-deps --format-version 1 2>/dev/null | grep -q '"name":"grok"'; then
  cargo build --release -p grok
else
  cargo build --release
fi

mkdir -p "$OUT_DIR"
BIN=""
for candidate in \
  "$ENGINE_DIR/target/release/grok" \
  "$ENGINE_DIR/target/release/grok.exe" \
  "$ENGINE_DIR/target/release/grok-build" \
  "$ENGINE_DIR/target/release/grok-build.exe"
do
  if [[ -f "$candidate" ]]; then
    BIN="$candidate"
    break
  fi
done

if [[ -z "$BIN" ]]; then
  echo "error: could not locate built engine binary under target/release" >&2
  ls -la "$ENGINE_DIR/target/release" || true
  exit 1
fi

BASE="$(basename "$BIN")"
cp "$BIN" "$OUT_DIR/$BASE"
if [[ "$BASE" != "grok" && "$BASE" != "grok.exe" ]]; then
  # Normalize name expected by the desktop resolver.
  if [[ "$BASE" == *.exe ]]; then
    cp "$BIN" "$OUT_DIR/grok.exe"
  else
    cp "$BIN" "$OUT_DIR/grok"
  fi
fi

COMMIT="$(git -C "$ROOT" log -1 --format=%h -- engine/grok-build 2>/dev/null || echo unknown)"
cat >"$OUT_DIR/version.json" <<EOF
{
  "app_version": "0.1.0",
  "engine_name": "grok-build",
  "engine_version": "subtree",
  "engine_commit": "$COMMIT",
  "engine_channel": "bundled"
}
EOF

echo ">> staged:"
ls -la "$OUT_DIR"
echo "Next: ./packaging/bundle_runtime.sh"
