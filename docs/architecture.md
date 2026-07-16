# Architecture

```text
┌────────────────────────────────────────────┐
│  apps/desktop (Tauri + React)              │
│   commands / events                        │
└─────────────────┬──────────────────────────┘
                  │
                  ▼
┌────────────────────────────────────────────┐
│  crates/app-core                           │
│   turns, projects, orchestration           │
└───┬──────────┬──────────┬──────────┬───────┘
    │          │          │          │
    ▼          ▼          ▼          ▼
 acp-bridge  agent-process  permissions  session-store
    │          │
    │          │ spawn stdio
    │          ▼
    │     bundled grok (engine/grok-build build)
    │          │
    └──────────┘
         ACP JSON-RPC
```

## Design choices

1. **Process boundary** — UI process never links the engine as a library.
2. **Bundled by default** — installers ship a pinned runtime.
3. **Custom override** — power users can point at another `grok` binary.
4. **Isolated app data** — product state under the OS app data dir, not necessarily `~/.grok`.
