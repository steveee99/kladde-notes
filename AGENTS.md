# Guidelines for AI Agents Working on Kladde

## Project Overview
Self-hosted, offline-first Markdown notes app (PWA). Infrastructure (npm workspaces, Docker hardening, invites, Telegram admin bot, release script) is carried over from the sibling project Project Gamma (`../project-gamma`).

## Monorepo Architecture
- `packages/shared`: Pure logic without browser or node dependencies: sync contracts (`types.ts`), Markdown metadata/frontmatter (`markdown.ts`), task parsing/recurrence (`tasks.ts`), the query language (`query.ts`), PARA roles and Zettel ids (`para.ts`), link resolution/backlinks/mentions/graph (`links.ts`), templates and the weekly review.
- `packages/server`: Express + `node:sqlite`. Passkey auth (`auth.ts`, SimpleWebAuthn), `NoteStore` (encrypted notes, global seq cursor, shares, public links), `FileStore` (encrypted attachments), `ExportMirror` (plain Markdown to `EXPORT_DIR`), Telegram admin.
- `packages/client`: React 18 + Vite + Tailwind + CodeMirror 6. `data/vault.ts` is the offline store (IndexedDB) and sync engine; `editor/livePreview.ts` builds all decorations in one StateField (block widgets need it).

## Key Rules & Contracts
1. **Encryption at rest:** never store note paths/contents or attachments unencrypted in the database or `data/files`; use `DataCipher` with the record id as AAD.
2. **Spaces:** every query on notes must check ownership or a share (`NoteStore.accessOf`). Only owners rename, move or delete.
3. **Sync:** every accepted change takes the next global `seq`; clients pull `seq > cursor`. Conflicts never lose text (server wins, local copy is kept).
4. **Theming:** colors only through the CSS variables in `client/src/index.css` (Tailwind maps them); new themes override variables only.
5. **Schema:** add numbered migrations in `server/src/db.ts`, never edit a released one.
6. **Links:** resolve `[[links]]` only through `LinkIndex` (title, frontmatter `id`, Zettel id prefix); renaming a note must keep rewriting links (`vault.update` → `relink`).
7. **Commands:** `npm run build`, `npm run test`, `npm run dev`.
8. **Versioning & Changelog:** one SemVer version for the monorepo; user-facing changes go (German) under `## [Unveröffentlicht]` in `CHANGELOG.md`; release with `npm run release -- patch|minor|major`.

## Git
For now the project works on a single branch: **`main`**, kept up to date locally. There is no remote, no `develop` and no feature/release branches (the owner decided this on 2026-11-08; Git Flow from Project Gamma may come back later).

Rules for agents:
1. Commit finished, building work directly on `main` (`npm run build` and `npm run test` must pass first). Commit only when the user asks for it.
2. Commit messages in English, conventional style (`feat:`, `fix:`, `chore:`, `docs:`), ending with the attribution lines the session asks for.
3. Never rewrite history on `main` (no amend of pushed/shared commits, no reset, no force).
4. Changelog entries (German) go under `## [Unveröffentlicht]` in `CHANGELOG.md`.

### Releasing
```bash
npm run release -- patch|minor|major     # bumps all versions, moves "Unveröffentlicht" into a release
git commit -am "chore(release): vX.Y.Z" && git tag vX.Y.Z
```
