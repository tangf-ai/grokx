# Packaging

1. Build engine: `./tools/build-engine.sh`
2. Bundle into Tauri resources: `./packaging/bundle_runtime.sh`
3. Build installer: `cd apps/desktop && pnpm tauri build`

## Debian package

On Debian or Ubuntu, install the Tauri system dependencies first:

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev patchelf
cargo install dotslash
```

Then build the package from the repository root:

```bash
./packaging/linux/deb.sh
```

If the bundled Grok Build runtime is missing, the script builds and stages it
before invoking Tauri.

The package is written to `target/release/bundle/deb/`. You can also run
`pnpm build:deb` from `apps/desktop`; both commands use the same packaging flow.

The macOS, Windows, and AppImage helpers remain stubs for signing,
notarization, and post-processing.
