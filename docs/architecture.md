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
    │     installed grok executable
    │          │
    └──────────┘
         ACP JSON-RPC
```

## Design choices

1. **Process boundary** — UI process never links the engine as a library.
2. **External runtime** — installers do not build or bundle the Grok CLI.
3. **Custom override** — users can point at a specific `grok` binary; otherwise Grokx searches `PATH`.
4. **Isolated app data** — product state under the OS app data dir, not necessarily `~/.grok`.
