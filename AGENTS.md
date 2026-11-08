# Guidelines for AI Agents Working on Kladde

## Project Overview
Self-hosted, offline-first Markdown notes app (PWA). Infrastructure (npm workspaces, Docker hardening, invites, Telegram admin bot, release script, Git Flow) is carried over from the sibling project Project Gamma (`../project-gamma`).

## Monorepo Architecture
- `packages/shared`: Pure logic without browser or node dependencies: sync contracts (`types.ts`), Markdown metadata, task parsing/recurrence (`tasks.ts`), the query language (`query.ts`).
- `packages/server`: Express + `node:sqlite`. Passkey auth (`auth.ts`, SimpleWebAuthn), `NoteStore` (encrypted notes, global seq cursor, shares, public links), `FileStore` (encrypted attachments), `ExportMirror` (plain Markdown to `EXPORT_DIR`), Telegram admin.
- `packages/client`: React 18 + Vite + Tailwind + CodeMirror 6. `data/vault.ts` is the offline store (IndexedDB) and sync engine; `editor/livePreview.ts` builds all decorations in one StateField (block widgets need it).

## Key Rules & Contracts
1. **Encryption at rest:** never store note paths/contents or attachments unencrypted in the database or `data/files`; use `DataCipher` with the record id as AAD.
2. **Spaces:** every query on notes must check ownership or a share (`NoteStore.accessOf`). Only owners rename, move or delete.
3. **Sync:** every accepted change takes the next global `seq`; clients pull `seq > cursor`. Conflicts never lose text (server wins, local copy is kept).
4. **Theming:** colors only through the CSS variables in `client/src/index.css` (Tailwind maps them); new themes override variables only.
5. **Schema:** add numbered migrations in `server/src/db.ts`, never edit a released one.
6. **Commands:** `npm run build`, `npm run test`, `npm run dev`.
7. **Versioning & Changelog:** one SemVer version for the monorepo; user-facing changes go (German) under `## [Unveröffentlicht]` in `CHANGELOG.md`; release with `npm run release -- patch|minor|major`.

## Git Flow
The repo follows Git Flow. **`main` and `develop` are protected by convention: never commit or push to them directly, and never force-push.** (GitHub-side branch protection is not enabled because the repo is private on a free plan, so nothing technical stops a direct push; agents must not rely on that.) Every change reaches them through a pull request from a branch; PRs need a green CI run (`.github/workflows/ci.yml`: build + test).

| Branch | Branches off | Merges into | Purpose |
| --- | --- | --- | --- |
| `main` | – | – | Released versions only; every release is tagged `vX.Y.Z` |
| `develop` | – | – | Integration branch for the next release |
| `feature/<name>` (also `fix/<name>`) | `develop` | `develop` | New features and non-urgent fixes |
| `release/<x.y.z>` | `develop` | `main`, then back into `develop` | Stabilisation, version bump, release candidates |
| `hotfix/<name>` | `main` | `main`, then back into `develop` | Urgent production fixes |

Rules for agents:
1. Before starting work, make sure you are on a feature branch cut from an up-to-date `develop` (`git switch develop && git pull && git switch -c feature/<name>`). If the checkout is on `main` or `develop`, branch first.
2. Commit in English (conventional style: `feat:`, `fix:`, `chore:`), push the branch and open a PR against `develop` (hotfix: against `main`). Merge only via PR; do not merge or push to protected branches yourself unless the user asks.
3. Changelog entries (German) are added in the feature PR under `## [Unveröffentlicht]`.
4. Features merged into `develop` use squash or merge commits; `release/*` and `hotfix/*` PRs into `main` use a **merge commit** so `main` and `develop` stay related, and the tag lands on `main`.

### Releasing
```bash
git switch develop && git pull && git switch -c release/0.2.0
npm run release -- minor --rc            # 0.2.0-rc.1: bumps versions only, changelogs untouched
git commit -am "chore(release): v0.2.0-rc.1" && git tag v0.2.0-rc.1
# fixes for the candidate are committed on the release branch, then:
npm run release -- rc                    # 0.2.0-rc.2, rc.3, ...
npm run release -- final                 # 0.2.0: moves "Unveröffentlicht" into the changelogs
git commit -am "chore(release): v0.2.0"
```
Then open a PR `release/0.2.0` → `main` (merge commit), tag `v0.2.0` on `main`, and open a second PR `main` → `develop` (or `release/0.2.0` → `develop`) to carry the release commits and fixes back. Skip the RC steps for a plain release: `npm run release -- minor`. Release candidates are SemVer pre-releases (`x.y.z-rc.N`); while one is in flight only `rc` and `final` are accepted. Tag RCs on the release branch, never on `main`.
Hotfix: branch `hotfix/<name>` from `main`, fix, `npm run release -- patch`, PR into `main`, tag, back-merge into `develop`.


