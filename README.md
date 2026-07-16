# Grokx

**Grokx** is an open-source desktop AI coding app. It wraps a fully bundled, thin-forked [Grok Build](https://github.com/xai-org/grok-build) engine behind a Codex-style light UI (Tauri + React).

- **App layer**: Tauri 2 + Rust core + Web UI
- **Engine**: Grok Build via `git subtree` under `engine/grok-build`
- **Integration**: ACP over `grok agent stdio` (process boundary, not in-process link)

## Features

- Light workspace UI with sessions, chat, and sticky user prompts
- Attachments, model picker, and reasoning effort controls
- Permission approvals (park until Allow / Deny)
- Settings for API base URL, key, model, and engine path
- Bundled runtime resolution (prefer `resources/runtime/grok` over PATH)

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

## Prerequisites

- Rust stable (`rustup`)
- Node.js 20+ and pnpm (for the desktop UI)
- Platform build tools for Tauri (see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/))
- Optional: a working `grok` CLI for PATH fallback during development

## Quick start

```bash
git clone git@github.com:tangf-ai/grokx.git
cd grokx

# Product crate tests
cargo test -p domain -p acp-bridge -p agent-process -p app-core \
  -p app-config -p permissions -p session-store

# Desktop app
cd apps/desktop
pnpm install
pnpm tauri dev
```

### Desktop flow

1. Open **Settings** and configure model **Base URL** / **API Key** (optional if `~/.grok` already works).
2. Set a **project path** and **Connect**.
3. Chat, attach files, pick model / effort; use the Sessions **+** for a new session.

### Bundle engine runtime (optional)

```bash
# From repo root — build from subtree when possible:
./tools/build-engine.sh && ./packaging/bundle_runtime.sh

# Or place a grok binary into runtime-dist/ then:
./packaging/bundle_runtime.sh
```

The packaged binary is **not** committed; local builds write to `apps/desktop/src-tauri/resources/runtime/grok` (gitignored).

## Engine strategy

| Item | Choice |
|------|--------|
| Bundle | Installers can ship a pinned Grok Build runtime |
| Source | `engine/grok-build` via **git subtree** |
| Coupling | App talks to engine over ACP stdio |
| Overrides | Settings may point at a custom `grok` binary |
| Upstream | Periodic merge from `https://github.com/xai-org/grok-build` |

```bash
./tools/sync-upstream.sh
```

## License

- Product code: Apache-2.0 (see `LICENSE`)
- Engine: Apache-2.0 from upstream Grok Build (see `engine/grok-build/LICENSE` and `NOTICE`)

## Security notes

- Do not commit API keys. App settings live outside the repo (e.g. Application Support).
- Optional sync writes model config into `~/.grok/config.toml` on your machine only.
