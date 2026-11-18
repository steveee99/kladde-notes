# Importing with the CLI (Obsidian, Markdown, images, PDF)

[Deutsch](IMPORT.de.md)

With the import CLI you bring a local folder – for example an Obsidian vault – into your Kladde space without needing access to the server. The CLI runs on your computer and talks to your Kladde through a separate, narrowly scoped import API. It shows a preview before the import and asks for confirmation.

## 1. Create an import token

1. In Kladde open **Settings → Import**.
2. Enter a name (e.g. "Laptop"), choose how long the token stays valid (7, 30, 90 or 365 days, default 30) and choose **Create token**.
3. Copy the token (it starts with `kli_`) right away – it is shown **only this once**. Kladde stores only a hash of it.

A token expires after the chosen time and stops working. Each account has at most 5 valid import tokens; expired ones do not count.

An import token can do only three things: list the paths of your own notes, upload attachments and create new notes. It cannot read, change or delete notes and works nowhere else in the API (not for MCP either).

## 2. Build the project

The CLI is part of the Kladde repository and needs Node.js 22 or newer:

```bash
git clone <Kladde repository>
cd kladde
npm ci
npm run build
```

## 3. Run the CLI

```bash
export KLADDE_IMPORT_TOKEN=kli_…
npm run import -- <folder> [<target folder>] --url <Kladde URL> [--dry-run] [--yes] [--allow-insecure]
```

- `<folder>`: the local folder, read recursively.
- `<target folder>`: the folder in the space that the notes go into (default: top level). `.kladde` is reserved.
- `--url`: the address of your Kladde, e.g. `https://kladde.example.org` (http or https).
- `--dry-run`: only shows the preview and writes nothing.
- `--yes`: imports without asking (needed when the CLI does not run in a terminal, e.g. in a script).
- `--allow-insecure`: allows an `http://` address. Without https the token would travel in cleartext, so the CLI stops on `http://` without this option and warns on every run with it. You need it for a local development instance (e.g. `http://localhost:3002`); for a Kladde on the network use https.
- `--help`: shows the help.

If `KLADDE_IMPORT_TOKEN` is not set, the CLI asks for the token in the terminal without echoing it. The token is never written to disk and never printed.

Example:

```bash
KLADDE_IMPORT_TOKEN=kli_… npm run import -- ~/Obsidian/Vault Import --url https://kladde.example.org --dry-run
```

The preview looks like `git status`: groups for new notes, new attachments, skipped notes (path exists) and ignored files, followed by the totals. Without `--dry-run` the question `Import? [y/N]` follows; only `y`, `yes` (or the German `j`, `ja`) starts the import. At the end the CLI sums up how many notes were created and skipped, how many attachments were uploaded and how many files were ignored, and lists errors one by one. If there were errors, it exits with code 1.

## What gets imported

- **Notes**: files ending in `.md`, `.markdown` or `.txt`. Subfolders are kept; every note is saved as `.md`, e.g. `Vault/Travel/Rome.markdown` → `<target folder>/Travel/Rome.md`. The file's modification time becomes the note's date.
- **Attachments**: images (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.avif`) and PDFs – but **only if a newly created note links to them**, by Markdown link or image (`![alt](images/photo.png)`) or Obsidian embed (`![[photo.png]]`, `![[photo.png|Caption]]`). Afterwards the links in the note point to the uploaded attachment. If the path is ambiguous, the CLI looks for a unique file with the same name in the folder.
- **Ignored**: hidden files and folders (e.g. `.obsidian`, `.git`), symbolic links, `node_modules`, all other file types (e.g. `.docx`) and images or PDFs that no new note links to.
- **Limits**: notes over 2 MB and attachments over 25 MB are reported as errors and not sent.

## Existing paths are never overwritten

If the space already has a note with the same path (case-insensitive), the file is skipped. The server checks again when writing: a note created between the preview and the import is skipped as well. The CLI never changes, moves or deletes an existing note. A second run over the same folder therefore reports everything as skipped and uploads no attachment again.

The imported notes sync like any other change and appear in open Kladde windows without reloading.

## Revoke a token

**Settings → Import** lists every token with its creation, expiry and last-used date. The trash icon (with confirmation) revokes it; the CLI then gets `Import token invalid, revoked or expired`. A suspended account cannot use its tokens either.

## Error messages

| Message | Meaning |
| --- | --- |
| `Import token invalid, revoked or expired` | Token mistyped, revoked, expired or account suspended |
| `Unencrypted connection …` | `--url` starts with `http://`: switch to https or pass `--allow-insecure` on purpose |
| `Kladde at … is not reachable` | Wrong address, server down or no Kladde answers at that address |
| `Please give the address … with --url` / `Invalid --url …` | `--url` is missing or not an http/https address |
| `Folder not found` / `Not a folder` | The source path does not exist or is a file |
