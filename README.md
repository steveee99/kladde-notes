# Kladde

**Kladde** ist eine selbst gehostete Notiz-App für den Browser: Markdown mit Live-Vorschau, Aufgaben mit Fälligkeit und Wiederholung, Abfragen und Kanban-Boards über die eigenen Notizen – offline nutzbar auf Handy, iPad und Desktop, synchronisiert sobald wieder online. Zugang nur per Einladung, Anmeldung per **Passkey** – oder mit Benutzername und Passwort, wo Passkeys nicht gehen (lokales Netz ohne HTTPS).

> Eine *Kladde* ist das Notizbuch, in das erst einmal alles hineinkommt, bevor es ins Reine geschrieben wird.

---

## ✨ Funktionen

| Bereich | Stand |
| --- | --- |
| **Zugang** | Einladungscode → Benutzername → Passkey oder Passwort. Weitere Geräte per Einmal-Code (15 min) oder zusätzlichem Passkey. Sessions als httpOnly-Cookie |
| **Verwaltung** | Für Admins in der App: Konten, Passwort-Reset, Gerätecodes, Admin-Rolle, Sperren, Einladungen, Protokoll. Das älteste Konto ist Admin |
| **Spaces** | Jeder Benutzer hat seinen eigenen Bereich, kein Zugriff auf fremde Notizen |
| **Teilen** | Pro Notiz oder **ganze Ordner** teilen (mit Rechten für Lesen, Bearbeiten, Anlegen, Löschen) oder öffentlicher Nur-Lese-Link für Gäste (`/s/…`) |
| **Editor** | CodeMirror 6 mit Live-Preview: Markdown-Syntax ist nur in der Cursor-Zeile sichtbar; **Slash-Befehle** (`/`) für Blöcke, Diagramme, Tabellen, Abfragen und Datei-Upload; Fußnoten (`[^1]`) |
| **Tabellen & Diagramme** | GFM-Tabellen als interaktive Tabellen (sortieren, filtern); Mermaid-Diagramme (` ```mermaid `) und Mindmaps (` ```mindmap `) direkt in der Vorschau |
| **Abfragen & Kanban** | ```` ```query ```` -Blöcke: `TABLE`, `LIST`, `TASKS` sowie **`KANBAN`** (`KANBAN BY status VALUES "offen", "läuft", "fertig"`) mit interaktivem Drag-and-Drop |
| **Aufgaben** | `- [ ] Text 📅 2026-11-30 🔁 monatlich` oder handytauglich `due:morgen every:week`; freie Aufgaben auf der Startseite ohne Notiz; Schnellmenü für Fälligkeiten (Heute/Morgen/Woche); Doppelklick springt zur Quellnotiz |
| **PARA** | Ordner Inbox, Projekte, Bereiche, Ressourcen, Archiv. **Inbox als Arbeitsliste** (`/inbox`): jeder Gedanke ist eine eigene Notiz und wird per Klick zu Projekt, Bereich, Ressource, Zettel oder Archiv. **Projekte** mit `status: aktiv/pausiert/fertig`; „Abschließen“ setzt Status + Datum und verschiebt nach `4 Archiv/…`, „Wiederherstellen“ zurück. Ganze Ordner archivieren. Aktive Projekte auf dem Startbildschirm, mit Hinweis „kein nächster Schritt“ |
| **Zettelkasten** | Zettel-Dialog mit Typ (flüchtig, Literatur mit Quelle, dauerhaft) und fester ID im Frontmatter; `[[ID]]` und `[[ID Titel]]` bleiben auch nach Umbenennen gültig. Hinweis auf unverbundene Zettel |
| **Verknüpfen** | `[[Wikilinks]]` mit Autovervollständigung; **beim Umbenennen werden alle Links angepasst**; Rückverweise; **unverlinkte Erwähnungen** mit Knopf „Verlinken“; `#tags`; Frontmatter als Eigenschaften-Leiste |
| **Wissensnetz** | Graph aller Notizen (`/graph`, nach PARA-Rolle eingefärbt, zoom- und verschiebbar) und lokales Netz unter jeder Notiz |
| **Versionsverlauf** | Verlauf pro Notiz mit bis zu 100 Ständen auf dem Server; Diff-Ansicht mit hinzugefügten/entfernten Zeilen (`git diff`-Stil) oder gerenderter Text; Wiederherstellung per Klick |
| **Rezept-Import** | Rezepte per Link importieren (schema.org von Chefkoch, EatSmarter, Food-Blogs etc.) einheitlich nach `3 Ressourcen/Rezepte`: Zutaten-Tabelle, nummerierte Schritte, Quelle |
| **Git-Sync** | Eigene Notizen automatisch als Markdown-Dateien in ein persönliches Git-Repository (GitLab, GitHub etc.) pushen (Branch `main`, anpassbare Commit-Nachricht) |
| **KI & MCP** | MCP-Server (`/mcp`, Streamable HTTP) für Assistenten wie Claude Desktop, Claude Code, Cursor: OAuth 2.1 oder persönliche Zugriffstoken (PAT); Zugriff isoliert auf eigene Notizen |
| **Wochenrückblick** | `/review`: Inbox, überfällige Aufgaben, Projekte ohne nächsten Schritt, ruhende Bereiche, alte flüchtige und unverbundene Zettel; Erinnerung nach 7 Tagen |
| **Vorlagen** | Eigene Vorlagen unter Einstellungen → Vorlagen verwalten (`{{title}}`, `{{date}}`, `{{zid}}`), mit Standard-Zielordner und verschlüsselter Synchronisation |
| **Medien** | Bilder und PDFs per Einfügen/Ziehen/Button; Bilder-Grid mit ```` ```gallery ```` ; PDF eingebettet; Code-Blöcke mit Syntax-Highlighting und Kopieren |
| **Offline & Sync** | IndexedDB pro Konto, Sync über Cursor + Versionen; bei Konflikten gewinnt der Server, der lokale Text bleibt als „(Konflikt …)“-Kopie erhalten; Live-Updates per Server-Sent Events |
| **App & Design** | PWA (installierbar, Service Worker), Designs Hell und Dunkel (Material 3 mit Navigation Rail am Desktop/Tablet und Navigation Bar am Handy); Notizlisten umschaltbar (Kacheln/Liste/Tabelle) |
| **Sicherheit** | Notizen (Pfad + Inhalt) und Anhänge AES-256-GCM-verschlüsselt auf dem Server, Origin-Prüfung, Rate-Limits, Audit-Log, gehärteter Container |
| **NAS** | Optionaler Klartext-Spiegel aller Notizen als `.md`-Dateien nach `EXPORT_DIR` (z. B. eingebundene NAS-Freigabe) |

### Noch nicht umgesetzt (Roadmap)
- Ende-zu-Ende-Verschlüsselung (Schlüssel nur im Browser) und Verschlüsselung der lokalen IndexedDB
- Anhänge offline hochladen (derzeit nur online)
- Echtzeit-Kollaboration im selben Dokument (heute: Konflikt-Kopie)

---

## 🚀 Lokale Entwicklung

Voraussetzungen: Node.js ≥ 22.13 (für `node:sqlite`), npm ≥ 9.

```bash
npm install
npm run dev
```

- Frontend (Vite): http://localhost:5174 – leitet `/api` an den Server weiter
- Backend: http://localhost:3002
- **Dev-Login:** Auf der Anmeldeseite gibt es lokal den Button „Dev-Login“ (Benutzer `dev`, nur mit `DEV_LOGIN=1` und außerhalb von Production)
- Beim ersten Start schreibt der Server einen Einladungslink ins Log (`✉️ Erste Einladung …`). Passkeys funktionieren auf `localhost` auch ohne HTTPS
- Neu anfangen: `packages/server/data/` löschen

```bash
npm run build   # shared → server → client
npm run test    # Abfragesprache, Aufgaben, Notiz-/Benutzer-Store
```

---

## 🖥️ Standalone Desktop-Modus (Einzeldatei / Windows `.exe`)

Kladde lässt sich ohne Docker und ohne Benutzerverwaltung als eigenständiges Desktop-Programm bauen (**Node.js SEA** + dediziertes Microsoft Edge `--app`-Fenster, alternativ Chrome oder Systembrowser):

```bash
git clone <repo> && cd kladde
npm install
npm run build:desktop   # natives Binary für das aktuelle OS (dist/kladde bzw. dist/kladde.exe)
npm run build:exe       # Windows-Executable dist/kladde.exe (unter macOS/Linux inkl. Download von node.exe)
```

- **Kein Login / keine Benutzerverwaltung:** Ein lokaler Einzelbenutzer (`lokal`) wird beim ersten Start automatisch angelegt; Einladungen, Passkeys, Admin-Bereich und Mehrbenutzer-/Link-Freigaben sind deaktiviert.
- **Lokale Speicherung (außerhalb der `.exe`):**
  - Windows: `%LOCALAPPDATA%\Kladde\` (`kladde.sqlite`, `secret.key`, `files\`, `backups\`, `kladde.log`)
  - macOS: `~/Library/Application Support/Kladde/` · Linux: `~/.local/share/kladde/`
  - **Portabler Modus:** Existiert neben `kladde.exe` ein Ordner `kladde-data` (oder wird `--portable-data` übergeben), landen alle Daten dort statt im Benutzerprofil.
- **Updates durch Austausch der `.exe`:** Alte `kladde.exe` schließen, neue `kladde.exe` drüberkopieren und starten. Bestehende verschlüsselte Notizen bleiben erhalten; vor Schema-Migrationen wird automatisch ein SQLite-Backup unter `backups\` angelegt.
- **Optionen:** `--data-dir=<pfad>`, `--portable-data`, `--port=<nr>` (Standard `34172`), `--server-only` (nur lokaler Server ohne Browserfenster).

---

## 🐳 Betrieb mit Docker

```bash
PUBLIC_URL=https://notes.example.org docker compose up --build -d
docker logs kladde   # enthält die erste Einladung
```

Die App läuft dann auf Port `13002`. **Passkeys brauchen HTTPS** (außer auf localhost) und sind an die Domain aus `PUBLIC_URL` gebunden – betreibe die App hinter einem Reverse-Proxy (Caddy, nginx, Traefik) und setze `TRUST_PROXY=1`. Ohne HTTPS (z. B. direkt über `http://192.168.1.10:13002` im Heimnetz) meldest du dich mit Benutzername und Passwort an.

