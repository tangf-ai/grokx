# Release notes (process)

1. Pin engine: merge upstream (if needed), record SHA in `engine/VERSION`.
2. `./tools/build-engine.sh` → runtime artifacts.
3. `./packaging/bundle_runtime.sh` → copy into `apps/desktop/src-tauri/resources/runtime/`.
4. Bump app version in `apps/desktop/src-tauri/tauri.conf.json` and workspace as needed.
5. Build/sign installer via Tauri + `packaging/*` helpers.
6. Tag `app-vX.Y.Z` and record engine commit in release notes.

## Platforms

| Platform | How it is published |
|----------|---------------------|
| macOS Apple Silicon | Local `pnpm tauri build` → upload `Grokx_*_aarch64.dmg` to the GitHub Release |
| Windows x64 | GitHub Actions (`.github/workflows/release-windows.yml`) → NSIS `Grokx_*_x64-setup.exe` |

### Windows

The Windows job runs on `windows-latest`, builds the bundled `grok.exe` engine, then produces an NSIS installer (`currentUser` install, WebView2 bootstrapper embedded).

Trigger it by:

- pushing a tag (`app-vX.Y.Z` or `vX.Y.Z`), or
- **Actions → release-windows → Run workflow**, optionally passing an existing tag such as `app-v0.2.7` so the `.exe` is attached to that release.

The installer is unsigned (no Authenticode cert yet). Windows SmartScreen may warn on first launch; choose **More info → Run anyway**.

Optional local Windows build (Git Bash / MSYS2):

```bash
./tools/build-engine.sh && ./packaging/bundle_runtime.sh
cd apps/desktop
pnpm install
pnpm tauri build --bundles nsis
```
