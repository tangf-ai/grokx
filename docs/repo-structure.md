# Repository structure

Monorepo for the grokx desktop product with a **git subtree** thin fork of Grok Build.

## Top level

| Path | Role |
|------|------|
| `apps/desktop` | Tauri 2 shell + React UI |
| `crates/*` | Product Rust libraries |
| `engine/grok-build` | Upstream Grok Build (subtree) |
| `packaging/` | Build app packages, sign, notarize |
| `tools/` | Dev bootstrap, upstream sync, engine build |
| `docs/` | Architecture and policy |
| `tests/` | e2e + app↔engine compatibility matrix |

## Crates

| Crate | Responsibility |
|-------|----------------|
| `domain` | Pure types + `AppEvent` (no IO) |
| `app-config` | Paths, settings, runtime `version.json` |
| `agent-process` | Resolve + spawn custom/installed `grok` |
| `acp-bridge` | ACP JSON-RPC → `AppEvent` |
| `permissions` | Policy + approval broker |
| `session-store` | Session/project metadata |
| `app-core` | Orchestration façade for the UI shell |

## Dependency direction

```text
apps/desktop → app-core → {acp-bridge, agent-process, permissions, session-store, app-config, domain}
installed grok  --ACP stdio-->  agent-process
```

Hard rules:

1. Product crates **do not** depend on engine source crates.
2. Engine is a **separate process** (`grok agent stdio`).
3. Prefer product features in `apps/` + `crates/`; keep `engine/` patches minimal.

## Engine (subtree)

- Remote: `https://github.com/xai-org/grok-build.git`
- Prefix: `engine/grok-build`
- Pin metadata: `engine/VERSION`
- Sync helper: `tools/sync-upstream.sh`

## Runtime resolution order

1. User `custom_engine_path`
2. `PATH` lookup

The resolver retains support for manually provided bundled runtimes for
backward compatibility, but release packages do not include one.
