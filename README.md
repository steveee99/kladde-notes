# Kladde

[English](README.md) · [Deutsch](README.de.md)

**Kladde** is a self-hosted notes app for the browser: Markdown with live preview, tasks with due dates and recurrence, queries and Kanban boards across your own notes. It works offline on phone, iPad and desktop and syncs as soon as you are back online. Access is by invitation only, with **passkeys**, optionally **GitLab sign-in**, or username and password where passkeys are not an option (local network without HTTPS).

![Kladde: a project note with properties, tasks with status and due dates, and an editable table](docs/images/screenshot.png)

<table>
  <tr>
    <td width="50%"><img src="docs/images/home-light.png" alt="Home screen in the light color scheme: tasks grouped by overdue, today and upcoming"></td>
    <td width="50%"><img src="docs/images/graph.png" alt="Knowledge graph of linked notes"></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/images/phone-home.png" alt="Home screen on a phone" width="260"></td>
    <td align="center"><img src="docs/images/phone-note.png" alt="Editing a note on a phone" width="260"></td>
  </tr>
</table>

> A *Kladde* (German) is the notebook where everything goes first, before it is written up properly.

The app and its UI are available in **English and German**; the guides in `docs/` exist in both languages.

---

## ✨ Features

| Area | What you get |
| --- | --- |
| **Access** | Invitation code → username → passkey or password. Optional "Sign in with GitLab" (GitLab.com or your own instance, restrictable to groups). More devices via a one-time code (15 min) or an additional passkey. Sessions as httpOnly cookie |
| **Administration** | In the app for admins: accounts, password reset, device codes, admin role, blocking, invitations, audit log. The oldest account is the admin |
| **Spaces** | Every user has their own space, no access to other people's notes |
| **Sharing** | Share single notes or **whole folders** (with rights to read, edit, create, delete), or a public read-only link for guests (`/s/…`) |
| **Comments** | Select text and comment on it (`Ctrl/⌘+Alt+C`): threads anchored to the passage (found again after edits), highlighted in the note and listed in the side panel (a sheet on phones) with replies, resolve and reopen; visible to everyone who sees the note, never in exports or public links |
| **Mentions** | `@username` suggests the people who can see the note and shows as a chip with their picture; the person gets a notification in the app and by Web Push, with a link to the passage; "Assigned to me" on the task page lists tasks that mention you |
| **Activity** | Groups and shared folders have an activity page: who created, edited (grouped per person and hour), moved, deleted, restored or released notes, and who joined or left; notes someone else changed since you last opened them carry a dot in the folder tree and lists |
| **Editor** | CodeMirror 6 with live preview: Markdown syntax is only visible on the cursor line; **slash commands** (`/`) for blocks, diagrams, tables, queries and file upload; footnotes (`[^1]`) |
| **Formulas** | `$…$` and `$$…$$` rendered with KaTeX (bundled, no CDN) in the editor and on public links, as Word equations and in the PDF export; `/math` |
| **Side by side** | On wide screens Ctrl/⌘+click on a link (or "Open to the side" in the folder tree) opens a second note next to the current one, with its own history and side panel; resizable and swappable |
| **Account export** | Settings → Export account: all your notes, attachments, templates, settings and shares (optionally the history) as a ZIP, built in the background and importable into another Kladde |
| **Tables & diagrams** | GFM tables as interactive tables (sort, filter) that can be edited right in the preview: click a cell (Tab/Enter moves on), insert/rename/remove columns, add/remove rows. In the Markdown view it stays plain text. Mermaid diagrams (` ```mermaid `) and mind maps (` ```mindmap `) rendered in place |
| **Queries & Kanban** | ```` ```query ```` blocks: `TABLE`, `LIST`, `TASKS` and **`KANBAN`** (`KANBAN BY status VALUES "open", "doing", "done"`) with interactive drag and drop; `GROUP BY` and the aggregates `COUNT`, `SUM`, `AVG`, `MIN`, `MAX` (`TABLE status, COUNT, SUM(hours) GROUP BY status`) |
| **Tasks** | `- [ ] Text 📅 2026-11-30 🔁 monthly`, or phone-friendly `due:tomorrow every:week` (also `due:friday`, `due:in-3-days`, `due:next-week`, `due:end-of-month`); subtasks with progress and dependencies (`🆔 id`, `⛔ id`); statuses (open, in progress, blocked, done); free tasks on the home page without a note; a **task page** (`/tasks`) with list and Kanban, filters and a tasks tab in the note side panel; quick menu for due dates (today/tomorrow/week); double-click jumps to the source note |
| **Calendar** | `/calendar` with month, week and agenda views of due tasks (with reminder time), daily notes and notes with a `date:`/`deadline:` property; drag a task to another day to reschedule it, click a day to open its daily note; filters by status, folder and tag; the activity heatmap below it |
| **PARA** | Folders Inbox, Projects, Areas, Resources, Archive. **Inbox as a work list** (`/inbox`): every thought is its own note and becomes a project, area, resource, Zettel or archive item with one click. **Projects** with `status: active/paused/done`; "Complete" sets the status and date and moves the note to the archive, "Restore" moves it back. Archive whole folders. Active projects on the home screen, with a hint when there is no next step |
| **Daily, weekly & monthly notes** | A daily note per day (`Ctrl/⌘+Shift+D`) with date navigation and carried-over tasks; opt-in weekly (`2026-W47`, `Ctrl/⌘+Alt+W`) and monthly notes (`2026-11`, `Ctrl/⌘+Alt+M`), each with its own folder, naming pattern and template (`{{days}}`, `{{weeks}}` link the days and weeks), linked from day to week to month |
| **Zettelkasten** | Zettel dialog with type (fleeting, literature with source, permanent) and a fixed ID in the frontmatter; `[[ID]]` and `[[ID Title]]` stay valid after renaming. Hint for unconnected Zettel |
| **Linking** | `[[Wikilinks]]` with autocomplete; **all links are updated when you rename a note**; backlinks; **unlinked mentions** with a "Link" button; `#tags`; frontmatter as a properties bar |
| **Search, commands & tabs** | Command palette (`Ctrl/⌘+K`): notes, open tasks and commands in one list (`>` lists only commands). On the desktop every open note gets a tab above the content. Favorites (opt-in): star in the note header or `Ctrl/⌘+D`, collapsible list in the sidebar |
| **Tickets & milestones** | Opt-in under Settings → Features (switchable per group). "Make project" turns a folder into a project with a key such as `KLD`: notes in it are tickets with a running number, status, priority, milestone, assignee and estimate, shown on a board, a backlog and a roadmap. Ticket numbers (`KLD-118`) in any note become status chips; everything stays plain Markdown, and AI assistants can work with tickets over MCP |
| **Knowledge graph** | Graph of all notes (`/graph`, colored by PARA role, zoomable and draggable) and a local graph below every note |
| **Version history** | History per note with up to 100 versions on the server; diff view with added/removed lines (`git diff` style) or rendered text; restore with a click |
| **Recipe import** | Import recipes by link (schema.org, e.g. from recipe sites and food blogs) into `3 Resources/Recipes`: ingredient table, numbered steps, source |
| **Web clipper** | "New note → Web page" or a bookmarklet saves an article (or just the selected text) as Markdown in the inbox, with source, author and date; images optionally as attachments |
| **AI & MCP** | MCP server (`/mcp`, Streamable HTTP) for assistants such as Claude Desktop, Claude Code, Cursor: OAuth 2.1 or personal access tokens; access limited to your own notes |
| **AI memory** | Opt-in folder (`AI-Memory`) where assistants of any provider and you build knowledge in an OKF-compatible format; Kladde checks it, stamps who changed what, keeps index and log, and hands notes of type `Rule` to every connected assistant |
| **Apple Shortcuts** | Token-protected API (`/api/shortcuts`) for the iOS Shortcuts app: save links, text, photos and PDFs from the share sheet, quick notes into the daily note, new tasks, and a morning automation with the tasks due today. See [docs/SHORTCUTS.md](docs/SHORTCUTS.md) |
| **Weekly review** | Opt-in under Settings → Features. `/review`: inbox, overdue tasks, projects without a next step, dormant areas, old fleeting and unconnected Zettel; reminder after 7 days |
| **Presentations** | Opt-in under Settings → Features. "Start presentation" in the note menu shows the note as full-screen slides (`---` after an empty line starts a slide, otherwise every `#`/`##` heading; speaker notes after `Note:`), in the format chosen on the note (`presentation: 4:3`, default 16:9), with keyboard, swipe and presenter remote navigation; "Presentation (.pdf)" exports one page per slide. Public links of such notes can be presented too |
| **Callouts** | On by default (Settings → Features). `> [!warning] Title` quotes (Obsidian syntax) show as colored boxes with an icon per type; `-`/`+` after the type makes them collapsible (collapsed/expanded). `/callout` inserts one; public links, PDF and Word show them the same way |
| **Variables** | Folders and groups define variables that subfolders inherit and can override; `{{var:name}}` in notes, templates, links and exports always shows the current value ([guide](docs/VARIABLES.md)) |
| **Note types** | Model your own types: properties, where they show and whether the frontmatter is visible; notes and templates use them with `type: custom:<name>` ([guide](docs/NOTE_TYPES.md)) |
| **GitLab/GitHub notes** | A note shows a Markdown document from GitLab or GitHub, always loaded live and read-only; the address may contain variables. The access token is set on the container or in the administration and applies to everyone ([guide](docs/REMOTE_NOTES.md)) |
| **Templates** | Your own templates under Settings → Templates (`{{title}}`, `{{date}}`, `{{zid}}`), with a default target folder and encrypted sync |
| **Media** | Images and PDFs by paste, drag and drop or button; image grid with ```` ```gallery ```` and carousel with ```` ```carousel ````; embedded PDF viewer and PDF notes; **voice notes** (record in Quick Capture or with `/audio`, optional transcription); attachments also work offline; code blocks with syntax highlighting and copy button |
| **Offline & sync** | IndexedDB per account, sync via cursor + versions; concurrent changes (another device, another person, offline edits synced later) are merged with a three-way merge, line by line and word by word within a paragraph; only if both change the same words, the local text is kept as a "(Conflict …)" copy; live updates via Server-Sent Events |
| **Collaboration** | Real-time co-editing (shared notes and your own devices/tabs): changes appear immediately in the open editor without cursor or undo history jumping; avatars with "Live" in the note header show who has the note open; colored remote cursors and selections in the editor |
| **App & design** | PWA (installable, service worker), "Werkbank" design in dark and light with a choice of accent color (icon rail, collapsible folder panel and status bar on the desktop, a navigation bar on phones); note lists switchable between tiles, list and table |
| **Security** | Notes (path + content) and attachments AES-256-GCM encrypted on the server, origin checks, rate limits, audit log, hardened container |
| **NAS** | Optional plain-text mirror of all notes as `.md` files to `EXPORT_DIR` (e.g. a mounted NAS share) |

