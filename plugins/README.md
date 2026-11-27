# Local plugin packages

Place for plugin packages a build refers to with `file:` in `kladde.plugins.json`, e.g. `npm pack` tarballs:

```json
{ "plugins": { "@team/kladde-plugin-time": "file:plugins/team-kladde-plugin-time-1.4.0.tgz" } }
```

The Docker build copies this folder; everything in it except this README is ignored by git.
See [docs/PLUGINS.md](../docs/PLUGINS.md).
