# Packaging

1. Build engine: `./tools/build-engine.sh`
2. Bundle into Tauri resources: `./packaging/bundle_runtime.sh`
3. Build installer: `cd apps/desktop && pnpm tauri build`

Platform helpers under `macos/`, `windows/`, `linux/` are stubs for signing/notarization.
