# Packaging

1. Build engine: `./tools/build-engine.sh`
2. Bundle into Tauri resources: `./packaging/bundle_runtime.sh`
3. Build installer: `cd apps/desktop && pnpm tauri build`

On Windows, prefer NSIS:

```bash
cd apps/desktop && pnpm tauri build --bundles nsis
```

CI publishes the Windows installer via `.github/workflows/release-windows.yml`.

Platform helpers under `macos/`, `windows/`, `linux/` are stubs for signing/notarization.
