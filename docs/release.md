# Release notes (process)

1. Bump app version in `apps/desktop/src-tauri/tauri.conf.json` and workspace as needed.
2. Build/sign installer via Tauri + `packaging/*` helpers. On Linux, run
   `./packaging/linux/deb.sh` to produce `target/release/bundle/deb/*.deb`.
3. Tag and push `vX.Y.Z`. CI verifies that the tag matches the app version,
   creates the GitHub Release, and uploads the Debian package.

Grokx releases do not build or bundle the Grok CLI. Users must install `grok`
separately or configure its executable path in the application.
