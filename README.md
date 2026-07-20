# Grokx

<p align="center">
  <img src="docs/images/grokx-icon.png" alt="Grokx icon" width="128" height="128" />
</p>

<p align="center">
  <strong>Open-source desktop AI coding app</strong><br />
  Codex-style light UI · bundled Grok Build engine · Tauri + React
</p>

<p align="center">
  <a href="https://github.com/tangf-ai/grokx"><img src="https://img.shields.io/badge/github-tangf--ai%2Fgrokx-111?style=flat-square" alt="GitHub" /></a>
  <img src="https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square" alt="License" />
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=flat-square" alt="Platform" />
</p>

---

**Grokx** wraps a fully bundled, thin-forked [Grok Build](https://github.com/xai-org/grok-build) engine behind a clean desktop shell.

| Layer | Stack |
|-------|--------|
| **App** | Tauri 2 + Rust core + React UI |
| **Engine** | Grok Build via `git subtree` (`engine/grok-build`) |
| **Boundary** | ACP over `grok agent stdio` (process isolation) |

## Platforms

Grokx is a **cross-platform** desktop app (macOS, Windows, Linux) built with Tauri.

| Platform | Prebuilt installer | How to run |
|----------|--------------------|------------|
| **macOS** (Apple Silicon) | Yes — DMG on [Releases](https://github.com/tangf-ai/grokx/releases) | Download → install |
| **Windows** | Not published yet | Clone repo → build yourself |
| **Linux** | Not published yet | Clone repo → build yourself |

Official GitHub Releases currently ship **macOS Apple Silicon** packages only.  
**Windows and Linux users: download the source and compile locally** (see [Build from source](#build-from-source)). Contributors who produce installers for other targets are welcome to share them.

## Screenshots

### Workspace

Projects, tasks (rename / delete), empty chat ready for a new prompt.

![Grokx workspace](docs/images/screenshot-workspace.jpg)

### Chat

User prompt, collapsible thinking trace with duration, final assistant reply.

![Grokx chat](docs/images/screenshot-chat.jpg)

<p align="center">
  <img src="docs/images/grokx-icon-256.png" alt="Grokx" width="64" height="64" />
</p>

## Features

- Light Codex-style UI: projects, tasks, chat, sticky user prompts
- **Multi-session agents** — switch Tasks while work continues in the background
- **New task** without picking a folder (default sandbox `~/.grokx/workspace`)
- Projects nesting vs temporary Tasks; per-task workspace under `~/.grokx/tasks/<id>`
- Attachments, **clipboard paste** (text + images), model picker, reasoning effort
- **Edit & re-send** past user prompts; collapsible thinking / tool traces
- Permission modes: Needs approval · Auto · Full trust (synced to `~/.grok/config.toml`)
- Settings for API base URL, key, model, and engine path
- Task rename / delete; chat + task list persistence across restarts
- Bundled runtime resolution (prefer `resources/runtime/grok` over PATH)

## Repository layout

```text
apps/desktop          # Tauri desktop shell + UI
crates/               # Product Rust libraries (domain, ACP, process, permissions…)
engine/grok-build     # Thin fork of xai-org/grok-build (subtree)
packaging/            # Bundle / sign / notarize helpers
tools/                # Dev + upstream sync scripts
docs/                 # Architecture, images, contribution policy
```

See [docs/repo-structure.md](docs/repo-structure.md) and [docs/engine-policy.md](docs/engine-policy.md).

## Prerequisites

- Rust stable (`rustup`)
- Node.js 20+ and pnpm (for the desktop UI)
- Platform build tools for Tauri (see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/))
  - **macOS**: Xcode Command Line Tools
  - **Windows**: Visual Studio C++ build tools, WebView2
  - **Linux**: `webkit2gtk`, `libgtk`, and related packages (see Tauri docs)
- Optional: a working `grok` CLI for PATH fallback during development

## Install (prebuilt)

1. Open [GitHub Releases](https://github.com/tangf-ai/grokx/releases)
2. Download the asset for your platform (currently `Grokx_*_aarch64.dmg` for **macOS Apple Silicon**)
3. Install and launch; if macOS Gatekeeper blocks the app, see [FAQ](#macos-app-is-damaged--gatekeeper-blocks-grokx-after-download)

For **Windows / Linux** (or Intel Mac), use [Build from source](#build-from-source) below.

## Quick start (dev)

```bash
git clone git@github.com:tangf-ai/grokx.git
cd grokx

# Product crate tests
cargo test -p domain -p acp-bridge -p agent-process -p app-core \
  -p app-config -p permissions -p session-store

# Desktop app (hot reload)
cd apps/desktop
pnpm install
pnpm tauri dev
```

### Desktop flow

1. Open **Settings** (gear) and set model **Base URL** / **API Key** (optional if `~/.grok` already works).
2. Click **New task** (or **Tasks +**) to create a temporary task and start chatting.
3. Optional: **Projects +** to open a real code folder; new tasks under that project use its path via `./project`.
4. Paste text/images into the composer, pick model / effort, approve tools when needed.
5. Rename (✎) or delete (🗑) tasks from the sidebar; reopen the app to resume history.

## Build from source

Use this on **any supported platform**, or when you need a release binary (Windows / Linux / Intel macOS).

```bash
git clone git@github.com:tangf-ai/grokx.git
cd grokx

# 1) Build + bundle the engine runtime into Tauri resources
./tools/build-engine.sh && ./packaging/bundle_runtime.sh
# Or drop a platform-native `grok` binary into runtime-dist/, then:
# ./packaging/bundle_runtime.sh

# 2) Install UI deps and produce a release installer
cd apps/desktop
pnpm install
pnpm tauri build
```

Artifacts land under `target/release/bundle/` (e.g. `.dmg` / `.app` on macOS, `.msi` / `.exe` on Windows, `.deb` / AppImage on Linux depending on Tauri config).

The packaged engine binary is **not** committed; local builds write to `apps/desktop/src-tauri/resources/runtime/grok` (gitignored).

See also [packaging/README.md](packaging/README.md).

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

## FAQ

### Do you support Windows and Linux?

**Yes.** The app stack (Tauri + React + Rust) is multi-platform. Prebuilt installers on GitHub Releases are currently **macOS-only**; on Windows and Linux, [build from source](#build-from-source).

### macOS: “app is damaged” / Gatekeeper blocks Grokx after download

The macOS build is not Developer ID signed or notarized yet, so Gatekeeper may block the first launch (or report the app as damaged / untrusted).

**Option A — clear quarantine (recommended):**

```bash
xattr -cr /Applications/Grokx.app
```

Then open Grokx again (from Applications, or Spotlight).

**Option B — open once via Finder:**

1. Right-click (or Control-click) **Grokx** in Applications  
2. Choose **Open** → confirm **Open** again  

If you installed from a DMG but did not copy the app to Applications, run the same command on the mounted path, for example:

```bash
xattr -cr /Volumes/Grokx/Grokx.app
```

## Community

Questions, feedback, and showcases are welcome on **[LINUX DO](https://linux.do/)** — a community we like and recommend for discussion around Grokx and related tooling.

- Forum: [https://linux.do/](https://linux.do/)
- GitHub Issues remain the place for bugs and pull requests.

## License

- Product code: Apache-2.0 (see `LICENSE`)
- Engine: Apache-2.0 from upstream Grok Build (see `engine/grok-build/LICENSE` and `NOTICE`)

## Security notes

- Do not commit API keys. App settings live outside the repo (e.g. Application Support).
- Optional sync writes model config into `~/.grok/config.toml` on your machine only.
- Task data lives under `~/.grokx/tasks/` on your machine.
