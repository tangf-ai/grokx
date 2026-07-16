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

# Upstream ships the CLI as package `xai-grok-pager-bin` / binary `xai-grok-pager`.
# Official installers rename the artifact to `grok`; we do the same for bundling.
PKG="${ENGINE_PACKAGE:-xai-grok-pager-bin}"
BIN_NAME="${ENGINE_BIN_NAME:-xai-grok-pager}"

cargo build --release -p "$PKG"

mkdir -p "$OUT_DIR"
BIN=""
for candidate in \
  "$ENGINE_DIR/target/release/$BIN_NAME" \
  "$ENGINE_DIR/target/release/${BIN_NAME}.exe" \
  "$ENGINE_DIR/target/release/grok" \
  "$ENGINE_DIR/target/release/grok.exe"
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

# Normalize to the name expected by agent-process / desktop resolver.
if [[ "$BIN" == *.exe ]]; then
  cp "$BIN" "$OUT_DIR/grok.exe"
else
  cp "$BIN" "$OUT_DIR/grok"
  chmod +x "$OUT_DIR/grok"
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
