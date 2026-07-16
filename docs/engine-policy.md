# Engine policy (thin fork)

## Goals

- Ship a **fully bundled** Grok Build runtime with every app release.
- Track upstream with periodic merges.
- Avoid a hard permanent fork that cannot reabsorb upstream.

## Allowed engine changes

Change `engine/grok-build/**` only when:

1. Build/packaging fix required for bundling
2. Critical bug with no acceptable app-layer workaround
3. ACP gap that blocks a desktop MVP feature
4. Crash/diagnostics hooks needed for support

Every engine patch must document:

- Why app-layer was insufficient
- Upstream-ability (yes / later / no)
- Merge-conflict risk

## Prefer app-layer

| Need | Put it here |
|------|-------------|
| UI / UX | `apps/desktop` |
| Approvals UX + policy | `crates/permissions` + UI |
| Session index | `crates/session-store` |
| Extra tools | MCP / skills / hooks (engine config) |
| Branding | App only |

## Release pin

Each app release records:

- `app_version`
- `engine_version`
- `engine_commit`
- channel = `bundled`

See `packaging/version_manifest.json` and `resources/runtime/version.json`.

## Sync cadence

- Absorb upstream on a release cadence (not every upstream commit).
- Run product crate tests + engine build + smoke ACP after merge.
- Prefer merging upstream **tags** or known-good `main` SHAs.
