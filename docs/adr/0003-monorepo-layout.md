# ADR 0003: Monorepo layout

## Status

Accepted

## Context

Desktop app, Rust core, and engine pin must version together for releases.

## Decision

Use one monorepo: `apps/`, `crates/`, `engine/`, `packaging/`, `tools/`, `docs/`.
Exclude engine from the primary Cargo workspace; build it independently and bundle the binary.

## Consequences

- Faster product crate iteration
- Explicit packaging step to copy runtime into Tauri resources
