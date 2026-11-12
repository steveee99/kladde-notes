# Contributing to Kladde

Thanks for your interest! Bug reports, ideas and pull requests are welcome.

## Before you start

- For bigger changes, open an issue first so we can agree on the direction.
- Security problems: do **not** open an issue, see [SECURITY.md](SECURITY.md).
- Be kind. See the [Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

Requirements: Node.js ≥ 22.13 (for `node:sqlite`) and npm ≥ 9.

```bash
git clone https://github.com/steveee99/kladde-notes.git
cd kladde-notes
npm install
npm run dev
```

The frontend runs on <http://localhost:5174>, the backend on <http://localhost:3002>. See the [README](README.md#local-development) for the dev login and how to reset local data.

The code is a TypeScript monorepo (`packages/shared`, `packages/server`, `packages/client`). [AGENTS.md](AGENTS.md) describes the architecture and the rules that must hold (encryption at rest, per-user spaces, sync contract, numbered migrations, theming through CSS variables). Please read it before touching those areas.

## Making a change

1. Fork the repository and create a branch from `main`.
2. Keep the change focused. Add or update tests for behaviour changes (`packages/*/tests`, Vitest).
3. Make sure everything passes:

   ```bash
   npm run lint
   npm run build
   npm run test
   ```

4. Add a line for user-visible changes under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
5. Open a pull request against `main` and fill in the template.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/), in English: `feat:`, `fix:`, `perf:`, `docs:`, `chore:`, `ci:`. Use `!` or a `BREAKING CHANGE:` footer for breaking changes. The release tooling derives the version bump from these prefixes.

## Translations

The UI strings live in `packages/client/src/lib/i18n.ts`. Improvements to wording and new languages are welcome.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
