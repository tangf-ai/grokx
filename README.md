# grokx

Desktop coding app powered by a **fully bundled**, thin-forked [Grok Build](https://github.com/xai-org/grok-build) engine.

- **App layer**: Tauri 2 + Rust core + Web UI
- **Engine**: Grok Build via `git subtree` under `engine/grok-build`
- **Integration**: ACP over `grok agent stdio` (process boundary, not in-process link)

## Repository layout

```text
apps/desktop          # Tauri desktop shell + UI
crates/               # Product Rust libraries (domain, ACP, process, permissions…)
engine/grok-build     # Thin fork of xai-org/grok-build (subtree)
packaging/            # Bundle / sign / notarize helpers
tools/                # Dev + upstream sync scripts
docs/                 # Architecture and contribution policy
```

See [docs/repo-structure.md](docs/repo-structure.md) and [docs/engine-policy.md](docs/engine-policy.md).

## Status

Scaffold stage. The monorepo, crate boundaries, and engine subtree pin are in place.
Desktop UI, ACP wiring, and release packaging come next.

## Prerequisites

- Rust stable (`rustup`)
- Node.js 20+ and pnpm (for the desktop UI)
- Platform build tools for Tauri (see Tauri docs)

## Quick start (after Rust is installed)

```bash
source "$HOME/.cargo/env"
export PATH="$HOME/.grok/bin:$PATH"   # or use bundled runtime after packaging

# Product crate tests
cargo test -p domain -p acp-bridge -p agent-process -p app-core \
  -p app-config -p permissions -p session-store

# Headless ACP smoke (connect → prompt stream)
cargo run --manifest-path tools/acp-smoke/Cargo.toml

# Stage / bundle a runtime binary into Tauri resources
# Prefer building from subtree when time allows:
#   ./tools/build-engine.sh && ./packaging/bundle_runtime.sh
# Or copy an existing grok into runtime-dist/ then:
./packaging/bundle_runtime.sh

# Desktop app
cd apps/desktop && pnpm install && pnpm tauri dev
```

### Desktop flow

1. Enter a **project path** and click **Set project** (or paste path and Connect).
2. Optionally uncheck **Auto-approve tools** so permission requests park until Allow/Deny.
3. **Connect agent** → send a prompt; sessions appear in the left list for reconnect.

## Engine strategy

| Item | Choice |
|------|--------|
| Bundle | Full install ships a pinned Grok Build runtime |
| Source | `engine/grok-build` via **git subtree** (option A) |
| Coupling | App talks to engine over ACP stdio |
| Overrides | Settings may point at a custom `grok` binary for debug |
| Upstream | Periodic merge from `https://github.com/xai-org/grok-build` |

```bash
# Sync a newer upstream revision into the subtree
./tools/sync-upstream.sh
```

## License

- Product code: Apache-2.0 (see `LICENSE`)
- Engine: Apache-2.0 from upstream Grok Build (see `engine/grok-build/LICENSE` and `NOTICE`)
