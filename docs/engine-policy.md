# Engine policy (thin fork)

## Goals

- Keep Grokx releases independent from Grok CLI builds.
- Track upstream with periodic merges.
- Avoid a hard permanent fork that cannot reabsorb upstream.

## Allowed engine changes

Change `engine/grok-build/**` only when:

1. Compatibility fix required for Grokx integration
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

## Distribution boundary

Grokx release jobs build only the desktop application. They do not compile or
bundle a Grok executable. Users install `grok` separately or configure its
executable path in Settings.

The runtime manifest and bundled-runtime resolver remain available for
backward compatibility and local development only.

## Sync cadence

- Absorb upstream on a release cadence (not every upstream commit).
- Run product crate tests + smoke ACP after merge.
- Prefer merging upstream **tags** or known-good `main` SHAs.
