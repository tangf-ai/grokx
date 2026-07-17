# Packaging

Grokx installers contain the desktop application only. They do not build or
bundle the Grok CLI. Install `grok` separately and ensure it is available on
`PATH`, or select its executable in Grokx settings.

## Debian package

On Debian or Ubuntu, install the Tauri system dependencies first:

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev patchelf
```

Then build the package from the repository root:

```bash
./packaging/linux/deb.sh
```

The package is written to `target/release/bundle/deb/`. You can also run
`pnpm build:deb` from `apps/desktop`; both commands use the same packaging flow.

The macOS, Windows, and AppImage helpers remain stubs for signing,
notarization, and post-processing.
