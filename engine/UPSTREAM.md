# Upstream sync (git subtree)

Remote: `https://github.com/xai-org/grok-build.git`  
Prefix: `engine/grok-build`  
Default branch: `main`  
License: Apache-2.0

## First import

Performed once during scaffold:

```bash
git subtree add --prefix=engine/grok-build \
  https://github.com/xai-org/grok-build.git main --squash
```

## Later updates

```bash
./tools/sync-upstream.sh
# or explicitly:
git subtree pull --prefix=engine/grok-build \
  https://github.com/xai-org/grok-build.git main --squash
```

After sync:

1. Update `engine/VERSION` with the new commit metadata.
2. Build with `./tools/build-engine.sh`.
3. Run product tests / smoke ACP.
4. Bundle via `./packaging/bundle_runtime.sh`.

## Contributing patches upstream

Keep commits small and describe them so they can be proposed upstream when appropriate.
