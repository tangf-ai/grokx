#!/usr/bin/env bash
# Refresh engine/VERSION from the latest commit touching the subtree.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="engine/grok-build"
COMMIT="$(git -C "$ROOT" log -1 --format=%H -- "$PREFIX" || echo unknown)"
SHORT="$(git -C "$ROOT" log -1 --format=%h -- "$PREFIX" || echo unknown)"
cat >"$ROOT/engine/VERSION" <<EOF
engine_name=grok-build
engine_version=subtree
engine_commit=$COMMIT
engine_commit_short=$SHORT
upstream=https://github.com/xai-org/grok-build.git
prefix=$PREFIX
pinned_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
echo "pinned $SHORT → engine/VERSION"
