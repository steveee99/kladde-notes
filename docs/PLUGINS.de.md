# Plugins

[English](PLUGINS.md)

Plugins bringen eigene Apps in Kladde: eigene Menüpunkte, Seiten, Befehle, Einstellungen, eigene Datenbanktabellen und Hintergrundjobs. Anmeldung, Design, Notizformat und Sync liefert Kladde. Plugins werden **beim Build** in das Image eingebaut, nicht zur Laufzeit nachgeladen. Ein Build prüft, ob Kladde-Version und Plugin-Versionen zusammenpassen, und bricht sonst ab, bevor etwas ausgerollt wird.

- [So funktioniert es](#so-funktioniert-es)
- [Ein Plugin schreiben](#ein-plugin-schreiben)
- [Eigene Tabellen und Migrationen](#eigene-tabellen-und-migrationen)
- [Versionsmatrix: was der Build prüft](#versionsmatrix-was-der-build-prüft)
- [Lokal entwickeln](#lokal-entwickeln)
- [Ops-Repo: Image mit Plugins bauen](#ops-repo-image-mit-plugins-bauen)
- [Ablauf bei Updates](#ablauf-bei-updates)
- [Regeln für Kladde selbst](#regeln-für-kladde-selbst)
- [Was v1 noch nicht kann](#was-v1-noch-nicht-kann)

## So funktioniert es

```
 kladde.plugins.json ──► npm run plugins ──► npm run build ──► Docker-Image
   (gepinnte Pakete)      │ installiert            │
                          │ prüft Versionsmatrix   │ Server: lädt packages/server/plugins/<id>.js
                          │ bündelt Server-Teile   │ Client: bündelt <paket>/client mit Vite
                          └ erzeugt Listen         └ Tailwind sieht die Klassen der Plugins
```

- **Grenze:** Ein Plugin importiert nur `@kladde/plugin-api` (Unterpfade `/server` und `/client`), nie Kladdes eigene Pakete. Kladde darf intern in jedem Release umbauen. `@kladde/plugin-api` ändert sich nur mit seiner eigenen SemVer-Version (`PLUGIN_API_VERSION`, unabhängig von der App-Version). Eine ESLint-Regel verbietet andere Importe in `examples/`; übernehmt sie in eure Plugin-Repos (siehe unten).
- **Server-Teil:** Er läuft im Kladde-Prozess und bekommt einen Kontext: die SQLite-Datenbank für eigene Tabellen, Verschlüsselung mit Kladdes Schlüssel, Notizen über den normalen Sync, Benutzer, Feature-Schalter und Umgebungsvariablen. Seine Routen liegen unter `/api/p/<id>/…`, nur für angemeldete Nutzer, die das Plugin eingeschaltet haben.
- **Client-Teil:** React-Komponenten in Kladdes Shell, mit demselben React und dem Werkbank-Design. Seiten liegen unter `/p/<id>/…`. Navigation, Befehlspalette (Ctrl/⌘+K) und eine Karte unter *Einstellungen → Funktionen* kommen aus der Plugin-Definition.
- **Aktivierung:** Jeder Nutzer schaltet Plugins unter *Einstellungen → Funktionen* ein, wie die eingebauten Funktionen. Gespeichert wird das in `features.plugins.<id>`. Mit `kladde.defaultEnabled: true` ist ein Plugin für alle an, die es nicht ausgeschaltet haben.
- **Ohne Plugin-Liste** baut Kladde genau wie bisher, und die generierten Listen sind leer.

## Ein Plugin schreiben

Vorlage ist das Beispiel-Plugin [`examples/kladde-plugin-logbook`](../examples/kladde-plugin-logbook). Es zeigt einmal alles: eigene Tabellen mit Migrationen, verschlüsselte Zeilen, Routen, eine Notiz pro Eintrag, Notiz-Events, einen Job, den Account-Export, eine Seite mit Menüpunkt, einen Befehl und einen Einstellungs-Tab.

### Paketaufbau

```
kladde-plugin-zeiterfassung/
├─ package.json
├─ tsconfig.json          (module NodeNext, jsx react-jsx, outDir dist)
├─ src/
│  ├─ server.ts           export default defineServerPlugin({ … })
│  ├─ client.tsx          export default defineClientPlugin({ … })
│  └─ …                   Seiten, Komponenten, Icon
└─ dist/                  Build-Ergebnis (im Paket enthalten)
```

```json
{
  "name": "@team/kladde-plugin-zeiterfassung",
  "version": "1.4.0",
  "type": "module",
  "kladde": {
    "id": "zeiterfassung",
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
    "@kladde/plugin-api": "^1.0.0",
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

| Feld | Bedeutung |
| --- | --- |
| `name` | `kladde-plugin-<name>`, gern mit Scope (`@team/kladde-plugin-…`) |
| `kladde.id` | 3–32 Zeichen `a–z`, `0–9`, `-`. Sie bestimmt Routen (`/p/<id>`, `/api/p/<id>`), Tabellen (`p_<id>_…`), Einstellungen und Umgebungsvariablen (`PLUGIN_<ID>_…`). **Nie ändern.** |
| `kladde.app` | optional: Kladde-Versionen, mit denen das Plugin läuft |
| `kladde.defaultEnabled` | optional: für alle eingeschaltet, bis jemand es ausschaltet |
| `exports` | `./server` und/oder `./client`, gebautes JavaScript mit Typen |
| `peerDependencies` | `@kladde/plugin-api` (Pflicht) mit dem unterstützten Bereich; `react` für Client-Plugins. Beide liefert Kladde, sie gehören **nie** in `dependencies`. |
| `dependencies` | eigene Bibliotheken. Server-seitig bündelt der Build sie mit hinein, Client-seitig bündelt Vite sie. |

**Typen von `@kladde/plugin-api` im Plugin-Repo:** Das Paket wird nicht auf npm veröffentlicht. Packt es aus dem Kladde-Release, gegen das ihr entwickelt, und legt den Tarball ins Plugin-Repo:

```bash
# im Checkout von kladde-notes, auf dem Release-Tag
npm ci && npm pack --workspace=packages/plugin-api   # → kladde-plugin-api-1.0.0.tgz
```

Im Plugin ist es nur eine devDependency (Typen, Hilfsfunktionen beim Testen). Im Kladde-Build kommt es immer vom Host.

### Server-Teil

```ts
import { defineServerPlugin, handle, PluginError } from '@kladde/plugin-api/server';

export default defineServerPlugin({
  id: 'zeiterfassung',
  migrations: [
    {
      version: 1,
      description: 'Buchungen',
      sql: `CREATE TABLE p_zeiterfassung_buchungen (
              id TEXT PRIMARY KEY,
              owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              tag TEXT NOT NULL,
              payload BLOB NOT NULL)`,
    },
  ],
  routes(router, ctx) {
    router.get('/buchungen', (req, res) => {
      const user = ctx.userOf(req);
      const rows = ctx.db.prepare(`SELECT id, payload FROM ${ctx.table('buchungen')} WHERE owner_id = ?`).all(user.id);
      res.json(rows.map((r) => ({ id: r.id, ...ctx.cipher.openJson(r.id, r.payload) })));
    });
    router.post('/buchungen', handle(async (req, res) => {
      if (!req.body?.minuten) throw new PluginError(400, 'Minuten fehlen.');
      // …
    }));
  },
  onNoteChange(event, ctx) { /* z. B. auf type: plugin:zeiterfassung:projekt reagieren */ },
  jobs: [{ name: 'abgleich', everyMinutes: 15, run: async (ctx) => { /* … */ } }],
  exportAccount: (userId, ctx) => [{ name: 'buchungen.json', content: '…' }],
});
```

| Hook | Wann |
| --- | --- |
| `migrations` | beim Start, vor allen Requests ([Details](#eigene-tabellen-und-migrationen)) |
| `start(ctx)` | einmal nach den Migrationen |
| `routes(router, ctx)` | Express-Router unter `/api/p/<id>/…`. Davor stehen Anmeldung (Cookie-Sitzung) und die Prüfung, ob der Nutzer das Plugin eingeschaltet hat. JSON-Bodies bis 256 KB sind schon geparst. |
| `publicRoutes(router, ctx)` | unter `/api/p/<id>/public/…` ohne Anmeldung, z. B. für Webhooks. Geheimnisse selbst prüfen! |
| `onNoteChange(event, ctx)` | nach jeder angenommenen Notizänderung (nicht für Systemnotizen). Läuft synchron im Sync-Pfad, also kurz halten. |
| `jobs` | im Hintergrund alle `everyMinutes` Minuten, nie doppelt gleichzeitig |
| `exportAccount(userId, ctx)` | Dateien im Account-Export unter `.plugins/<id>/…` |

Fehler: `throw new PluginError(status, text)` ergibt `{ error: text }` mit diesem Status. Jeder andere Fehler wird zu 500 ohne Details und landet im Log. Asynchrone Handler wickelt ihr in `handle(…)` ein. Fehler in `onNoteChange`, Jobs und Export werden geloggt und stören Kladde nie.

Der Kontext `ctx`:

| | |
| --- | --- |
| `ctx.db`, `ctx.table(name)`, `ctx.transaction(fn)` | dieselbe SQLite-Verbindung wie Kladde (synchron, `node:sqlite`). Nur die eigenen Tabellen `p_<id>_…` beschreiben. |
| `ctx.cipher.seal/open/sealJson/openJson(recordId, …)` | AES-GCM mit Kladdes Datenschlüssel. Als zusätzliche Daten dienen Plugin-ID und Datensatz-ID, verschlüsselte Werte lassen sich also nicht zwischen Zeilen oder Plugins vertauschen. **Inhalte immer verschlüsseln**; im Klartext nur IDs, Zeitstempel und Zustände, nach denen ihr sortieren oder filtern müsst. |
| `ctx.notes.list/get/create/update/remove(userId, …)` | Notizen über den normalen Sync: Rechteprüfung (eigene Notizen, Gruppen, Leser), Verschlüsselung, Versionen, Live-Update auf allen Geräten, Aktivität, Verlauf. Konflikte ergeben `PluginError` 409. |
| `ctx.userOf(req)`, `ctx.user(id)` | `{ id, username, displayName, isAdmin }` |
| `ctx.enabledFor(userId)` | ob der Nutzer das Plugin eingeschaltet hat |
| `ctx.env('TOKEN')` | liest `PLUGIN_<ID>_TOKEN`, andere Variablen sieht das Plugin nicht |
| `ctx.log.info/warn/error` | Log mit Präfix `🧩 [<id>]` |

### Client-Teil

```tsx
import { lazy } from 'react';
import { defineClientPlugin } from '@kladde/plugin-api/client';
import { UhrIcon } from './icon.js';

const Uebersicht = lazy(() => import('./Uebersicht.js').then((m) => ({ default: m.Uebersicht })));

export default defineClientPlugin({
  id: 'zeiterfassung',
  name: { de: 'Zeiterfassung', en: 'Time tracking' },
  summary: { de: 'Zeiten buchen und auswerten', en: 'Book and review time' },
  description: { de: '…', en: '…' },
  icon: UhrIcon,
  pages: [
    { path: '', component: Uebersicht },
    { path: '/projekt/:id', component: Projekt },
  ],
  nav: [{ label: { de: 'Zeiten', en: 'Time' }, bottomBar: true }],
  commands: [{ id: 'buchen', label: { de: 'Zeit buchen', en: 'Book time' }, path: '/neu' }],
  settings: Einstellungen,
});
```

Seiten bekommen `{ params, path }`. Alles andere holen sie sich mit `useKladde()`:

```tsx
import { useKladde } from '@kladde/plugin-api/client';

export function Uebersicht() {
  const host = useKladde();
  const { PageHeader, PageBody, Panel } = host.ui;
  host.useNotesVersion();                                    // neu rendern, wenn sich Notizen ändern
  const projekte = host.notes.list({ type: 'plugin:zeiterfassung:projekt' });
  // host.api('/buchungen') → /api/p/zeiterfassung/buchungen
  // host.openNote(id), host.navigate(host.href('/neu')), host.toast('Gespeichert')
  // host.t({ de: '…', en: '…' }), host.lang, host.me
  return (
    <>
      <PageHeader title={host.t({ de: 'Zeiten', en: 'Time' })} />
      <PageBody>…</PageBody>
    </>
  );
}
```

- **Design:** Kladdes Klassen funktionieren direkt (`.btn-primary`, `.btn-tonal`, `.btn-text`, `.input`, `.card`, `.chip`, `.segmented`, Farben wie `bg-panel`, `text-muted`, `border-line`, `text-acc`, Schriftgrößen wie `text-body-m`, `text-caption`). Regeln siehe [`docs/DESIGN.md`](DESIGN.md): höchstens ein gefüllter Akzent-Button pro Seite, Linien statt Schatten, Dialoge mit `role="dialog"`. Tailwind erzeugt die Klassen, die eure gebauten Dateien verwenden.
- **Icons:** eine Komponente, die ein SVG in `currentColor` zeichnet. Material Symbols Rounded mit Gewicht 300 passen am besten.
- **Notizen auf dem Gerät:** `host.notes` arbeitet offline wie die App: Änderungen werden lokal gespeichert und synchronisiert. Im Online-Modus fehlen bei manchen Notizen die Texte (`partial`); `host.notes.load(id)` lädt sie nach.
- **Plugin-Daten aus eigenen Tabellen** kommen über `host.api` vom Server und sind damit nur online verfügbar. Was offline gebraucht wird, gehört in Notizen.
- **Fehler** in einer Plugin-Komponente zeigt Kladde in einem Kasten mit „Neu laden“ an; der Rest der App läuft weiter.

### Notizformat für Plugin-Notizen

Plugin-Notizen sind normale Markdown-Notizen mit `type: plugin:<id>:<art>` im Frontmatter. Damit lassen sie sich durchsuchen, verlinken, teilen und versionieren, sie sind per MCP erreichbar und offline verfügbar:

```markdown
---
type: plugin:zeiterfassung:projekt
kunde: Muster GmbH
budget: 40h
---
# Projekt Muster

Notizen, Aufgaben (- [ ] …), [[Links]] wie überall in Kladde.
```

Faustregel: Was Menschen lesen, verlinken oder offline bearbeiten sollen, gehört in Notizen. Massendaten, Zähler, Zuordnungen zu externen Systemen und Caches gehören in eigene Tabellen.

## Eigene Tabellen und Migrationen

- **Namen:** Tabellen, Indizes, Trigger und Views heißen `p_<id>_…`, Bindestriche der ID werden zu `_` (`zeit-buchung` ergibt `p_zeit_buchung_…`). `ctx.table('x')` baut den Namen.
- **Schritte:** `migrations` ist eine Liste mit `version` 1, 2, 3, … in dieser Reihenfolge. Ein Schritt hat `sql` und/oder `up(db, ctx)` (Code, z. B. um Daten umzuziehen). Jeder Schritt läuft in einer eigenen Transaktion und wird in der Tabelle `plugin_migrations` mit Prüfsumme vermerkt.
- **Unveränderlich:** Ein ausgerollter Schritt darf sich nie mehr ändern. Ändert sich das SQL (bzw. bei Code-Schritten Version oder Beschreibung), startet der Server nicht und nennt Plugin und Schritt. Für Änderungen gibt es immer einen neuen Schritt.
- **Kein Downgrade:** Kennt die Datenbank schon Schritt 5, das Image aber nur bis 4, startet der Server nicht. So läuft nie alter Code gegen ein neueres Schema. Zurück geht es nur über ein Backup.
- **Schutz:** Während eines Schritts erlaubt SQLite dem Plugin nur Schreibzugriffe auf die eigenen Tabellen (Authorizer). Fremde Tabellen anlegen, ändern, löschen oder beschreiben, `PRAGMA …=`, Transaktionen und `ATTACH` werden abgelehnt, und der Schritt wird zurückgerollt. Lesen ist erlaubt, Fremdschlüssel auf `users(id)` ebenso.
- **Backup:** Steht bei einer bestehenden Datenbank ein Plugin-Schritt an, legt Kladde vorher eine Kopie in `BACKUP_DIR` an, wie bei Kernmigrationen.
- **Konten und Gruppen:** Hängt eure Zeilen per `owner_id … REFERENCES users(id) ON DELETE CASCADE` an Konto oder Gruppe; dann verschwinden sie mit der gelöschten Gruppe. Gruppen sind in Kladde ebenfalls `users`-Zeilen.
- **Backups und Restore** enthalten Plugin-Tabellen automatisch, denn sie liegen in derselben Datenbankdatei.
- **Plugin entfernen:** Fehlt ein Plugin im Build, bleiben seine Tabellen unberührt liegen. Nimmt man es wieder auf, geht es weiter. Endgültig löschen:

  ```bash
  docker exec kladde node packages/server/dist/cli.js plugins                  # Übersicht, auch Daten entfernter Plugins
  docker exec kladde node packages/server/dist/cli.js plugins purge <id> --yes # nur für Plugins, die nicht mehr im Image sind
  ```

## Versionsmatrix: was der Build prüft

`npm run plugins` (im Docker-Build automatisch) bricht mit einer Liste aller Probleme ab, wenn eines davon zutrifft:

| Prüfung | Beispiel-Meldung |
| --- | --- |
| Paketname `kladde-plugin-*`, gültige `kladde.id`, `exports` vorhanden und gebaut | `…: "exports./server" points to ./dist/server.js, which does not exist (is the package built?)` |
| `peerDependencies["@kladde/plugin-api"]` enthält die Plugin-API des Hosts | `kladde-plugin-zeit 1.4.0 needs @kladde/plugin-api ^2.0.0, this Kladde 2.31.0 provides 1.3.0` |
| `peerDependencies.react` enthält Kladdes React (Client-Plugins) | `… needs React ^19.0.0, this Kladde bundles 18.3.1` |
| `kladde.app` enthält die Kladde-Version | `… needs Kladde >=3, this build is 2.31.0` |
| gepinnte Version = installierte Version | `…: pinned to 1.4.0, but 1.5.0 is installed` |
| keine zwei Plugins mit derselben ID | `The plugin id "zeit" is used by … and …` |
| `@kladde/plugin-api`/`react` nicht in `dependencies` | `… belongs in "peerDependencies"` |

Danach prüft TypeScript beim Build die Typen der Plugins gegen die Plugin-API. Beim Start prüft der Server die Bereiche noch einmal: Ein von Hand zusammengestelltes Image mit unpassendem Plugin startet ohne dieses Plugin, mit Meldung im Log und in `/api/plugins`.

```bash
npm run plugins -- --check              # nur prüfen (Pakete müssen installiert sein)
npm run plugins -- --file pfad.json     # andere Liste (auch KLADDE_PLUGINS_FILE)
npm run plugins -- --skip-install       # Pakete sind schon installiert
npm run plugins -- --reset              # zurück zu einem Build ohne Plugins
```

## Lokal entwickeln

```bash
# Kladde und das Plugin nebeneinander
git clone https://github.com/steveee99/kladde-notes.git
git clone <euer-plugin-repo> kladde-plugin-zeiterfassung

cd kladde-plugin-zeiterfassung && npm install && npx tsc --watch     # Plugin baut bei jeder Änderung

cd ../kladde-notes && npm install
echo '{ "plugins": { "@team/kladde-plugin-zeiterfassung": "file:../kladde-plugin-zeiterfassung" } }' > kladde.plugins.json
npm run plugins          # verlinkt das Plugin, prüft, bündelt den Server-Teil
npm run dev              # http://localhost:5174
```

- `kladde.plugins.json` im Kladde-Checkout ist von git ausgenommen. `file:`-Pfade gelten relativ zur Liste.
- **Client-Änderungen** lädt Vite direkt neu (das Plugin ist verlinkt, `tsc --watch` baut mit).
- **Server-Änderungen** brauchen `npm run plugins -- --skip-install`, denn der Server-Teil wird gebündelt; danach startet der Dev-Server neu.
- **Tests:** Server-Teile lassen sich wie Kladdes eigene Tests mit `createKladdeApp({ …, plugins: [ … ] })` testen, siehe [`packages/server/tests/plugins.test.ts`](../packages/server/tests/plugins.test.ts). Client-Komponenten rendert ihr mit einem eigenen `KladdeHostContext.Provider`, siehe [`packages/client/tests/plugins.test.tsx`](../packages/client/tests/plugins.test.tsx).
- Vor einem Commit im Kladde-Repo: `npm run plugins -- --reset`, damit die generierten Listen leer bleiben.

ESLint-Regel für Plugin-Repos (verhindert Importe aus Kladdes Interna):

```js
// eslint.config.js
{
  rules: {
    'no-restricted-imports': ['error', { patterns: [{ group: ['@kladde/*', '!@kladde/plugin-api', '!@kladde/plugin-api/*'], message: 'Plugins use only @kladde/plugin-api.' }] }],
  },
}
```

## Ops-Repo: Image mit Plugins bauen

Das Ops-Repo legt fest, **welche Kladde-Version mit welchen Plugin-Versionen** ausgerollt wird, und baut daraus das Image. Kladdes Dockerfile kann das schon. Das Ops-Repo braucht daher kein eigenes Dockerfile mehr, sondern legt nur die Plugin-Liste neben den Kladde-Quelltext. Eine kopierfertige Vorlage liegt in [`docs/ops-repo-template/`](ops-repo-template/).

```
kladde-ops/
├─ kladde.version               v2.28.0  (Tag von kladde-notes)
├─ kladde.plugins.json          gepinnte Plugin-Versionen
├─ plugins/                     optional: Tarballs (npm pack) der Plugins
├─ scripts/build-image.sh       baut das Image lokal oder in CI
└─ .github/workflows/image.yml  baut und pusht bei jeder Änderung
```

### 1. Plugin-Liste

```json
{
  "plugins": {
    "@team/kladde-plugin-zeiterfassung": "1.4.0",
    "@team/kladde-plugin-inventar": "file:plugins/team-kladde-plugin-inventar-0.9.2.tgz"
  }
}
```

Woher die Pakete kommen, bestimmt der Eintrag:

| Quelle | Eintrag | Geeignet für |
| --- | --- | --- |
| private npm-Registry (z. B. GitHub Packages) | `"1.4.0"` und `.npmrc` als Build-Secret | mehrere Plugins mit eigener CI, die bei Tags veröffentlicht |
| Tarball im Ops-Repo | `"file:plugins/…-1.4.0.tgz"` | wenige Plugins; die Plugin-CI hängt `npm pack` an ihre Releases, das Ops-Repo legt die Datei ab |
| Git-Tag | `"git+https://…/kladde-plugin-x.git#v1.4.0"` | schnell zum Ausprobieren; das Plugin muss dann `dist/` mit einchecken oder ein `prepare`-Skript haben |

Pinnt immer **exakte Versionen**. Der Build prüft, dass genau diese installiert wurde.

### 2. Bauen

Ablauf: Kladde am gepinnten Tag auschecken, Plugin-Liste und `plugins/` hineinkopieren, dann `docker build`. Im Docker-Build läuft `npm run plugins`. Passt die Matrix nicht, endet der Build dort mit der Meldung, und es entsteht kein Image.

```bash
#!/usr/bin/env bash
# scripts/build-image.sh – baut Kladde mit den Plugins dieses Repos
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${KLADDE_VERSION:-$(cat kladde.version)}"
IMAGE="${IMAGE:?IMAGE setzen, z. B. ghcr.io/<owner>/kladde}"
rm -rf .build && git clone --quiet --depth 1 --branch "$VERSION" https://github.com/steveee99/kladde-notes.git .build/kladde
cp kladde.plugins.json .build/kladde/
if [ -d plugins ]; then cp -R plugins/. .build/kladde/plugins/; fi
SECRET=(); if [ -n "${NPMRC:-}" ]; then SECRET=(--secret "id=npmrc,src=$NPMRC"); fi
docker build ${SECRET[@]+"${SECRET[@]}"} -t "$IMAGE:$VERSION-$(git rev-parse --short HEAD)" -t "$IMAGE:latest" .build/kladde
```

- **Private Registry:** `NPMRC=~/.npmrc ./scripts/build-image.sh`. Die Datei kommt als BuildKit-Secret in den Build und landet nicht im Image.
- **Tag:** `<kladde-version>-<ops-commit>`. So ist eindeutig, welche Kombination läuft.

### 3. CI-Workflow im Ops-Repo

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
      - name: Kladde-Quelltext und Plugin-Liste
        run: |
          git clone --quiet --depth 1 --branch "$(cat kladde.version)" https://github.com/steveee99/kladde-notes.git kladde
          cp kladde.plugins.json kladde/
          if [ -d plugins ]; then cp -R plugins/. kladde/plugins/; fi
          echo "tag=$(cat kladde.version)-$(git rev-parse --short HEAD)" >> "$GITHUB_OUTPUT"
        id: src
      - name: .npmrc für private Plugin-Pakete
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

Das Deployment selbst (Compose, Workflow, Skript) bleibt, wie es ist; es zieht nur dieses Image statt des bisherigen.

### 4. Plugin-Repos

Jede App wird ein Plugin-Paket mit eigener CI:

```yaml
# .github/workflows/release.yml im Plugin-Repo
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
      # Variante Registry
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      # Variante Tarball: das Ops-Repo legt die Datei unter plugins/ ab
      - run: npm pack && gh release create "$GITHUB_REF_NAME" *.tgz
        env:
          GH_TOKEN: ${{ github.token }}
```

## Ablauf bei Updates

| Was ändert sich | Was ihr tut | Was passiert |
| --- | --- | --- |
| Neue Kladde-Version, Plugin-API bleibt `1.x` | `kladde.version` erhöhen | Build läuft durch, alle Plugins passen weiter |
| Neue Plugin-Version | Pin in `kladde.plugins.json` erhöhen (bzw. Tarball tauschen) | Build läuft durch; neue Migrationsschritte laufen beim Start, vorher ein Backup |
| Kladde hebt die Plugin-API auf `2.0` | `kladde.version` erhöhen | **Build bricht ab** und nennt alle Plugins, die noch `^1` verlangen. Die Plugins nachziehen (Code anpassen, `peerDependencies` auf `^1.0.0 \|\| ^2.0.0` oder `^2.0.0`), veröffentlichen, Pins erhöhen. |
| Plugin verlangt eine neuere Kladde (`kladde.app`) | erst Kladde erhöhen | Build bricht ab, bis beides passt |
| Plugin-Version zurückdrehen mit neueren Migrationen | — | Server startet nicht (kein Downgrade); zurück nur über ein Backup |
| Plugin entfernen | aus der Liste löschen | Menüpunkte verschwinden, Daten bleiben (`plugins purge` löscht sie) |

Tipp: Renovate oder Dependabot können im Ops-Repo Pull Requests für neue Kladde-Tags und Plugin-Versionen öffnen. Die CI zeigt dann vor dem Merge, ob die Matrix passt.

## Regeln für Kladde selbst

Für alle, die an Kladde arbeiten. So bleiben Releases für Plugins sicher:

- `packages/plugin-api` ist die **einzige** öffentliche Schnittstelle. Alles, was dort exportiert wird, ist Vertrag.
- Eine Änderung daran bekommt eine eigene SemVer-Version (`version` in `packages/plugin-api/package.json` **und** `PLUGIN_API_VERSION` in `src/compat.ts`; ein Test hält beide gleich). Neue Dinge bedeuten Minor, Korrekturen Patch, und Entfernen oder Ändern ist Major.
- **Erst abkündigen, dann entfernen:** mit `@deprecated` markieren und im CHANGELOG unter „Plugin API“ nennen. Entfernt wird frühestens mit der nächsten Major-Version der Plugin-API.
- Das Release-Skript (`npm run release`) erhöht die Plugin-API **nicht**, das geschieht bewusst von Hand.
- Die CI baut das Beispiel-Plugin bei jedem Push in die App (`.github/workflows/ci.yml`). Wer die Schnittstelle bricht, sieht es dort zuerst.

## Was v1 noch nicht kann

Bewusst offen gelassen und später ergänzbar (als Minor-Versionen der Plugin-API):

- Blöcke im Editor (wie ```` ```cockpit ````) und Panels im Inspector einer Notiz
- eigene MCP-Werkzeuge für KI-Assistenten
- eigene Benachrichtigungen (Glocke, Web Push)
- Offline-Sync von Plugin-Tabellen (heute: offline über Notizen)
- Einschalten pro Gruppe statt pro Nutzer
- die Standalone-Desktop-App (baut ohne Plugins)
