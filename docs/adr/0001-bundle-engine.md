# ADR 0001: Fully bundle Grok Build

## Status

Accepted

## Context

A Codex-like desktop app must work after install without requiring users to install a separate CLI.

## Decision

Ship a pinned Grok Build binary inside the app bundle. Allow optional custom engine path for debugging.

## Consequences

- Larger installers
- Need signing of nested binaries
- Clear version matrix (app ↔ engine)
