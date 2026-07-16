# ADR 0002: Thin fork via git subtree

## Status

Accepted

## Context

We need source control over the engine for emergency patches and reproducible builds, while still merging upstream.

## Decision

Vendor `xai-org/grok-build` under `engine/grok-build` using **git subtree** (option A). Keep product logic out of the engine.

## Consequences

- Single clone builds everything
- History includes subtree merges
- Discipline required to keep engine diffs small
