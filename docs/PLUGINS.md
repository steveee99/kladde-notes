# Plugins

[Deutsch](PLUGINS.de.md)

Plugins bring your own apps into Kladde: their own navigation entries, pages, commands, settings, blocks in notes, tools for AI assistants, notifications, database tables and background jobs, while Kladde provides sign-in, design, the note format and sync. Plugins are built **into the image at build time**, never loaded at runtime. The build checks that the Kladde version and the plugin versions fit together and stops before anything is deployed when they do not.

- [How it works](#how-it-works)
- [Writing a plugin](#writing-a-plugin)
- [Blocks, MCP tools and notifications](#blocks-mcp-tools-and-notifications)
- [Own tables and migrations](#own-tables-and-migrations)
- [Version matrix: what the build checks](#version-matrix-what-the-build-checks)
- [Developing locally](#developing-locally)
- [Ops repository: building the image with plugins](#ops-repository-building-the-image-with-plugins)
- [Updates](#updates)
- [Rules for Kladde itself](#rules-for-kladde-itself)
- [Not in the plugin API yet](#not-in-the-plugin-api-yet)

## How it works

```
 kladde.plugins.json ──► npm run plugins ──► npm run build ──► Docker image
   (pinned packages)      │ installs               │
                          │ checks the matrix      │ server: loads packages/server/plugins/<id>.js
                          │ bundles server parts   │ client: Vite bundles <package>/client
                          └ writes the lists       └ Tailwind sees the plugins' classes
```

- **The boundary:** a plugin imports only `@kladde/plugin-api` (and `/server`, `/client`), never Kladde's own packages. Kladde may change anything else in any release; `@kladde/plugin-api` changes only with its own SemVer version (`PLUGIN_API_VERSION`, independent of the app version). An ESLint rule enforces this in `examples/`; use it in your plugin repositories too (below).
- **Server part:** runs inside the Kladde process with a context: the SQLite database for own tables, encryption with Kladde's key, notes through the normal sync, users, feature switches and environment variables. Its routes live under `/api/p/<id>/…`, for signed-in users who switched the plugin on.
- **Client part:** React components in Kladde's shell, with the same React and the Werkbank design. Pages live under `/p/<id>/…`; navigation entries, command palette entries (Ctrl/⌘+K) and a card under *Settings → Features* come from the plugin's definition.
- **Activation:** every user switches plugins on under *Settings → Features*, like the built-in features (stored as `features.plugins.<id>`). `kladde.defaultEnabled: true` makes a plugin on for everyone who has not switched it off.
- **Without a plugin list** Kladde builds exactly as before; the generated lists are empty.

## Writing a plugin

Start from the example plugin [`examples/kladde-plugin-logbook`](../examples/kladde-plugin-logbook). It shows everything once: own tables with migrations, encrypted rows, routes, a note per entry, note events, a job, the account export, a page with a navigation entry, a command and a settings tab.

### Package layout

```
kladde-plugin-time/
├─ package.json
├─ tsconfig.json          (module NodeNext, jsx react-jsx, outDir dist)
├─ src/
│  ├─ server.ts           export default defineServerPlugin({ … })
│  ├─ client.tsx          export default defineClientPlugin({ … })
│  └─ …                   pages, components, icon
└─ dist/                  build output (part of the package)
```

```json
{
  "name": "@team/kladde-plugin-time",
  "version": "1.4.0",
  "type": "module",
  "kladde": {
    "id": "time",
    "app": ">=2.28.0 <4",
    "defaultEnabled": false
  },
  "exports": {
    "./server": { "types": "./dist/server.d.ts", "import": "./dist/server.js" },
    "./client": { "types": "./dist/client.d.ts", "import": "./dist/client.js" }
  },
  "files": ["dist"],
  "scripts": { "build": "tsc", "prepack": "tsc" },
  "peerDependencies": {
    "@kladde/plugin-api": "^1.1.0",
    "react": "^18.3.0"
  },
  "dependencies": {
    "date-fns": "^4.1.0"
  },
  "devDependencies": {
    "@kladde/plugin-api": "file:vendor/kladde-plugin-api-1.0.0.tgz",
    "@types/express": "^5.0.0",
    "@types/node": "^24.0.0",
    "@types/react": "^18.3.18",
    "react": "^18.3.1",
    "typescript": "^5.8.2"
  }
}
```

| Field | Meaning |
| --- | --- |
| `name` | `kladde-plugin-<name>`, optionally scoped (`@team/kladde-plugin-…`) |
| `kladde.id` | 3–32 characters `a–z`, `0–9`, `-`; it names routes (`/p/<id>`, `/api/p/<id>`), tables (`p_<id>_…`), settings and environment variables (`PLUGIN_<ID>_…`). **Never change it.** |
| `kladde.app` | optional: the Kladde versions the plugin runs with |
| `kladde.defaultEnabled` | optional: on for everyone until they switch it off |
| `exports` | `./server` and/or `./client`, built JavaScript with types |
| `peerDependencies` | `@kladde/plugin-api` (required) with the range the plugin supports; `react` for client plugins. Kladde provides both: **never** in `dependencies` |
| `dependencies` | your own libraries; the build bundles them into the server part, Vite into the client |

**Types of `@kladde/plugin-api` in a plugin repository:** the package is not published to npm. Pack it from the Kladde release you develop against and keep the tarball in the plugin repository:

```bash
# in a checkout of kladde-notes, at the release tag
npm ci && npm pack --workspace=packages/plugin-api   # → kladde-plugin-api-1.0.0.tgz
```

In the plugin it is only a devDependency (types, helpers in tests); in Kladde's build it always comes from the host.

### Server part

```ts
import { defineServerPlugin, handle, PluginError } from '@kladde/plugin-api/server';

export default defineServerPlugin({
  id: 'time',
  migrations: [
    {
      version: 1,
      description: 'Bookings',
      sql: `CREATE TABLE p_time_bookings (
              id TEXT PRIMARY KEY,
              owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              day TEXT NOT NULL,
              payload BLOB NOT NULL)`,
    },
  ],
  routes(router, ctx) {
    router.get('/bookings', (req, res) => {
      const user = ctx.userOf(req);
      const rows = ctx.db.prepare(`SELECT id, payload FROM ${ctx.table('bookings')} WHERE owner_id = ?`).all(user.id);
      res.json(rows.map((r) => ({ id: r.id, ...ctx.cipher.openJson(r.id, r.payload) })));
    });
    router.post('/bookings', handle(async (req, res) => {
      if (!req.body?.minutes) throw new PluginError(400, 'Minutes are missing.');
      // …
    }));
  },
  onNoteChange(event, ctx) { /* e.g. react to type: plugin:time:project */ },
  jobs: [{ name: 'sync', everyMinutes: 15, run: async (ctx) => { /* … */ } }],
  exportAccount: (userId, ctx) => [{ name: 'bookings.json', content: '…' }],
});
```

| Hook | When |
| --- | --- |
| `migrations` | at start, before any request ([details](#own-tables-and-migrations)) |
| `start(ctx)` | once after the migrations |
| `routes(router, ctx)` | Express router under `/api/p/<id>/…`; sign-in (cookie session) and "switched on" are checked before; JSON bodies up to 256 KB are parsed |
| `publicRoutes(router, ctx)` | under `/api/p/<id>/public/…` without an account (webhooks); check secrets yourself |
| `onNoteChange(event, ctx)` | after every accepted note change (not for system notes); synchronous on the sync path: keep it short |
| `jobs` | in the background every `everyMinutes`, never twice at the same time |
| `exportAccount(userId, ctx)` | files in the account export under `.plugins/<id>/…` |
| `mcpTools` | tools for AI assistants on `/mcp` ([details](#mcp-tools)) · since 1.1 |

Errors: `throw new PluginError(status, text)` answers `{ error: text }` with that status; any other error becomes a 500 without details and is logged. Wrap async handlers in `handle(…)`. Errors in `onNoteChange`, jobs and the export are logged and never disturb Kladde.

The context `ctx`:

| | |
| --- | --- |
| `ctx.db`, `ctx.table(name)`, `ctx.transaction(fn)` | Kladde's SQLite connection (synchronous, `node:sqlite`); write only your own tables `p_<id>_…` |
| `ctx.cipher.seal/open/sealJson/openJson(recordId, …)` | AES-GCM with Kladde's data key; plugin id and record id are the associated data (sealed values cannot be swapped between rows or plugins). **Always encrypt contents**; keep only ids, timestamps and states you sort or filter by in plain columns |
| `ctx.notes.list/get/create/update/remove(userId, …)` | notes through the normal sync: rights (own notes, groups, readers), encryption, versions, live updates on all devices, activity, history. Conflicts throw `PluginError` 409 |
| `ctx.userOf(req)`, `ctx.user(id)` | `{ id, username, displayName, isAdmin }` |
| `ctx.enabledFor(userId)` | whether the user switched the plugin on |
| `ctx.notify(userId, { title, text?, path?, noteId?, tag? })` | a notification in the bell and as Web Push ([details](#notifications)) · since 1.1 |
| `ctx.env('TOKEN')` | reads `PLUGIN_<ID>_TOKEN`; other variables stay hidden |
| `ctx.log.info/warn/error` | log lines prefixed `🧩 [<id>]` |

### Client part

```tsx
import { lazy } from 'react';
import { defineClientPlugin } from '@kladde/plugin-api/client';
import { ClockIcon } from './icon.js';

const Overview = lazy(() => import('./Overview.js').then((m) => ({ default: m.Overview })));

export default defineClientPlugin({
  id: 'time',
  name: { de: 'Zeiterfassung', en: 'Time tracking' },
  summary: { de: 'Zeiten buchen und auswerten', en: 'Book and review time' },
  description: { de: '…', en: '…' },
  icon: ClockIcon,
  pages: [
    { path: '', component: Overview },
    { path: '/project/:id', component: Project },
  ],
  nav: [{ label: { de: 'Zeiten', en: 'Time' }, bottomBar: true }],
  commands: [{ id: 'book', label: { de: 'Zeit buchen', en: 'Book time' }, path: '/new' }],
  blocks: [{ lang: 'time', label: { de: 'Zeitübersicht', en: 'Time overview' }, template: 'week: current', component: TimeBlock }],
  settings: Settings,
});
```

Pages get `{ params, path }`; everything else comes from `useKladde()`:

```tsx
import { useKladde } from '@kladde/plugin-api/client';

export function Overview() {
  const host = useKladde();
  const { PageHeader, PageBody, Panel } = host.ui;
  host.useNotesVersion();                                    // re-render when notes change
  const projects = host.notes.list({ type: 'plugin:time:project' });
  // host.api('/bookings') → /api/p/time/bookings
  // host.openNote(id), host.navigate(host.href('/new')), host.toast('Saved')
  // host.t({ de: '…', en: '…' }), host.lang, host.me
  return (
    <>
      <PageHeader title={host.t({ de: 'Zeiten', en: 'Time' })} />
      <PageBody>…</PageBody>
    </>
  );
}
```

- **Design:** Kladde's classes work as they are (`.btn-primary`, `.btn-tonal`, `.btn-text`, `.input`, `.card`, `.chip`, `.segmented`, colors like `bg-panel`, `text-muted`, `border-line`, `text-acc`, type like `text-body-m`, `text-caption`). Rules: [`docs/DESIGN.md`](DESIGN.md) (at most one filled accent button per page, lines instead of shadows, dialogs with `role="dialog"`). Tailwind generates the classes your built files use.
- **Icons:** a component that draws an SVG in `currentColor`; Material Symbols Rounded, weight 300, fit best.
- **Notes on the device:** `host.notes` works offline like the app: changes are saved locally and synced. In online mode some notes come without text (`partial`); `host.notes.load(id)` fetches it.
- **Data of your own tables** comes from the server through `host.api` and is therefore online only. What has to work offline belongs in notes.
- **Errors** in a plugin component show a box with "Reload"; the rest of the app keeps running.

### Note format for plugin notes

Plugin notes are ordinary Markdown notes with `type: plugin:<id>:<kind>` in their frontmatter, so they can be searched, linked, shared, versioned, read over MCP and used offline:

```markdown
---
type: plugin:time:project
customer: Example Ltd
budget: 40h
---
# Project Example

Notes, tasks (- [ ] …), [[links]] as everywhere in Kladde.
```

Rule of thumb: what people read, link or edit offline belongs in notes; bulk data, counters, mappings to external systems and caches belong in own tables.

## Blocks, MCP tools and notifications

Since plugin API **1.1**. A plugin that uses them declares `"@kladde/plugin-api": "^1.1.0"`, so the build refuses a Kladde that is too old.

### Blocks in notes

A fenced block whose info string belongs to the plugin is drawn by the plugin's component while the cursor is outside it, much like ```` ```query ```` or ```` ```cockpit ````. Inside it the text is edited as usual.

````md
```time
week: current
```
````

```tsx
import { useKladde, type PluginBlockProps } from '@kladde/plugin-api/client';

export function TimeBlock({ source, noteId, setSource }: PluginBlockProps) {
  const host = useKladde();          // the same host as on pages: api, notes, t, navigate …
  // source: the text between the fences; setSource(next) writes it back (missing in read-only notes)
  return <div className="card p-3">…</div>;
}
```

- `lang` must be the plugin id or start with `<id>-` (`time`, `time-week`); anything else is ignored, so plugins never take each other's blocks or Kladde's own (`query`, `mermaid`, `cockpit` … always win).
- `/` in the editor offers every block of the plugins that are on (`label`, `keywords`); it inserts `template` between the fences.
- The note stays plain Markdown: exports, public links, the MCP tools and devices without the plugin (or with it switched off) show the block as code. Put what must survive into the block's text, not only into your tables.
- `height` (pixels) is the expected height; it keeps scrolling steady while the block loads.
- The block runs in its own React root with the plugin's error box: a crash never takes the editor down.

### MCP tools

`mcpTools` puts tools on Kladde's MCP endpoint (`/mcp`, the same connection AI assistants already use for notes). Assistants see them as `<id>_<name>` (dashes in the id as underscores), and only for users who switched the plugin on.

```ts
mcpTools: [
  {
    name: 'book_time',                       // → time_book_time
    title: 'Book time',
    description: 'Books minutes on a project for the user. Use it when they tell you what they worked on.',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, minutes: { type: 'integer', minimum: 1 } }, required: ['project', 'minutes'] },
    write: true,                             // only for connections that may write
    async run(args, call, ctx) {             // call: { user, agent, canWrite }
      if (typeof args.minutes !== 'number') throw new PluginError(400, 'minutes must be a number');
      // …
      return { booked: args.minutes };       // object → JSON (and structuredContent), string → text
    },
  },
],
```

- `name`: `a–z`, `0–9`, `_`, starting with a letter, at most 40 characters; Kladde's own tool names always win.
- `description` is what the assistant decides by: say what the tool does and when to use it (English works best).
- Check the arguments yourself. `PluginError` reaches the assistant as a tool error with its message; any other error as "internal error" (logged).
- Tools run with the rights of the connection's account; read and write only that user's data.

### Notifications

```ts
ctx.notify(userId, {
  title: { de: 'Build fehlgeschlagen', en: 'Build failed' },   // at most 120 characters
  text: 'main · job test',                                     // optional, at most 500 (push shows 300)
  path: '/builds/42',                                          // → /p/<id>/builds/42 …
  // noteId: '…',                                              // … or a note the user may open
  tag: 'build-42',                                             // newer pushes with the same tag replace older ones
});
```

The notification appears in the bell and on `/notifications` with the plugin's icon and name and, where the user turned on push, on their devices (quiet hours and "show texts" apply). It is stored encrypted like Kladde's own. `notify` returns `false` and sends nothing when the user has the plugin off, does not exist, is blocked, or cannot open the given note; a click only ever leads into the plugin's pages or to a note.

## Own tables and migrations

- **Names:** tables, indexes, triggers and views are called `p_<id>_…` (dashes of the id become `_`: `time-booking` → `p_time_booking_…`); `ctx.table('x')` builds the name.
- **Steps:** `migrations` lists `version` 1, 2, 3, … in that order; a step has `sql` and/or `up(db, ctx)` (code, e.g. to move data). Each step runs in its own transaction and is recorded with a checksum in the table `plugin_migrations`.
- **Immutable:** a released step never changes. If its SQL changes (for code steps: version or description), the server does not start and names plugin and step. A change always gets a new step.
- **No downgrade:** when the database already has step 5 and the image knows only 4, the server does not start, so old code never runs against a newer schema. The way back is a backup.
- **Guard:** during a step SQLite's authorizer allows writes to the plugin's own tables only. Creating, changing, dropping or writing other tables, `PRAGMA …=`, transactions and `ATTACH` are refused and the step is rolled back. Reading is allowed, and so are foreign keys to `users(id)`.
- **Backup:** when a plugin step is pending on an existing database, Kladde copies it into `BACKUP_DIR` first, as for its own migrations.
- **Accounts and groups:** tie your rows to an account or group with `owner_id … REFERENCES users(id) ON DELETE CASCADE`; they go with a deleted group (groups are `users` rows in Kladde).
- **Backups and restores** contain plugin tables automatically (same database file).
- **Removing a plugin:** a plugin missing from the build leaves its tables untouched; adding it back continues where it stopped. To delete for good:

  ```bash
  docker exec kladde node packages/server/dist/cli.js plugins                  # overview, also data of removed plugins
  docker exec kladde node packages/server/dist/cli.js plugins purge <id> --yes # only for plugins no longer in the image
  ```

## Version matrix: what the build checks

`npm run plugins` (run by the Docker build) stops with a list of all problems when any of these fails:

| Check | Example message |
| --- | --- |
| package name `kladde-plugin-*`, valid `kladde.id`, `exports` present and built | `…: "exports./server" points to ./dist/server.js, which does not exist (is the package built?)` |
| `peerDependencies["@kladde/plugin-api"]` contains the host's plugin API | `kladde-plugin-time 1.4.0 needs @kladde/plugin-api ^2.0.0, this Kladde 2.31.0 provides 1.3.0` |
| `peerDependencies.react` contains Kladde's React (client plugins) | `… needs React ^19.0.0, this Kladde bundles 18.3.1` |
| `kladde.app` contains the Kladde version | `… needs Kladde >=3, this build is 2.31.0` |
| pinned version = installed version | `…: pinned to 1.4.0, but 1.5.0 is installed` |
| no two plugins with the same id | `The plugin id "time" is used by … and …` |
| `@kladde/plugin-api`/`react` not in `dependencies` | `… belongs in "peerDependencies"` |

TypeScript then checks the plugins' types against the plugin API during the build. At start the server checks the ranges again: an image put together by hand with a plugin that does not fit starts without that plugin and says so in the log and in `/api/plugins`.

```bash
npm run plugins -- --check              # only check (packages must be installed)
npm run plugins -- --file path.json     # another list (also KLADDE_PLUGINS_FILE)
npm run plugins -- --skip-install       # the packages are installed already
npm run plugins -- --reset              # back to a build without plugins
```

## Developing locally

```bash
# Kladde and the plugin side by side
git clone https://github.com/steveee99/kladde-notes.git
git clone <your-plugin-repo> kladde-plugin-time

cd kladde-plugin-time && npm install && npx tsc --watch     # the plugin builds on every change

cd ../kladde-notes && npm install
echo '{ "plugins": { "@team/kladde-plugin-time": "file:../kladde-plugin-time" } }' > kladde.plugins.json
npm run plugins          # links the plugin, checks, bundles its server part
npm run dev              # http://localhost:5174
```

- `kladde.plugins.json` in the Kladde checkout is ignored by git; `file:` paths are relative to the list.
- **Client changes** reload through Vite directly (the plugin is linked; `tsc --watch` builds it).
- **Server changes** need `npm run plugins -- --skip-install` (the server part is bundled); the dev server restarts.
- **Tests:** test server parts like Kladde's own tests with `createKladdeApp({ …, plugins: [ … ] })`, see [`packages/server/tests/plugins.test.ts`](../packages/server/tests/plugins.test.ts); render client components inside your own `KladdeHostContext.Provider`, see [`packages/client/tests/plugins.test.tsx`](../packages/client/tests/plugins.test.tsx).
- Before committing in the Kladde repository: `npm run plugins -- --reset`, so the generated lists stay empty.

ESLint rule for plugin repositories (keeps Kladde's internals out):

```js
// eslint.config.js
{
  rules: {
    'no-restricted-imports': ['error', { patterns: [{ group: ['@kladde/*', '!@kladde/plugin-api', '!@kladde/plugin-api/*'], message: 'Plugins use only @kladde/plugin-api.' }] }],
  },
}
```

## Ops repository: building the image with plugins

The ops repository pins **which Kladde version runs with which plugin versions** and builds the image from that. Kladde's Dockerfile does the work, so the ops repository needs no Dockerfile of its own: it puts the plugin list next to Kladde's source. A template to copy: [`docs/ops-repo-template/`](ops-repo-template/).

```
kladde-ops/
├─ kladde.version               v2.28.0  (tag of kladde-notes)
├─ kladde.plugins.json          pinned plugin versions
├─ plugins/                     optional: tarballs (npm pack) of plugins
├─ scripts/build-image.sh       builds the image locally or on CI
└─ .github/workflows/image.yml  builds and pushes on every change
```

### 1. The plugin list

```json
{
  "plugins": {
    "@team/kladde-plugin-time": "1.4.0",
    "@team/kladde-plugin-inventory": "file:plugins/team-kladde-plugin-inventory-0.9.2.tgz"
  }
}
```

Where packages come from:

| Source | Entry | Good for |
| --- | --- | --- |
| private npm registry (e.g. GitHub Packages) | `"1.4.0"` plus `.npmrc` as a build secret | several plugins with their own CI that publishes on tags |
| tarball in the ops repository | `"file:plugins/…-1.4.0.tgz"` | a few plugins; the plugin CI attaches `npm pack` to its releases, the ops repository keeps the file |
| git tag | `"git+https://…/kladde-plugin-x.git#v1.4.0"` | trying something out; the plugin must commit `dist/` or have a `prepare` script |

Always pin **exact versions**; the build checks that exactly this one was installed.

### 2. Building

Check out Kladde at the pinned tag, copy the plugin list and `plugins/` into it, `docker build`. The Docker build runs `npm run plugins`; when the matrix does not fit, the build ends there with the message and no image is made.

```bash
#!/usr/bin/env bash
# scripts/build-image.sh – builds Kladde with the plugins of this repository
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${KLADDE_VERSION:-$(cat kladde.version)}"
IMAGE="${IMAGE:?Set IMAGE, e.g. ghcr.io/<owner>/kladde}"
rm -rf .build && git clone --quiet --depth 1 --branch "$VERSION" https://github.com/steveee99/kladde-notes.git .build/kladde
cp kladde.plugins.json .build/kladde/
if [ -d plugins ]; then cp -R plugins/. .build/kladde/plugins/; fi
SECRET=(); if [ -n "${NPMRC:-}" ]; then SECRET=(--secret "id=npmrc,src=$NPMRC"); fi
docker build ${SECRET[@]+"${SECRET[@]}"} -t "$IMAGE:$VERSION-$(git rev-parse --short HEAD)" -t "$IMAGE:latest" .build/kladde
```

- **Private registry:** `NPMRC=~/.npmrc ./scripts/build-image.sh`; the file reaches the build as a BuildKit secret and never ends up in the image.
- **Tag:** `<kladde-version>-<ops-commit>`, so it is clear which combination runs.

### 3. CI workflow in the ops repository

```yaml
# .github/workflows/image.yml
name: Image
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
  packages: write
jobs:
  image:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Kladde source and plugin list
        id: src
        run: |
          git clone --quiet --depth 1 --branch "$(cat kladde.version)" https://github.com/steveee99/kladde-notes.git kladde
          cp kladde.plugins.json kladde/
          if [ -d plugins ]; then cp -R plugins/. kladde/plugins/; fi
          echo "tag=$(cat kladde.version)-$(git rev-parse --short HEAD)" >> "$GITHUB_OUTPUT"
      - name: .npmrc for private plugin packages
        run: printf '@team:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=%s\n' "$TOKEN" > "$RUNNER_TEMP/npmrc"
        env:
          TOKEN: ${{ secrets.PLUGIN_PACKAGES_TOKEN }}
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: kladde
          push: true
          secret-files: npmrc=${{ runner.temp }}/npmrc
          tags: ghcr.io/${{ github.repository_owner }}/kladde:${{ steps.src.outputs.tag }}
```

The deployment itself (compose file, workflow, script) stays as it is; it only pulls this image instead of the plain one.

### 4. Plugin repositories

Every app becomes a plugin package with its own CI:

```yaml
# .github/workflows/release.yml in a plugin repository
on:
  push:
    tags: ['v*']
jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          registry-url: https://npm.pkg.github.com
      - run: npm ci && npm run lint && npm test && npm run build
      # Registry variant
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      # Tarball variant: the ops repository keeps the file in plugins/
      - run: npm pack && gh release create "$GITHUB_REF_NAME" *.tgz
        env:
          GH_TOKEN: ${{ github.token }}
```

## Updates

| What changes | What you do | What happens |
| --- | --- | --- |
| new Kladde version, plugin API stays `1.x` | raise `kladde.version` | the build passes, all plugins keep fitting |
| new plugin version | raise its pin in `kladde.plugins.json` (or replace the tarball) | the build passes; new migration steps run at start, after a backup |
| Kladde raises the plugin API to `2.0` | raise `kladde.version` | **the build stops** and names every plugin that still needs `^1`. Update those plugins (code, `peerDependencies` to `^1.0.0 \|\| ^2.0.0` or `^2.0.0`), publish, raise the pins |
| a plugin needs a newer Kladde (`kladde.app`) | raise Kladde first | the build stops until both fit |
| rolling a plugin back past its migrations | — | the server does not start (no downgrade); the way back is a backup |
| removing a plugin | delete it from the list | its entries disappear, its data stays (`plugins purge` deletes it) |

Tip: Renovate or Dependabot can open pull requests in the ops repository for new Kladde tags and plugin versions; CI shows whether the matrix fits before anything is merged.

## Rules for Kladde itself

For everyone working on Kladde, so that releases stay safe for plugins:

- `packages/plugin-api` is the **only** public interface. Whatever it exports is a contract.
- A change to it gets its own SemVer version (`version` in `packages/plugin-api/package.json` **and** `PLUGIN_API_VERSION` in `src/compat.ts`; a test keeps both equal): additions are minor, fixes patch, removals or changes major.
- **Deprecate before removing:** mark with `@deprecated`, name it in the CHANGELOG under "Plugin API", remove at the earliest with the next major version of the plugin API.
- The release script (`npm run release`) does **not** bump the plugin API; that is a deliberate manual step.
- CI builds the example plugin into the app on every push (`.github/workflows/ci.yml`): whoever breaks the interface sees it there first.

## Not in the plugin API yet

Left open on purpose, to be added as minor versions of the plugin API:

- panels in a note's inspector
- offline sync of plugin tables (today: offline through notes)
- switching plugins on per group instead of per user
- the standalone desktop app (builds without plugins)
