# Guidelines for AI Agents Working on Kladde

## Project Overview
Self-hosted, offline-first Markdown notes app (PWA) with npm workspaces, a hardened Docker image, invites, optional GitLab sign-in and a release script.

## Monorepo Architecture
- `packages/shared`: Pure logic without browser or node dependencies: sync contracts (`types.ts`), Markdown metadata/frontmatter (`markdown.ts`), task parsing/recurrence (`tasks.ts`), the query language (`query.ts`), PARA roles and Zettel ids (`para.ts`), link resolution/backlinks/mentions/graph (`links.ts`), templates and the weekly review.
- `packages/server`: Express + `node:sqlite`. Passkey auth (`auth.ts`, SimpleWebAuthn), GitLab OAuth sign-in (`gitlabAuth.ts`, identities in `external_logins`), `NoteStore` (encrypted notes, global seq cursor, shares, public links), `FileStore` (encrypted attachments), `ExportMirror` (plain Markdown to `EXPORT_DIR`), admin area (`admin/adminRouter.ts`), `mcp/` (MCP endpoint `/mcp` with OAuth 2.1 + personal tokens in `McpTokenStore`; tools in `mcp/tools.ts` see only the token owner's own notes via `NoteStore.ownedNotes` and write through `NoteStore.push`).
- `packages/client`: React 18 + Vite + Tailwind + CodeMirror 6. `data/vault.ts` is the offline store (IndexedDB) and sync engine; `editor/livePreview.ts` builds all decorations in one StateField (block widgets need it).

## Key Rules & Contracts
1. **Encryption at rest:** never store note paths/contents or attachments unencrypted in the database or `data/files`; use `DataCipher` with the record id as AAD.
2. **Spaces:** every query on notes must check ownership or a share (`NoteStore.accessOf`). Only owners rename, move or delete.
3. **Sync:** every accepted change takes the next global `seq`; clients pull `seq > cursor`. Conflicts never lose text: the client three-way merges against `LocalNote.base` (`merge3` in `shared/merge.ts`); only overlapping word edits fall back to "server wins, local copy is kept". Presence (who has a note open) lives in memory in `server/Presence.ts` and reaches clients as the SSE event `presence`; cursors (`POST /presence/cursor`, SSE `cursor`) carry the text before them so `resolveCursor` finds the spot in a slightly different text (`client/editor/remoteCursors.ts`).
4. **Theming:** colors only through the CSS variables in `client/src/index.css` (Tailwind maps them); new themes override variables only. There are two themes: `light` and `material` (the dark theme; `system` picks one, stored `dark`/`oled` choices map to `material`). Exception: the Material theme also has its own layout (`views/MaterialShell.tsx`, chosen in `Shell` via `useResolvedTheme`) and Material 3 component shapes under `[data-theme='material']` in `index.css`.
5. **Schema:** add numbered migrations in `server/src/db.ts`, never edit a released one.
6. **Links:** resolve `[[links]]` only through `LinkIndex` (title, frontmatter `id`, Zettel id prefix); renaming a note must keep rewriting links (`vault.update` → `relink`).
7. **Commands:** `npm run build`, `npm run test`, `npm run dev`.
8. **Versioning & Changelog:** one SemVer version for the monorepo; user-facing changes go (German) under `## [Unveröffentlicht]` in `CHANGELOG.md`; release with `npm run release -- patch|minor|major`.

## Git
The project works on a single branch: **`main`** on GitHub (`origin`). There is no `develop` and no feature/release branches (the owner decided this on 2026-11-08; Git Flow may come back later).

Rules for agents:
1. Commit finished, building work directly on `main` (`npm run build` and `npm run test` must pass first). Commit or push only when the user asks for it.
2. Commit messages in English, Conventional Commits (`feat:`, `fix:`, `perf:`, `docs:`, `chore:`, `ci:`; `!` or a `BREAKING CHANGE:` footer for breaking changes), ending with the attribution lines the session asks for. The type decides the release (below), so pick it carefully.
3. Never rewrite history on `main` (no amend of pushed commits, no reset, no force).
4. Changelog entries (German) go under `## [Unveröffentlicht]` in `CHANGELOG.md`.
5. Run `git pull --rebase` before committing: the pipeline pushes release commits to `main`.

### Releasing and deploying (automatic)