### Not implemented yet (roadmap)
- End-to-end encryption (key only in the browser) and encryption of the local IndexedDB

---

## 🚀 Local development

Requirements: Node.js ≥ 22.13 (for `node:sqlite`), npm ≥ 9.

```bash
npm install
npm run dev
```

- Frontend (Vite): http://localhost:5174, proxies `/api` to the server
- Backend: http://localhost:3002
- **Dev login:** locally the sign-in page has a "Dev login" button (user `dev`, only with `DEV_LOGIN=1` and outside production)
- On first start the server writes an invitation link to the log (`✉️ Erste Einladung …`). Passkeys work on `localhost` without HTTPS
- Start over: delete `packages/server/data/`
- **Online mode:** `npm run dev:online` starts the same with `KLADDE_MODE=online`
- **Test data:** `npm run build`, then `npm run seed -- --notes 20000` adds a large vault with links and tasks to the account `dev`;
  `--group Team --members 50` puts it into a group with the accounts `user01`…`user50` (password `kladde-test`), `--help` lists the options

```bash
npm run build   # shared → server → client
npm run test    # query language, tasks, note/user store, sync, MCP, import, …
npm run test:e2e   # browser tests (Playwright; after npm run build and once npx playwright install chromium)
npm run lint
npm run build:demo   # browser-only demo without server → packages/client/dist-demo
```

