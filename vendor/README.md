# Vendored packages

Patched copies of dependencies that have a known vulnerability but no fixed release yet. They replace the
registry package through `overrides` in the root `package.json`. Drop a package here as soon as upstream
publishes a fix.

| Package | Upstream | Why |
|---|---|---|
| `deepmerge` | 4.3.1 (MIT) | [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4): an own `__proto__` key replaced the prototype of the merged object. Only used at build time (`vite-plugin-pwa` → `workbox-build` → `@rollup/plugin-node-resolve`). |
