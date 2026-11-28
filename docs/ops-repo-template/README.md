# Ops repository template: Kladde with plugins

Copy this folder into your ops repository. It pins **which Kladde version runs with which plugin versions** and
builds the image from that; Kladde's own Dockerfile does the work, so no Dockerfile is needed here.
Full guide: [docs/PLUGINS.md](../PLUGINS.md) ([Deutsch](../PLUGINS.de.md)).

| File | Purpose |
| --- | --- |
| `kladde.version` | Tag of kladde-notes to build (e.g. `v2.28.0`) |
| `kladde.plugins.json` | Plugin packages with exact versions (registry), or `file:plugins/<tarball>.tgz` |
| `plugins/` | Tarballs of plugins (`npm pack` from the plugin repositories) |
| `scripts/build-image.sh` | Builds the image locally or on any CI: clone Kladde at the tag, add the list, `docker build` |
| `.github/workflows/image.yml` | The same on GitHub Actions, pushing to GitHub's container registry |

Replace `@team` with your npm scope and the example plugins with yours. Deployment stays as it is: it only pulls
this image instead of the plain one.
