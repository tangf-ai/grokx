# Engine (Grok Build subtree)

This directory vendors [xai-org/grok-build](https://github.com/xai-org/grok-build) as a **git subtree** under `grok-build/`.

## Files

| Path | Purpose |
|------|---------|
| `grok-build/` | Upstream source tree |
| `VERSION` | Pin metadata for the desktop app |
| `UPSTREAM.md` | How to sync from upstream |

## Policy

See [../docs/engine-policy.md](../docs/engine-policy.md). Prefer fixing product issues in `crates/` and `apps/`.
