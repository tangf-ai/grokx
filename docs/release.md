# Release notes (process)

1. Pin engine: merge upstream (if needed), record SHA in `engine/VERSION`.
2. `./tools/build-engine.sh` → runtime artifacts.
3. `./packaging/bundle_runtime.sh` → copy into `apps/desktop/src-tauri/resources/runtime/`.
4. Bump app version in `apps/desktop/src-tauri/tauri.conf.json` and workspace as needed.
5. Build/sign installer via Tauri + `packaging/*` helpers. On Linux, run
   `./packaging/linux/deb.sh` to produce `target/release/bundle/deb/*.deb`.
6. Tag `app-vX.Y.Z` and record engine commit in release notes.
