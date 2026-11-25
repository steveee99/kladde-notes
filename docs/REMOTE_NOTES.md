# GitLab/GitHub notes

[Deutsch](REMOTE_NOTES.de.md)

A GitLab/GitHub note shows a Markdown document from a repository. By default Kladde loads it live each time the note opens and stores only its address; with **Sync regularly** the server keeps a copy instead (see below). The note is always read-only: edit the document at its source.

## Use

**New → GitLab/GitHub note**, the command palette, or `/gitlab` while writing (that also embeds it with `![[…]]`). The address is one you copy from the browser:

| Address | Shows |
| --- | --- |
| `https://gitlab.com/group/sub/project/-/blob/main/docs/a.md` (also `/-/raw/…`) | this file |
| `https://github.com/owner/repo/blob/main/a.md`, `https://raw.githubusercontent.com/…` | this file |
| `https://gitlab.com/group/project`, `https://github.com/owner/repo` | the README on the default branch |
| `…/tree/main/docs` | the README in this folder |

- The address may contain [variables](VARIABLES.md): `https://gitlab.com/{{var:customer}}/docs/-/blob/main/README.md`. Typing `{{` offers those of the folder.
- **Branch, tag or commit** overrides the one in the address. It is needed when a branch name with slashes is ambiguous (Kladde tries up to four readings of the address).
- Markdown and text files work (`.md`, `.markdown`, `.mdx`, `.txt`, README, LICENSE, …), up to 2 MB; images up to 10 MB.
- The bar above the text shows the source, branch, last commit and when it was loaded, with **Reload** and, for those who may write the note, **Edit source**. Title and folder change as usual.
- Relative links lead to the file on its host, relative images load through Kladde. `[[links]]`, embeds, queries, variables, tickets and mentions in the document are shown as plain text; its tasks and frontmatter do not count as yours. Its text is only searched when the note is synced.
- Word, PDF, Markdown export, printing and "Copy as Markdown" contain the current document.
- Public links, Confluence pages and the demo show a placeholder: neither the document nor its address leaves Kladde that way.
- Without a connection the document cannot be shown, unless the note is synced.

### Live or synced

The switch **Sync regularly** (when creating the note, or under **Edit source**) decides how the document gets into Kladde:

| | Live (default) | Synced |
| --- | --- | --- |
| When is it read | each time the note opens | by the server every `REMOTE_SYNC_HOURS` hours (default 6), and with **Sync now** |
| Stored | only the address | the address and an encrypted copy of the document on the server, delivered with the note to your devices |
| Search | not searched | found by the search (also in online mode and over MCP) |
| Offline | not shown | shown as of the last sync (images still need a connection) |

The bar above a synced note shows when it was synced; **Sync now** reads it at once for everybody who sees the note. When a sync fails, the previous copy stays and the bar says why. Only a changed document reaches the devices again, so unchanged documents cost no sync traffic. The copy belongs to the address: after the source changes, the new document is read right away. Turning the switch off deletes the copy.

In the file it is:

```yaml
---
type: remote
source: "https://gitlab.com/team/{{var:project}}/-/blob/main/README.md"
ref: v2
sync: true
---
```

`sync: true` is optional (synced, see above). Text below the frontmatter (written by hand or by another program) is kept but not shown; the note offers to become an ordinary one. Kladde's apps never write such text, and AI assistants (MCP) may only change `source`, `ref` and `sync`.

## Set up access

An admin sets up which instances may be read. The token applies to **everyone** who signs in to this Kladde.

> **Everyone can read whatever the token can read.** Any user can enter any address on a configured instance. Use a project or group token with read access only, and limit it with allowed paths. A personal token of an admin is the wrong choice.

### On the container

| Variable | Meaning |
| --- | --- |
| `REMOTE_GITLAB_URL` | GitLab instance, default `https://gitlab.com`; may include a path (`https://example.org/gitlab`) |
| `REMOTE_GITLAB_TOKEN` | Project or group token with `read_repository`. With `read_api` Kladde also shows the date of the last commit |
| `REMOTE_GITLAB_INTERNAL_URL` | Address the container uses to reach GitLab when it differs (LAN, container name). The token is sent there |
| `REMOTE_GITLAB_PUBLIC` | `1` = without a token, public projects only |
| `REMOTE_GITHUB_URL` | Default `https://github.com`, or a GitHub Enterprise Server |
| `REMOTE_GITHUB_TOKEN` | Fine-grained token with *Contents: Read-only* |
| `REMOTE_GITHUB_PUBLIC` | `1` = without a token, public repositories only (GitHub allows 60 requests an hour) |
| `REMOTE_SYNC_HOURS` | How often synced notes are read again, in hours: default `6`, at least `1`, at most `168`. The server reads at most 10 notes a minute |
| `REMOTE_ALLOWED_PATHS` | Comma-separated groups or repositories users may read, e.g. `team/docs,handbook`. `gitlab:team` or `github:team` apply to one kind only. Empty = whatever the token can read. While set, redirects of renamed projects are not followed |

`REMOTE_GITLAB_TOKEN_FILE` and `REMOTE_GITHUB_TOKEN_FILE` read the token from a file (Docker secrets). Without a token and without `…_PUBLIC` an instance is off.

For a GitLab with a certificate of your own CA see [GITLAB.md](GITLAB.md) (`NODE_EXTRA_CA_CERTS`). The variables for signing in (`GITLAB_*`) are independent of these.

### In the app

**Settings → Administration → GitLab/GitHub**: any number of instances with their token and allowed paths, and **Test access**. Tokens are stored encrypted and never shown again; when the address changes, the token has to be entered again. Entries from the environment are shown but cannot be changed, and win over an entry with the same address.

## What the server does

- The address comes from the stored note, after checking that the user may see the note, with the variables of the note's owner. Recipients and group members see the same document.
- Only configured hosts are asked, matched by their exact origin, and only fixed API addresses on them. `..`, encoded slashes, credentials in addresses and the like are refused, also after filling in variables.
- The token only goes to the API of its own instance, never along a redirect elsewhere. It does not appear in answers, errors or logs.
- Answers are limited in time and size, requests per user are limited. Documents of live notes are kept in memory only and asked for again each time (within a few seconds the same answer is used). Copies of synced notes are stored encrypted like notes, and leave Kladde neither through public links nor through the catalog of online mode.
- Images are recognised by their content; SVGs can run no scripts.
- A recipient who may write a shared note chooses its source. They never learn the filled-in address of a document that could not be read.
- With an `http://` instance the token travels unencrypted: only within a trusted network.

## Messages

| Message | Cause |
| --- | --- |
| This host is not set up | The address is on no configured instance (scheme, host and port have to match), or it has no token and `…_PUBLIC` is not set |
| This project is not open to Kladde | Outside the allowed paths |
| The access set up may not read this document | Token wrong, expired or without the right |
| This document does not exist … | Wrong address, or the token cannot see the project (GitLab and GitHub answer alike) |
| The address redirects elsewhere | The project was renamed, or GitLab redirects to another address or to https: adjust the URL |
| A variable in the address has no value here | Define it in the note's folder or above it |
