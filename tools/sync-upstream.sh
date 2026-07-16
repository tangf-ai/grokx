#!/usr/bin/env bash
# Merge latest upstream Grok Build into engine/grok-build (git subtree).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PREFIX="engine/grok-build"
REMOTE_URL="${GROK_UPSTREAM_URL:-https://github.com/xai-org/grok-build.git}"
REF="${GROK_UPSTREAM_REF:-main}"

if [[ ! -d "$PREFIX/.git" && ! -f "$PREFIX/Cargo.toml" && ! -f "$PREFIX/README.md" ]]; then
  echo "error: $PREFIX does not look like a vendored tree. Run initial subtree add first." >&2
  exit 1
fi

echo ">> subtree pull $REMOTE_URL $REF → $PREFIX"
git subtree pull --prefix="$PREFIX" "$REMOTE_URL" "$REF" --squash

COMMIT="$(git -C "$ROOT" rev-parse HEAD:"$PREFIX" 2>/dev/null || git log -1 --format=%H -- "$PREFIX")"
# Best-effort: record the squash merge tip for the prefix path.
TREE_COMMIT="$(git log -1 --format=%H -- "$PREFIX" || true)"

VERSION_FILE="$ROOT/engine/VERSION"
{
  echo "engine_name=grok-build"
  echo "engine_version=subtree"
  echo "engine_commit=${TREE_COMMIT:-unknown}"
  echo "upstream=$REMOTE_URL"
  echo "prefix=$PREFIX"
  echo "synced_ref=$REF"
  echo "synced_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"$VERSION_FILE"

echo ">> updated $VERSION_FILE"
echo "Next: ./tools/build-engine.sh && ./packaging/bundle_runtime.sh"
