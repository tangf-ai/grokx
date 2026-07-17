# ADR 0003: Monorepo layout

## Status

Accepted

## Context

Desktop app, Rust core, and engine integration sources live in one repository.

## Decision

Use one monorepo: `apps/`, `crates/`, `engine/`, `packaging/`, `tools/`, `docs/`.
Exclude engine from the primary Cargo workspace. Grokx release builds do not
compile or bundle the engine binary.

## Consequences

- Faster product crate iteration
- Grok CLI installation and updates are independent from Grokx releases