CLI-Werkzeug (Import/Export, Suche, Anhänge, Sicherung & Verwaltung):

```bash
docker exec kladde node packages/server/dist/cli.js hilfe
docker exec kladde node packages/server/dist/cli.js import /import/ordner Projekte --overwrite
docker exec kladde node packages/server/dist/cli.js export / /export/space --with-files
docker exec kladde node packages/server/dist/cli.js einladen Anna
```

| Variable | Bedeutung |
| --- | --- |
| `PUBLIC_URL` | Öffentliche Adresse; legt die Passkey-Domain fest und baut Einladungslinks |
| `TRUST_PROXY` | `1` hinter einem Reverse-Proxy |
| `DATA_KEY` | Schlüssel für die Verschlüsselung (`openssl rand -base64 32`). Leer = Schlüsseldatei `data/secret.key` im Volume |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_ADMIN_USER_IDS` | Admin-Bot: `/einladen`, `/einladungen`, `/konten`, `/sperren`, `/passwort`, `/admin`, `/status`, `/protokoll` |
| `BACKUP_KEEP` | Tägliche Datenbank-Backups in `data/backups` (Standard 7, `0` = aus) |
| `EXPORT_DIR` | Klartext-Spiegel der Notizen (z. B. NAS), leer = aus |

**KI-Assistenten (MCP):** Unter `PUBLIC_URL/mcp` läuft ein MCP-Server (Streamable HTTP). Clients wie claude.ai, Claude Desktop oder Claude Code melden sich per OAuth 2.1 an (dynamische Registrierung, PKCE, Zustimmung mit dem normalen Kladde-Login) oder mit einem Zugriffstoken aus Einstellungen → KI-Assistenten (`Authorization: Bearer kld_…`). Jede Verbindung sieht nur die eigenen Notizen ihres Kontos. Der Reverse-Proxy muss dafür neben der App auch `/mcp`, `/oauth/…` und `/.well-known/oauth-…` durchreichen (Standard, wenn alles an Kladde geht); `PUBLIC_URL` sollte gesetzt sein, damit die OAuth-Adressen stimmen.

```bash
claude mcp add --transport http kladde https://notes.example.org/mcp
```

**Zur Verschlüsselung:** Liegt der Schlüssel im selben Volume wie die Datenbank, schützt das Kopien der Datenbank und Backups (NAS, Git), nicht einen vollständig übernommenen Server. Für mehr Schutz `DATA_KEY` als Secret übergeben. Den Schlüssel unbedingt sichern – ohne ihn sind die Notizen verloren.

---

## 📁 Projektstruktur

```
kladde/
├── packages/
│   ├── shared/   # Typen, Markdown-Metadaten, Aufgaben-Parser (Fälligkeit/Wiederholung), Abfragesprache
│   ├── server/   # Express + node:sqlite: Passkeys (SimpleWebAuthn), Sync, Freigaben, Dateien, Telegram-Admin
│   └── client/   # React 18 + Vite + Tailwind + CodeMirror 6, IndexedDB-Sync, PWA
├── scripts/      # release.mjs, build-desktop.mjs, docker-entrypoint.sh
├── Dockerfile
└── docker-compose.yml
```

### Sync-Protokoll (Kurzfassung)
- `GET /api/sync?since=N` → alle eigenen und geteilten Notizen mit `seq > N`, entzogene Freigaben, neuer Cursor
- `POST /api/sync` mit `{ changes: [{ id, baseVersion, path, content, deleted }] }` → je Notiz `ok` (neue Version), `conflict` (Serverstand) oder `forbidden`
- `GET /api/events` (SSE) meldet `changed`, damit andere Geräte sofort nachladen