**Demo:** `npm run build:demo` builds a version that runs entirely in the browser (no server, no sync: notes stay in the visitor's browser; sharing, attachments, history and AI access are off). `.github/workflows/pages.yml` publishes it on GitHub Pages for every push to `main` (enable *Settings → Pages → Source: GitHub Actions* once). `DEMO_BASE` sets the sub path (default `/kladde-notes/`).

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute and [AGENTS.md](AGENTS.md) for the architecture and rules of the codebase.

---

## 🖥️ Standalone desktop mode (single file / Windows `.exe`)

Kladde can be built as a standalone desktop program without Docker and without user management (**Node.js SEA** + a dedicated Microsoft Edge `--app` window, alternatively Chrome or the system browser):

```bash
git clone https://github.com/steveee99/kladde-notes.git && cd kladde-notes
npm install
npm run build:desktop   # native binary for the current OS (dist/kladde or dist/kladde.exe)
npm run build:exe       # Windows executable dist/kladde.exe (on macOS/Linux including a download of node.exe)
```

- **No login / no user management:** a local single user (`lokal`) is created automatically on first start; invitations, passkeys, the admin area and multi-user/link sharing are disabled.
- **Local storage (outside the `.exe`):**
  - Windows: `%LOCALAPPDATA%\Kladde\` (`kladde.sqlite`, `secret.key`, `files\`, `backups\`, `kladde.log`)
  - macOS: `~/Library/Application Support/Kladde/` · Linux: `~/.local/share/kladde/`
  - **Portable mode:** if a folder `kladde-data` exists next to `kladde.exe` (or `--portable-data` is passed), all data goes there instead of the user profile.
- **Updates by replacing the `.exe`:** close the old `kladde.exe`, copy the new one over it and start it. Existing encrypted notes are kept; before schema migrations an SQLite backup is created automatically under `backups\`.
- **Options:** `--data-dir=<path>`, `--portable-data`, `--port=<n>` (default `34172`), `--server-only` (local server only, no browser window).

---

## 🐳 Running with Docker

```bash
git clone https://github.com/steveee99/kladde-notes.git && cd kladde-notes
PUBLIC_URL=https://notes.example.org docker compose up --build -d
docker logs kladde   # contains the first invitation
```

The app then runs on port `13002`. **Passkeys need HTTPS** (except on localhost) and are bound to the domain from `PUBLIC_URL`. Run the app behind a reverse proxy (Caddy, nginx, Traefik) and set `TRUST_PROXY=1`; step by step, including home networks without a public address: [`docs/installation/HTTPS.md`](docs/installation/HTTPS.md). Without HTTPS (e.g. directly via `http://192.168.1.10:13002` in your home network) you sign in with username and password.

CLI tool (import/export, search, attachments, backup and administration). The German command names of earlier versions (`hilfe`, `einladen`, …) still work:

```bash
docker exec kladde node packages/server/dist/cli.js help
docker exec kladde node packages/server/dist/cli.js import /import/folder Projects --overwrite
docker exec kladde node packages/server/dist/cli.js export / /export/space --with-files
docker exec kladde node packages/server/dist/cli.js invite Anna   # create an invitation
```

Without access to the server you can import a local folder (e.g. an Obsidian vault) with the import CLI and an import token from the settings: `npm run import -- <folder> --url <Kladde URL>`. Guide: [`docs/IMPORT.md`](docs/IMPORT.md).

| Variable | Meaning |
| --- | --- |
| `PUBLIC_URL` | Public address; sets the passkey domain and builds invitation links |
| `TRUST_PROXY` | `1` behind a reverse proxy |
| `DATA_KEY` | Encryption key (`openssl rand -base64 32`). Empty = key file `data/secret.key` in the volume |
| `SIGNUP_WITHOUT_INVITE` | Sign-in methods that create new accounts **without an invitation**: comma-separated `gitlab`, `passkey`, `password` or `all`. Empty = every new account needs an invitation. For passkey/password the sign-in page then shows "Create new account" |
| `GITLAB_URL` | GitLab instance for "Sign in with GitLab" (default `https://gitlab.com`) |
| `GITLAB_INTERNAL_URL` | Optional: address the container uses to reach GitLab if it differs from `GITLAB_URL` (e.g. `http://192.168.1.20`) |
| `GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET` | OAuth application from GitLab; both set = GitLab sign-in enabled |
| `GITLAB_ALLOWED_GROUPS` | Only members of these groups (comma-separated paths, e.g. `family,company/team`; subgroups count), empty = everyone |
| `GITLAB_ALLOW_SIGNUP` | Older spelling of `SIGNUP_WITHOUT_INVITE=gitlab` (keeps working) |
| `GITLAB_LABEL` | Button label, e.g. the name of your own instance (default `GitLab`) |
| `REMOTE_GITLAB_URL`, `REMOTE_GITLAB_TOKEN`, `REMOTE_GITHUB_URL`, `REMOTE_GITHUB_TOKEN` | Read access for [GitLab/GitHub notes](docs/REMOTE_NOTES.md), for every user; tokens also as `…_TOKEN_FILE`. `REMOTE_GITLAB_PUBLIC=1`/`REMOTE_GITHUB_PUBLIC=1`: public projects without a token |
| `REMOTE_ALLOWED_PATHS` | Groups or repositories users may read with it (comma-separated), empty = whatever the token can read |
| `BACKUP_KEEP` | Default for the daily full backup (database and encrypted attachments) in `data/backups`: how many to keep (default 7, `0` = off). Can be changed under Settings → Administration → Backups |
| `BACKUP_DIR` | Where backups are stored (default `data/backups`) |
| `EXPORT_DIR` | Plain-text mirror of the notes (e.g. NAS), empty = off |
| `KLADDE_MODE` | `offline` (default): every device keeps a full offline copy of the notes. `online` (experimental, for teams that are always online with very large vaults): devices keep only a list of the notes and load a note's text when it opens; nothing can be read without a connection except notes opened before. The server searches every note, finds backlinks and mentions and sends the tasks of every note; database tables and ticket projects load their notes in full; the server also builds the graph and runs query blocks (at most 2,000 rows each) |
| `TRASH_RETENTION_DAYS` | Days deleted notes stay in the trash before they are purged (default 30, `0` = until emptied by hand) |
| `STORAGE_QUOTA_MB` | Optional default storage limit per account and group in MB (notes, attachments, history and trash count; unset or `0` = unlimited). Uploads over the limit are refused with a clear message (offline uploads stay queued). Admins see the usage and set own limits under Settings → Administration |
| `TRANSCRIBE_URL` | Optional speech-to-text for voice notes: an OpenAI-compatible transcription endpoint you run yourself, e.g. a local Whisper (`http://whisper:8000/v1/audio/transcriptions`). Unset = no transcription; recordings never go to a third-party service by default. `TRANSCRIBE_MODEL` (default `whisper-1`) and `TRANSCRIBE_API_KEY` are optional |
| `OCR` | `true` turns on text recognition (OCR) for images and scanned PDF pages, so the full-text search finds their text too (Tesseract as WebAssembly, runs on the server, nothing leaves it; costs CPU, default off). The text of normal PDFs is always indexed. `OCR_LANGS` picks the languages: `deu`, `eng` or `deu+eng` (default) |
| `CONFLUENCE_ALLOW_PRIVATE` | `true` lets users connect a Confluence on a private address (e.g. an on-premise Data Center in the intranet). By default the Confluence sync only reaches public https addresses, with the same protections as the web clipper |
| `VAPID_SUBJECT` | Contact for Web Push services (`mailto:…` or `https://…`), sent with every reminder. Default: `PUBLIC_URL` if it is https |
| `PUSH_ALLOWED_HOSTS` | Extra push service hosts (comma-separated) besides Google, Mozilla, Apple and Microsoft; other endpoints are refused |
| `METRICS_TOKEN` | Optional Prometheus metrics on `/metrics` (requests and latencies, sync pushes/pulls, open live connections, push messages, attachment indexing and transcriptions, database and attachment size, last backup; no user or note data). Off unless set; Prometheus sends it as `Authorization: Bearer <token>` (at least 16 characters, e.g. `openssl rand -hex 24`) |
| `METRICS_PORT`, `METRICS_HOST` | Alternative: serve `/metrics` without a token on its own port for an internal network (e.g. `9464`, host default `127.0.0.1`; `0.0.0.0` in Docker). Never publish this port |

**Sign in with GitLab** (detailed guide for self-hosted instances, networking, custom certificates and troubleshooting: [`docs/GITLAB.md`](docs/GITLAB.md)):

1. Create an OAuth application in GitLab: *User settings → Applications* (just for you), or *Group → Settings → Applications*, or *Admin → Applications* (own instance).
   - **Redirect URI:** `https://notes.example.org/api/auth/gitlab/callback` (that is `PUBLIC_URL` + `/api/auth/gitlab/callback`)
   - **Confidential:** yes · **Scopes:** `openid` and `profile`
2. Set the *Application ID* and *Secret* as variables, e.g. in an `.env` next to `docker-compose.yml`:

   ```env
   PUBLIC_URL=https://notes.example.org
   GITLAB_URL=https://gitlab.com            # or https://gitlab.example.org
   GITLAB_CLIENT_ID=…
   GITLAB_CLIENT_SECRET=…
   GITLAB_ALLOWED_GROUPS=family             # optional
   ```

3. `docker compose up -d`. The sign-in page now shows "Sign in with GitLab".

Existing accounts link GitLab under *Settings → Sign in with GitLab*; after that the GitLab button is enough. New people register through their invitation link with "Register with GitLab" (username = GitLab name), or without an invitation if `SIGNUP_WITHOUT_INVITE` contains `gitlab`. Blocked accounts stay blocked; a link can only be removed while a passkey or password remains.

**AI assistants (MCP):** an MCP server (Streamable HTTP) runs at `PUBLIC_URL/mcp`. Clients such as claude.ai, Claude Desktop or Claude Code sign in via OAuth 2.1 (dynamic registration, PKCE, consent with the normal Kladde login) or with an access token from Settings → Features → AI assistants → Settings (`Authorization: Bearer kld_…`). Every connection only sees the notes of its own account. The reverse proxy must forward `/mcp`, `/oauth/…` and `/.well-known/oauth-…` to the app (the default if everything goes to Kladde); `PUBLIC_URL` should be set so that the OAuth addresses are correct.

**AI memory:** with Settings → Features → AI memory turned on, assistants learn about the folder (default `AI-Memory`) when they connect and save knowledge there with `memory_save`; notes of type `Rule` in it are sent along with the MCP instructions (and as the resource `kladde://memory/rules` and the prompt `memory_rules`). The connection's name (OAuth client or token name) becomes `generated.by`, so give personal tokens a recognizable name.

```bash
claude mcp add --transport http kladde https://notes.example.org/mcp
```

**About encryption:** if the key lives in the same volume as the database, it protects copies of the database and backups (NAS, Git), but not a fully compromised server. For more protection pass `DATA_KEY` as a secret. Back the key up: without it the notes are lost.

**Backups:** under Settings → Administration → Backups admins see all backups with date and size, take one with "Back up now", set the daily backup and how many to keep, download a backup as a `.tar` archive and restore one. A backup holds the database and the attachments and profile pictures, all still encrypted; attachments are hard-linked, so daily backups take little extra space. **The key is never part of a backup** – keep `DATA_KEY` or `data/secret.key` somewhere else, without it a backup cannot be read. A restore first backs up the current state, then restarts the server (the Docker restart policy starts it again) and swaps in the backup before the database opens; it is recorded in the audit log. To restore a downloaded archive by hand, stop the container, unpack it, and copy `kladde.sqlite`, `files/` and `avatars/` into the data volume (removing `kladde.sqlite-wal` and `kladde.sqlite-shm`).

---

## 📁 Project structure

```
kladde/
├── packages/
│   ├── shared/   # types, Markdown metadata, task parser (due date/recurrence), query language
│   ├── server/   # Express + node:sqlite: passkeys (SimpleWebAuthn), GitLab OAuth, sync, sharing, files
│   └── client/   # React 18 + Vite + Tailwind + CodeMirror 6, IndexedDB sync, PWA
├── scripts/      # release.mjs, build-desktop.mjs, docker-entrypoint.sh
├── Dockerfile
└── docker-compose.yml
```

### Sync protocol (short version)
- `GET /api/sync?since=N` → all own and shared notes with `seq > N`, revoked shares, new cursor
- `POST /api/sync` with `{ changes: [{ id, baseVersion, path, content, deleted }] }` → per note `ok` (new version), `conflict` (server state) or `forbidden`
- `GET /api/events` (SSE) reports `changed` so that other devices reload immediately

---

## 🤝 Contributing & security

Contributions are welcome, see [CONTRIBUTING.md](CONTRIBUTING.md). Please report security issues privately as described in [SECURITY.md](SECURITY.md). Release notes are in [CHANGELOG.md](CHANGELOG.md).

## 📄 License

[MIT](LICENSE) © Stefan Stumpf
