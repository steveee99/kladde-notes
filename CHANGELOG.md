# Changelog

All user-visible changes to Kladde.

## [Unreleased]

- New: Folders as databases (#76). "Make database" in a folder creates a `_database-<uuid>.md` note (hidden from the note list, folder tree and search) whose frontmatter holds the schema: typed properties (text, number, date, select, multi-select, checkbox, link to a note) and saved views. The folder then shows its notes as a table with editable cells that write the note's frontmatter, a board grouped by a select property (drag a card to change its value) or a gallery with each note's first image; every view has its own filters and sort order, and "Schema" edits properties and views (renaming a property moves its values in the notes). New notes in the folder start with the properties prefilled with their defaults. Schema and views are plain Markdown/YAML in the folder, so they sync, export and work offline, and the values stay ordinary frontmatter that `query` blocks can use.
- New: Storage quotas for accounts and groups (#91): the admin area shows what each account and group stores (notes, attachments, history, trash) and lets admins set a limit or lift it; `STORAGE_QUOTA_MB` sets a default. Uploads over the limit are refused with a clear message (offline uploads stay queued and can be retried), a warning appears at 80 %, and everyone sees their usage under Attachments.

## [2.11.0] – 2026-11-18

- New: AI memory (#94, opt-in, Settings → Features → AI memory). A shared folder, `AI-Memory` by default, where AI assistants from any provider (through MCP) and you build knowledge together: facts about products and tools, techniques, decisions, preferences and rules for the AI. Notes are plain Markdown in a small, Open Knowledge Format (OKF v0.2)-compatible form: frontmatter with the required `type` (Reference, Technique, Rule, Decision, Preference or your own), `description`, `tags`, `status`, `stale_after`, `sources`, `generated` and `verified`; other keys are kept. Assistants that connect get a description of the folder and every note of type `Rule` with their instructions (also as an MCP resource and prompt), so the rules apply to every provider without setting them up there. The new MCP tools `memory_save` (create or update a note by its fields) and `memory_check` (problems, outdated notes, unconfirmed knowledge) help them keep it in shape. Kladde stamps `generated` with the connection's name, refuses writes that break the format (missing `type`, unreadable frontmatter, timestamps without time zone) and confirmations an assistant makes in a person's name, keeps your confirmations when an assistant rewrites a note, and updates `index` (keeping what was written by hand) and `log` by itself. Notes you edit are stamped as yours when you leave them. Every note in the memory shows its type, who changed it when, its trust level (unconfirmed, machine-confirmed, confirmed by you), draft/deprecated/to-review states, problems and sources, with "Confirm", "Mark as deprecated" and "Copy to my notes"; the memory's root index shows an overview. Links from the memory appear in their own section below a note's backlinks; search lists memory notes after your own (with a switch to hide them) and the graph colors them. Path links in OKF style (`[Text](/Products/Foo)`, relative `.md` links) and `[[Folder/Name]]` now resolve to notes. The memory can be exported as an OKF bundle (ZIP, links converted to bundle paths) and an OKF bundle folder can be imported. New query fields for notes with a `type`: `trust`, `stale`, `generated_by`, `generated_at`, `verified_by`.
- Changed: The server CLI (`cli.js`) and the import CLI (`npm run import`) speak English (#66). The server CLI commands have English names (`help`, `notes`, `search`, `folders`, `attachments`, `clean-attachments`, `invite`, `invites`, `delete-invite`, `users`, `suspend`, `unsuspend`, `reset-password`, `admin <user> [on|off]`, `audit-log`); the German names (`hilfe`, `einladen`, `sperren`, …) still work as aliases, so existing scripts keep running. The guides `docs/GITLAB.md` and `docs/IMPORT.md` are now English, with the German versions in `docs/GITLAB.de.md` and `docs/IMPORT.de.md`.
- New: Backups in the admin area (#65). Settings → Administration → Backups lists every backup with date, size and what it contains, takes one with "Back up now", sets the daily backup and how many to keep, downloads a backup as one `.tar` archive and restores one. A backup now holds the database together with the attachments and profile pictures (still encrypted; attachments are hard-linked, so daily backups take little extra space); the encryption key is never part of it, which the page points out. Restoring asks for confirmation, backs up the current state first, restarts the server and applies the backup before the database opens; both the request and the restore are recorded in the audit log. `BACKUP_KEEP` is now only the default for the daily backup, `BACKUP_DIR` sets where backups are stored.
- New: End-to-end browser tests (#62) with Playwright (`npm run test:e2e`, `e2e/`): sign-in, creating and editing notes, renaming a note with its links rewritten, editing offline and syncing after reconnecting, concurrent edits from two browsers merged without losing text, sharing a note, group roles (editor writes, reader only reads), trash and restore, and the navigation layout at phone (390 px), tablet portrait (820 px, touch) and desktop sizes. They run in CI for every pull request and keep the report, traces and screenshots when a test fails.
- Changed: Accessibility audit (#63, findings in `docs/ACCESSIBILITY.md`). Dialogs and sheets (new note, share, history, quick capture, the side pane on narrow screens, the phone navigation drawer) are announced as dialogs, take the focus when they open, keep Tab inside, close with Escape and return the focus to the button that opened them. The note text has an accessible name, the counters on the navigation rail and bar are read out ("Tasks, 3 overdue or due today"), task checkboxes are named after their task, and the status menu of Kanban cards and the task panel works with the arrow keys. Search results no longer nest a button in each result, and the settings destination is named like its visible label. The browser tests check all main views and overlays with axe in the dark, light and darker scheme, the keyboard paths and reduced motion.
- Improved: Large vaults (#64, numbers in `docs/PERFORMANCE.md`). The first sync of a new device no longer writes and redraws once per note: with 1,000 notes it took over four minutes and with 5,000 it did not finish, now it takes about one and two seconds. Typing no longer re-parses every note for the link index and the task badge (66 ms and 35 ms of work per keystroke with 5,000 notes, now under 2 ms and 6 ms), the task page and home show long task lists 100 at a time with "Show more" (task page with 5,000 notes: 0.9 s instead of several seconds), sorting folders, notes and tags no longer builds a new collator per comparison, and the graph of more than 1,500 notes settles faster and labels only the notes in focus. Query blocks and the semantic search of AI assistants (MCP `semantic_search`) and the CLI reuse what they parsed for unchanged notes (search 2.5 s → 0.14 s, task queries 225 ms → 17 ms). Settings and other occasional pages load on first use, which makes the app's start bundle smaller. New benchmarks: `npm run bench` and `npm run bench:e2e`.

## [2.10.0] – 2026-11-18

- Fixed: Phones show the five main destinations in the bottom navigation bar again; daily note, search, tags and graph appear there only on tablets. Since 2.9.0 the extra destinations, some button labels and the compact button spacing meant for phones were shown on phones as well.
- Changed: The word count (words, characters, reading time) appears directly below the note title instead of as a bar over the bottom of the note.
- Changed: New daily notes no longer start with a heading repeating the date that the title already shows. Their content comes from the new "Daily note" entry under Settings → Templates (shown while daily notes are on), which can be edited like any template; `{{title}}` is the daily note's name and `{{date}}` its day.

## [2.9.0] – 2026-11-17

- Changed: Search opens as an overlay (Ctrl/⌘+K, the search field in the sidebar, the search button on phones and tablets) instead of inside the sidebar, so the sidebar no longer opens for the shortcut. Results are compact (title, folder and the text around the match on two lines at most, matches highlighted) and are picked with the arrow keys and opened with Enter; without a query it lists the recently edited notes. Matches in attachments stay below the notes.
- New: Icons (opt-in, Settings → Features → Icons). Notes and folders can get an emoji as their icon, shown in the folder tree, the favorites and the search. Notes get it via ⋮ → "Icon …" and keep it in their frontmatter (`icon: 🚀`), so it travels with shares and exports; folders (including group folders) get it from the smiley button in the tree, synced across devices, and keep it when renamed or moved.
- Changed: Tablets in portrait (e.g. an iPad) use the phone layout with the navigation bar at the bottom instead of the navigation rail or sidebar, so the editor gets the full width; in landscape they keep the desktop layout. On wider screens the bottom bar also offers the daily note, search, tags and (from 768 px) the graph. With a mouse or trackpad nothing changes.
- New: Groups (#58). Under "Groups" you can create a group, add people by username and give each one a role: owner (manages members and roles, renames and deletes the group), editor (creates, edits, moves and deletes notes) or reader. Notes created in a group belong to the group, not to a person, and every member sees them according to their role; deleted group notes go to the trash of the group's owners and editors. A group always keeps an owner: the last owner can neither leave, be removed nor give up the role until another member is owner. "Manage" opens the group's page with its members as a table (filterable in larger groups) and the number of notes, attachments and members below it. Deleting a group (a button there) asks in a dialog for its name as confirmation and removes all its notes (with history, releases and trash) and its attachments for every member. Own notes and whole folders move into a group with "Move to group" (note menu, folder header): earlier single shares, folder shares and public links of those notes end, links between the moved notes keep working, links to notes outside only for people who can see them. In the sidebar, every group is a top folder with the group symbol and its folders and notes below it ("Group/Folder"); the group and its folders can be added to the favorites (star in the tree or on the group page). AI assistants (MCP) see the notes of the user's groups below the group name (`group` and `read_only` in the results, the groups with the user's role in list_notes) and change or create them (`create_note` with `group`) only where the role allows it. Groups are optional; without one nothing changes. Moving notes from a group back into a personal space is not supported yet. Not available in desktop mode and the browser demo.

## [2.8.0] – 2026-11-16

- New: Text alignment per note (left, center, right, justify) in the note's menu, stored as the frontmatter property `align`; code blocks stay left-aligned and the code view ignores it.
- Fix: The color scheme picker in Settings no longer wraps onto two lines on phones.

## [2.7.0] – 2026-11-16

- New: Release versioning for notes (#53). "Versioning …" in a note's menu turns it on for that note (off by default, only the owner). "Release" freezes the current text as the next Semantic Version (major, minor or patch; the next number is suggested, the first release is 1.0.0) with date, author and an optional changelog line. Released versions are stored encrypted and can never be changed (enforced on the server and in the database); you keep working on the draft of the next version, and "Discard draft" goes back to the latest release. Read-only share recipients, public links and exports (export mirror, Confluence, Markdown/Word/PDF) get the latest released version; the owner and editors work on the draft. The note header shows the state ("v1.2.0 · Draft"), and earlier releases can be opened from the dialog. Put the version history anywhere in the note with a ```` ```versions ```` block or a line `{{version_history}}`, or build your own layout with `{{version}}`, `{{released_at}}`, `{{released_by}}`, `{{release_note}}` and a row template `{{#versions}}…{{/versions}}`; the text keeps the placeholders, they are filled in when the note is shown and exported (dates in your language). Turning versioning off keeps the releases for later. Prerelease tags are not supported; AI assistants (MCP) keep working on the draft and cannot release. Not available in the browser demo.
- New: "Darker" color scheme (Settings → Appearance): the dark scheme with neutral dark grey surfaces instead of the blue-tinted ones.
- New: Editor font size (Settings → Appearance): 14 to 22 px, per device.
- Fixed: In focus mode with "dim other paragraphs", tables (and other blocks such as diagrams) stayed dimmed even while the cursor was in them or a table cell was being edited.
- Fixed: "Sync to Confluence …" only offered part of the spaces of a larger Confluence. The space is now a search field with suggestions that searches all spaces on the server (by name and key). You can also paste the link of a Confluence page or space (Cloud and Data Center address formats, including short `/x/` links): the space is filled in, and a page link also becomes the parent page. Links to another Confluence than the connected one are rejected.

## [2.6.0] – 2026-11-15

- Changed: The expanded sidebar shows the destinations as a list again (icon, name, count) in a "Navigation" group that can be collapsed like Favorites and Folders; while it is closed, its header shows the urgent count. The logo is smaller and sits next to the menu button with Home on the right, "New note" moved to the top above the search, and read-only and sync are compact buttons next to Settings at the bottom. Calendar, Attachments and Trash left the navigation: Calendar opens from the activity heatmap on Home, Attachments and Trash from Settings.
- New: The expanded sidebar is wider by default (320 px) and can be resized by dragging its right edge (260–480 px, also with the arrow keys; a double-click resets it). The width is remembered per device.
- Changed: The navigation rail has more space between destinations, dividers between groups, Review and "Shared" next to the others, and the same count badges as the expanded sidebar (orange for overdue tasks and a full Inbox, grey for counts, a dot for a due review), which are no longer cut off.
- Changed: Settings show the entries at the top (Administration, MCP, templates …) as tiles, up to three per row. Passkeys, password and GitLab sign-in are grouped under "Security" right below the profile. Each feature is a compact row that only says "On" or "Off" and expands on click to its description, switch and options. The content width is a slider from 50 to 100 % that snaps to 50, 80 and 100 %. The diagnostics panel is gone.

## [2.5.0] – 2026-11-15

- New: One-way sync of notes and folders to Confluence (#48). Settings → Confluence connects your own Confluence (Cloud with e-mail and API token, or Data Center/Server with a personal access token); "Test connection" shows the account name, the token is stored encrypted, never sent back to the app, can be replaced or removed, and changes are recorded in the audit log. "Sync to Confluence …" in a note's menu, or the cloud button on a folder in the sidebar, picks a space and a parent page (search by title): a note becomes one page, a folder a page tree (subfolders become parent pages listing their children, notes child pages, new notes in the folder are added). Kladde is the source: edits are pushed automatically about 30 seconds after the last change and with "Sync now", renaming a note renames its page, nothing is read back. Markdown becomes the Confluence storage format: headings, lists, quotes, tables, links, formatting, tasks as a Confluence task list (with their state), code blocks as the code macro, callouts (`> [!warning]`) as info/tip/note/warning panels, images and PDFs as page attachments, `[[links]]` as links to the page when the target is synced too, tags as labels, `query` blocks as their current result; the frontmatter is left out and other Kladde-only blocks get a short hint. A page that was edited in Confluence is not overwritten silently: the note shows a conflict with "Overwrite with Kladde" or "Stop syncing". Moving or deleting a note leaves its page alone unless the sync was set up to move such pages to the Confluence trash. The note header shows the sync state (also errors such as an expired token or a page deleted in Confluence). Only the owner of a note can sync it. Requests to Confluence are https only with size and time limits; private addresses (an intranet Confluence) only with `CONFLUENCE_ALLOW_PRIVATE=true`. Not available in the browser demo.
- New: Full-text search in PDFs and images (#37). The server reads the text of every PDF attachment (pdf.js, bundled, no CDN) right after the upload and stores it encrypted next to the attachment; attachments from before the update are read once in the background after the start. The sidebar search and the search page show matches in attachments below the notes ("In attachments", online only) with file name, page number and a snippet, and lead to the notes that embed the file. The MCP tools `search_notes` and `semantic_search` report them as `attachments` with page, snippet and embedding notes. Only attachments embedded in notes you can read are searched. Optional OCR for images and scanned PDF pages with `OCR=true` (Tesseract compiled to WebAssembly, German and English language data bundled, `OCR_LANGS` to choose): off by default because it costs CPU; turning it on reads existing images and scanned pages once in the background. Not available in the desktop app.

## [2.4.0] – 2026-11-15

- New: Task page (#45). "Tasks" in the navigation (with a badge for overdue and today's tasks, also in the phone's navigation bar) opens `/tasks` with every task of your vault, including the ones without a due date: as a list grouped by overdue, today, upcoming and no date, or as a Kanban board. Filter by status and folder/project, sort by due date, note or text, and show done tasks; layout and filters are remembered per device.
- Changed: The task section on the Home screen only shows tasks with a due date. "All tasks" in its header and a link below the list open the task page for the rest.
- New: Apple Shortcuts (#46). Settings → Apple Shortcuts creates tokens for the iOS Shortcuts app (valid for a year by default, revocable, last use shown, only a hash stored, recorded in the audit log). They only work on a small API: `POST /api/shortcuts/capture` (text, link or Markdown into the inbox), `attachment` (a photo or file, embedded in a new inbox note), `append` (to a note or today's daily note), `task` (with due date, time and repeat, into the free tasks or a note) and `GET /api/shortcuts/tasks` (overdue, today's and upcoming tasks with a ready-made summary such as "2 due today, 1 overdue"). This brings Kladde into the iOS share sheet, Siri and the Action Button, and a morning automation replaces Web Push on iPhone. The guide in `docs/SHORTCUTS.md` (and `SHORTCUTS.de.md`) explains how to build the four shortcuts.
- New: Web clipper (#32). "New note → Web page" saves an article as Markdown: the server fetches the page (with the same protections as the recipe import: no private addresses, size and time limits), keeps the main content (headings, paragraphs, lists, quotes, code, tables, images and links, without navigation, sidebars, comments or share buttons) and creates a note in the inbox with `source:`, `author:`, `published:` and `clipped:` in the frontmatter. "Save images as attachments" downloads the article's images into Kladde (encrypted like any attachment), so the note works offline and survives the page. A bookmarklet ("Save to Kladde", in the same dialog) sends the current page from any browser; with text selected, only the selection is saved as a quote below its source.
- New: Attachments work offline (#28). Pasting or dropping an image or PDF, the upload button and Quick Capture (also "Share → Kladde") no longer fail without a connection: the file is kept on the device, the note links it as `kladde-pending:…` and shows the local copy (dimmed, with a dashed frame). Once online, the file is uploaded and the link is replaced by the real attachment as a normal synced edit, so concurrent changes are merged. Pending files survive reloads; the sync badge counts them and Attachments lists them with size and note, with "Retry" for files the server refused and "Discard". Files over the attachment size limit are refused right away. Other people (shared notes) and other devices see a placeholder until the upload is done.
- New: Voice notes (#33). "Record" in Quick Capture and `/audio` (Voice note) in the editor record with the microphone (time and level meter, up to 30 minutes) and store the recording as an encrypted attachment – also offline, where it uploads later. Notes show audio attachments as a player, also on public links; the server answers byte ranges so Safari can play them. Optional transcription: with `TRANSCRIBE_URL` set to a speech-to-text server you run (e.g. a local Whisper with the OpenAI-compatible API), "Transcribe" below a recording adds its text as a quote; without it nothing leaves your server. AI assistants can fetch a recording with the new MCP tool `read_voice_note` and append the transcript with `append_to_note`. The app may now use the microphone (`Permissions-Policy: microphone=(self)`).
- New: Tasks tab in the note's side panel (#45). It lists the tasks of the open note in document order with status and due date and a "3 / 8 done" counter; a click jumps to the line, and the checkbox or the status button changes the task right in the editor (one undo step).

## [2.3.0] – 2026-11-15

- Changed: The logo in the navigation drawer sits on its own row, larger and as a tonal tile in the colours of the theme (like the "New note" button) instead of a small icon with its own dark background.
- New: Knowledge graph filters (#38). "Filters" on `/graph` narrows the graph by PARA area (the archive stays hidden by default), note type (note, Zettel, PDF, drawing), folder and tag (including nested tags), and a time range of when notes were created or changed, to see how the knowledge base grew. "Focus on a note" shows one note with its neighbours up to 1–3 links away; "Show in knowledge graph" in a note's side panel opens that view, and the local graph there has its own depth (1–3, remembered per device). Orphaned notes (no link in or out) are drawn as dashed rings, counted in the summary and can be shown alone. The weekly review lists "Notes without connections" next to the unconnected Zettel (without inbox, archive and daily notes), with a link to the orphans in the graph.
- New: Tag overview (#31). "Tags" in the navigation (`/tags`) lists all tags of your own notes as a tree (`#area/health` below `#area`) with the number of notes, and a filter field. A tag shows its notes, including those with nested tags. "Rename" and "Merge into …" rewrite the tag in all of your own notes, including nested tags and the frontmatter `tags:` line, as normal synced edits; renaming onto an existing tag merges both. In the editor, `#` followed by a letter suggests known tags, most used first.
- New: Nested tags (#31). Tags nest with `/` (`#area/health`), and a parent includes its children: `WHERE tags contains "area"` and the new `FROM #area` in `query` blocks, as well as the tag filter of the calendar feed, also find notes tagged `#area/health`.
- Changed: The note's side panel follows Material 3 more closely: a Title Large header with a standard close button, primary tabs (icon above the label, a primary indicator under the active tab) instead of a pill row, backlinks and unlinked mentions as filled list items, and the type scale for the outline, the empty states and the graph legend. The graph's hover label is a plain tooltip, and on phones the panel opens as a modal side sheet with the M3 shape.
- Fixed: The next due date on a project card on the Home screen sits inside its background again. It is now a chip like "open tasks" next to it (red when overdue, amber when due today) instead of a pill that was stretched and showed its text at the top.

## [2.2.0] – 2026-11-14

- New: Reminders for tasks via Web Push (#26). Tasks can have a time: `⏰ 09:00` or `remind:9:00` next to the due date. Settings → Notifications turns reminders on per device; at that time on the due day a notification comes with "Done" and "Tomorrow" (where the platform shows action buttons), a click opens the note at the task. Optional: a daily overview at a chosen time ("3 tasks due today, 1 overdue"), quiet hours, and the task text in the notification (off by default: then a notification contains no note text). Works on Android and desktop browsers, and on iPhone/iPad in the app added to the Home Screen. The server creates its VAPID keys on first start; payloads are end-to-end encrypted for the device and only go to known push services. The time also works in `TASKS` queries (`time`), the MCP (`list_tasks`) and the calendar feed (tasks with a time become 30-minute events).
- New: Calendar feed for due tasks (#34). Settings → Calendar feed creates a secret address (`/api/calendar/<token>.ics`) that calendar apps can subscribe to. It lists your own open tasks with a due date as all-day events, repeating tasks as a series (`RRULE`), each with a link back to its note. Options: also show done tasks, only one folder or tag, and hide the task text (every entry is then just "Task"). Like import tokens, feeds expire after the chosen time, can be revoked, at most 5 per account, and only a hash of the secret is stored; the filter options are encrypted.
- New: Embed notes and sections (#29). A line with only `![[Note]]`, `![[Note#Heading]]` or `![[Note#^block-id]]` shows the note, the section (with its subsections) or the block read-only inside the current note, in a subtle frame with the source title on top (a click opens it). Tasks inside an embed can be ticked and are written back to the source note when you may edit it. Embeds resolve like links (title, frontmatter `id`, Zettel id), count as links for backlinks and the graph, and are rewritten when the note is renamed. Embeds nest down to 3 levels, a note that embeds itself is not shown again, and notes you cannot access show "Not available". On public links, embeds only show notes of the same owner that have a public link themselves.

## [2.1.0] – 2026-11-14

- New: Browser-only demo on GitHub Pages (#24). `npm run build:demo` builds Kladde without a server: notes, drawings, tasks and the trash work and stay in the visitor's browser; sharing, attachments, history and AI access say they need a server. A workflow publishes it for every push to `main`. The app also runs under a sub path now (`/kladde-notes/…`).
- New: Trash (#25). Deleted notes are no longer gone at once: they go to the trash of their owner (Settings → Trash, or the trash icon in the sidebar), which lists path, deletion date and, for shared folders, who deleted it. "Restore" puts a note back at its old path, or asks for a new one when that path is taken; it syncs to all devices. A deleted folder restores as one unit ("Restore folder with 12 notes"). "Delete for good" and "Empty trash" remove notes with their history and drop attachments nothing uses any more. Notes older than 30 days are purged automatically (`TRASH_RETENTION_DAYS`, `0` = keep until purged by hand). Paths and contents in the trash stay encrypted; only the owner can restore or purge. Notes deleted before this version cannot be restored.
- New: Outline panel (#30). The "Contents" tab of the note's side panel (a sheet on phones) is now "Outline": it lists the headings indented by level, highlights the section you are reading while you scroll, and updates while you type and when others edit. A click jumps to the heading, the arrow next to it folds or unfolds the section in the editor ("Collapse all" / "Expand all" for every section), and dragging a heading moves the whole section with its subsections as one edit, so a single undo restores it.
- New: Every "New note" button offers the same kinds of notes (#9). The dialog behind the rail button, the "New" button of a folder, "Full note" in Quick Capture and the button of a shared folder now let you pick note (with templates), drawing, PDF and, when turned on, Zettel and recipe. A shared folder offers notes and drawings.
- New: Word count and reading time (#35). A small status line below each note shows words, characters and reading time; with a selection it also shows how many words are selected. Frontmatter and code blocks are not counted.
- New: Focus mode (#35). `Ctrl/⌘+Shift+F` or ⋮ → "Focus mode" hides the navigation, the header and the side panels and centers the text with a comfortable line length; `Esc` or the button in the corner leaves it. Optionally all paragraphs except the one with the cursor are dimmed. Both features can be turned off under Settings → Features.
- New: "Share → Kladde" (#27). The installed app appears in the share menu of other apps on the phone. Shared links, text, images and PDFs open Quick Capture prefilled: a link becomes `[title](url)`, text is taken over as is, files are attached like a paste. "Save" creates a new note in the inbox. Offline, files cannot be attached yet; Kladde says so and saves the text.

## [2.0.1] – 2026-11-13

- Fixed: The Docker image builds again. The patched `deepmerge` copy in `vendor/` was left out of the build context, so the client build stopped with "Cannot find module …/deepmerge/dist/cjs.js".

## [2.0.0] – 2026-11-13

- Security: Links, images and PDF embeds in notes only accept `http`, `https`, relative addresses and (for links) `mailto:`/`tel:`. Before, a `javascript:` address in a shared note or behind a public link could run code in the reader's session (stored XSS). Such links are now shown as plain text.
- Security: The app sends a Content-Security-Policy: scripts only from Kladde itself, no plugins, no framing by other sites. Excalidraw no longer loads its CJK font (Xiaolai) from a CDN.
- Removed: Git sync. Its settings page, API and background job are gone; the stored repository addresses and access tokens are deleted from the database on start-up, the local working copies in `data/git` too. The Docker image no longer contains `git`. Use the export mirror (`EXPORT_DIR`) or the Markdown export instead.
- Security: Updated or pinned vulnerable dependencies (`npm audit` reports none): `nanoid`, `katex` and `lodash-es` inside Excalidraw, `minimatch` in the lint tools, and a patched copy of `deepmerge` (build tools only, no upstream fix yet) in `vendor/`.
- New: Drawing notes with Excalidraw (#2). "New note" → "Drawing" creates a note marked `type: excalidraw` that opens as a full-size canvas for sketches and diagrams. The drawing is stored as Excalidraw JSON in the note text, so it syncs, works offline, is encrypted and appears in the history like any other note; The canvas fills the page and can be switched to full screen; "Edit as text" (in the drawing menu) shows the JSON. Public links show the drawing (view only) instead of the JSON. The canvas follows the app's color scheme and language, and its fonts are served by Kladde itself instead of a CDN.
- Changed: The design now follows Material 3 throughout. Colors are the full set of Material 3 color roles (scheme "Tonal Spot" from the previous blue), in both the dark and the light color scheme. Text uses the Material 3 type scale (no more uppercase section labels), corners follow the Material 3 shape scale, and depth comes from tonal surfaces instead of shadows.
- Changed: Buttons, text fields, chips, segmented buttons, cards, lists, menus, dialogs, switches and checkboxes use their Material 3 forms, including hover and press state layers. Short messages appear as a snackbar.
- Changed: Navigation rail and navigation bar use the Material 3 sizes; the active destination has a tonal indicator and a filled icon. The editor toolbar is a floating Material 3 toolbar.
- Changed: Icons are now Material Symbols (Rounded) instead of Lucide; they are bundled with the app and work offline.
- Changed: On phones the notes list no longer shows a separate "New" button next to the "Capture" button.
- Changed: The activity calendar (heatmap) stretches to the full card width; its day squares grow with the available space.
- Fixed: Task cards on the task board and in kanban blocks no longer blend into their column; they now sit one tone above it with a light shadow.
- Fixed: Longer labels in the navigation rail (e.g. "Attachments") are no longer cut off.
- Fixed: Note previews in lists and cards no longer show the table-of-contents marker (`##TOC##`, `[[TOC]]`) or table pipes and separator rows.
- Fixed: Pressing Enter on an empty task or list item right after the first one ends the list instead of inserting an empty line and another item (#1).

## [1.0.0] – 2026-11-12

- Changed: First stable release, Kladde is now open source under the MIT license. The README and this changelog are now in English (the README is also available in German as `README.de.md`).
- New: `SECURITY.md` (how to report vulnerabilities), `CONTRIBUTING.md`, a code of conduct and issue templates.

## [0.35.0] – 2026-11-12

- New: PDF as its own note type. In the menu "More note types" (arrow next to "New note") → "PDF", upload a PDF file. It is created as a note in the open folder (otherwise in the inbox) and shown at full size, with a link to open it in a new tab. "Edit as text" switches to the normal editor, "View as PDF" switches back. PDF notes have their own icon in the sidebar.

## [0.34.0] – 2026-11-11

- New: Import CLI for Obsidian vaults and Markdown folders. Under Settings → Import you create and revoke import tokens (at most 5, expiring after 7, 30, 90 or 365 days); `npm run import -- <folder> [<target folder>] --url <Kladde URL>` reads the folder, shows a preview (new, skipped, ignored), asks for confirmation and then imports notes and the linked images and PDFs. Existing paths are skipped, never overwritten. Unencrypted `http://` addresses are only accepted with `--allow-insecure`, and the CLI warns when you use it. Guide in `docs/IMPORT.md`.

## [0.33.0] – 2026-11-11

- New: Light color scheme (Material 3). Under Settings → Appearance & language → "Color scheme" choose between Dark (default), Light and System; "System" follows the operating system setting. The choice applies per device.

## [0.32.0] – 2026-11-11

- New: Detailed guide for "Sign in with GitLab" with a self-hosted GitLab in `docs/GITLAB.md` (creating the OAuth application, container variables, custom certificates via `NODE_EXTRA_CA_CERTS`, troubleshooting).
- New: Invitations can be switched off per sign-in method: `SIGNUP_WITHOUT_INVITE` (e.g. `gitlab` or `gitlab,password`, `all`) decides which sign-in methods create new accounts without an invitation. For example, all GitLab users (optionally only from `GITLAB_ALLOWED_GROUPS`) can register themselves while passkey and password still require an invitation. For open passkey/password registration the sign-in page offers "Create new account". `GITLAB_ALLOW_SIGNUP=1` keeps working.
- New: `GITLAB_INTERNAL_URL`. If the container reaches GitLab at a different address than the browser does (home network without hairpin NAT, GitLab on the same Docker host), Kladde requests the token and user data there.

## [0.31.1] – 2026-11-11

- Fixed: The bottom navigation bar on phones no longer ends with a large gap above the screen edge; like the iOS tab bar, the labels now move into the area of the home indicator.

## [0.31.0] – 2026-11-11

- New: A folder can be removed in the folder view with "Delete", together with all its notes and subfolders (after a confirmation showing the number of notes). The inbox, PARA folders, Zettelkasten and daily notes are excluded.
- Changed: When a URL is pasted as a link, Kladde removes `[`, `]` and `\` from the link text instead of escaping them with `\`.
- Changed: The tasks on the home page leave out notes in the archive. The Kanban column "Done" only shows tasks that were completed today or yesterday.
- Fixed: Task checkboxes in the editor are at the same height again; depending on the status (open, in progress, blocked, done) they used to sit at different heights.
- Fixed: On the home page, tasks without a note are vertically centered in their row or card, without empty space below.

## [0.30.0] – 2026-11-11

- New: Tasks have a status: `[ ]` open, `[O]` in progress, `[H]` blocked, `[x]` done. In the editor the checkbox shows the status (half filled, pause symbol, or green with a check mark); a click completes the task, a right-click picks any status. `TASKS` queries and the MCP know the field `status` (`open`, `doing`, `blocked`, `done`).
- New: The tasks on the home page can be switched between list and Kanban (remembered per device). The board has one column per status; dragging a card to another column changes the status of the task in its note. On phones, the button on the card selects the status. "Done" shows the tasks of the last 7 days.
- New: Ligatures in the editor: `->` appears as →, `<-` as ←, `=>` as ⇒, `<=`/`>=` as ≤/≥, `!=` as ≠, `<->`/`<=>` as ↔/⇔ and `...` as …. Only the display changes, the text stays the same; in code and on the line with the cursor the characters stay visible. Can be turned off under Settings → "Ligatures".

## [0.29.0] – 2026-11-11

- Changed: The ⋮ menu of a note now bundles "Copy Markdown", "Favorite" and "Markdown view" (previously separate buttons in the note header) as well as "Complete project" and "Convert to a project folder" for projects (previously in the project bar).
- New: Edit properties (frontmatter) directly. Click values in the properties row to change them (Enter accepts, Escape discards), create new ones with "+ Property" and remove them with ×; `status` and `type` offer suggestions. Notes without frontmatter get one via ⋮ → "Add property". A click on the empty area still shows the YAML.
- New: In a daily note, "Open tasks from earlier daily notes" lists everything left over from previous days; "Move to today's note" (or "Move all") moves the task with its subtasks into the open daily note. The list shows only the name of the task (without `- [ ]`) and wraps on phones instead of being cut off.
- New: Tasks in a daily note without a date of their own are due on the day of the daily note (home page, `TASKS` queries and MCP). Moved tasks therefore automatically shift to the new day; an explicit `📅` is kept.
- Fixed: On phones with the keyboard open, you could no longer scroll up to the note's bar. The app now adapts to the visible area above the keyboard.

## [0.28.0] – 2026-11-11

- New: Sidebar search by keyboard. The arrow keys ↑/↓ move through the results, Enter opens the highlighted one.
- New: Favorites (opt-in under Settings → Features): the star in the note header (or `Ctrl/⌘+D`) adds or removes the open note. As soon as there are favorites, they appear as their own list in the sidebar and are synced between devices.
- Changed: Tidier sidebar. The navigation (Home, Daily note, Notes, Inbox, Knowledge graph, Attachments, Review …) is a compact row of icons with tooltips and counters; "Favorites" and "Folders" can be collapsed (remembered per device), the favorites show at most five entries without scrolling, and on low screens they start collapsed. This leaves much more room for the folders.
- New: Edit tables in the preview. Click a cell and type (Tab/Shift+Tab/Enter move on, Escape cancels), insert, rename and remove columns via the ⋮ menu in the header, add and remove rows. In the Markdown view the table stays plain text.
- New: Sign in with GitLab (GitLab.com or your own instance) via `GITLAB_CLIENT_ID`/`GITLAB_CLIENT_SECRET`, optionally restricted to groups (`GITLAB_ALLOWED_GROUPS`). Existing accounts link GitLab in the settings; new accounts are created via an invitation link or with `GITLAB_ALLOW_SIGNUP=1`. Guide in the README.
- Changed: The weekly review is now opt-in (Settings → Features); without it, "Review" disappears from the navigation, as does the reminder on the home page.
- Removed: The Telegram admin bot (`TELEGRAM_*` variables). You manage invitations, accounts and the log in the app under Settings → Administration.

## [0.27.0] – 2026-11-11

- New: In the shared editor you can see where the others are writing: a colored cursor with a small profile picture (with the name on hover), and selected text appears in the same color. Each person has the same color everywhere; your own other devices/tabs are shown as well.

## [0.26.0] – 2026-11-11

- New: Real-time collaborative editing, for shared notes and for several devices/tabs of the same account. Changes by others appear immediately in the open editor and are merged with what you are typing; cursor, selection and undo history are kept. As soon as a note is open in more than one place, the note header shows "Live" with the profile pictures of everyone who has it open (with the number of devices).
- New: Conflicts are merged instead of copied. If two devices or people change a note at the same time, even when a device was offline for longer and only syncs later, both changes are taken over by a three-way merge (line by line, word by word within the same paragraph). Only if both change the same words does a "(Conflict …)" copy remain, as before.

## [0.25.0] – 2026-11-10

- New: Colored syntax highlighting in the Markdown code view (headings, formatting, links/images, code blocks including `query`/`mermaid`/`mindmap`/`gallery`/`carousel`, YAML frontmatter, `[[wikilinks]]`, `#tags`, footnotes, `##TOC##` and task metadata).

## [0.24.0] – 2026-11-10

- New: Code view. A button in the note header switches the editor to plain Markdown (no live preview, monospace font); the choice is remembered per device.
- Fixed: Images no longer flip back and forth between image and Markdown while editing; they stay visible, and their Markdown only appears when the cursor is right at the image (then above the image).
- Fixed: Portrait images in the carousel are displayed in portrait instead of being cropped.

## [0.23.1] – 2026-11-10

- Fixed: `/carousel` was missing from the slash menu.

## [0.23.0] – 2026-11-10

- New: External links (`[text](https://…)`, `<https://…>` and bare URLs) appear in the editor as a Material 3 chip with the site's favicon (a globe as fallback, offline or without an icon) and the link text or a shortened URL.
- New: Slash command `/carousel` with the block ` ```carousel ` (same syntax as the gallery, one image per line) as a Material 3 carousel: swipeable horizontally with snapping, a large image with the next one peeking in, captions from the alt text, previous/next buttons on desktop, a click opens the full-screen view.
- New: "+ New note" in the sidebar is a split button; the menu next to it contains "Zettel" and "Recipe from URL" (instead of separate buttons), if the features are enabled.
- Changed: The gallery (` ```gallery `) shows images in two columns (in one column for narrow notes).
- Changed: "Administration" was removed from the sidebar; it stays reachable via the settings.
- Fixed: Icons in the settings (including "Features & structure") are vertically centered with title and description.
- New: A pasted URL becomes `[title](url)` when the clipboard provides a link text (e.g. "Copy link" on web pages or the address bar in Edge/Safari); with selected text, the selection becomes the link text.
- Fixed: The slash command `/link` (web link) inserted nothing because the empty link text of the template `[](https://)` crashed the live preview.

## [0.22.0] – 2026-11-10

- New: All native `<select>` fields replaced by Material 3 dropdown menus (floating list menu via a portal).
- New: A button in the folder tree (the "Folders" header and the search results header of the sidebar) to focus, automatically expand parent folders and highlight the currently open note.
- New: The shortcut `Ctrl+Shift+D` / `⌘+Shift+D` opens today's daily note from anywhere (also directly from the editor); a date bar `<-- | Datepicker | -->` above daily notes with a Material 3 calendar popover and its own daily view (`/daily`, `/daily/:date`).
- New: Opt-in calendar view in the style of the GitHub heat map on the home page and at `/calendar` (can be enabled under **Settings → Features & structure**); clicks on day tiles open or create daily notes only when daily notes are enabled and are inactive otherwise.
- Fixed: Mobile views, dialogs, the editor toolbar (from `320 px` width), split-view tabs, property chips and navigation bars (including the pinned sidebar header and the bottom spacing above the "Capture" button) reworked against clipped elements, and mobile modals/drawers/sheets lifted above the header via a portal.

## [0.21.0] – 2026-11-10

- New: **Daily notes** with a configurable target folder (also the top level) and a freely definable naming scheme including date placeholders and a live preview under **Settings → Features & structure** (default: `0 Daily/YYYY/MM/YYYY-MM-DD.md`), as well as direct access from the home page and the sidebar.
- New: **Project logic & conversion to project folders**: Not every note under the Projects folder automatically counts as a project note any more, only direct project files (`<Projects>/<Name>.md`) or a `Home.md` directly in a project subfolder (`<Projects>/<Folder>/Home.md`). The new button **"Convert to a project folder"** in a single project note turns it into its own project folder (`Home.md`) and keeps existing `[[links]]`.
- New: **Profile pictures (avatars)** in the Material 3 design: upload, change and remove them under Settings, shown when sharing notes and folders, on public links, and in the sidebar or at the bottom right on mobile (a click opens the settings directly).
- Fixed / Changed: On mobile devices the breadcrumb bar now compactly shows only the last folder (tapping opens a menu with all clickable folder levels); long note titles wrap onto several lines instead of being cut off.

## [0.20.0] – 2026-11-10

- New: Notes inside folders and at the top level are now shown directly in the folder tree of the left sidebar (including drag & drop and automatic expansion); the additional middle list sidebar next to open notes is gone.
- New: The PARA method (Projects, Areas, Resources, Archive; "0 Inbox" stays active independently of it), Zettelkasten and recipe import are now optional opt-in features under **Settings → Features & structure**, with a free choice of target folders and creation of new target folders directly in the settings (synced encrypted per account; existing spaces with the default folders get them pre-enabled automatically).
- Changed: The right split-view sidebar in open notes is now visually separate from the main area as a rounded card, like the pinned left menu.

## [0.19.0] – 2026-11-10

- New: Standalone desktop mode without user management as a single executable via Node.js SEA and Microsoft Edge (`--app` window; buildable locally with `npm run build:desktop` or `npm run build:exe` for `dist/kladde.exe`). Notes, attachments and the key are stored locally and AES-256-GCM encrypted outside the program file (`%LOCALAPPDATA%\Kladde\` or optionally portable in the folder `kladde-data` next to the `.exe`), including an automatic database backup before schema migrations. Updates are done by simply replacing the `.exe`.

## [0.18.0] – 2026-11-10

- New: Bilingual (German and English) throughout the interface, including date formats, welcome notes, widgets, slash commands, dialogs, exports and sign-in (switchable under Settings → Appearance and directly on the sign-in page).
- New: Notes get a full folder breadcrumb navigation in the header, a quick-copy button for plain Markdown (without YAML frontmatter) and a Material 3 three-dot menu (Share, History, Export, Move, Delete).
- New: Collapsible right split-view sidebar in notes with the tabs "Contents" (table of contents), "Links" (backlinks & mentions) and "Graph".
- New: Automatic table of contents via `##TOC##` (or `[[TOC]]`), through the slash command `/toc` and the toolbar, and in the Word and PDF export.
- New: Direct search bar in the sidebar (and the Material list bar); the separate "Search" tab is gone (`Ctrl+K` still focuses the search).
- New: Opt-in "Inbox Zero" in the settings (off by default). Only when enabled do the counter on the inbox and the message "X messages to sort" appear.
- New: The shortcut `Ctrl+S` (`Cmd+S`) saves open changes and syncs immediately with a status message.
- Changed: Kladde now uses only the Material 3 design system (the "Light" and "System" themes were removed); the three-line menu switches directly between the narrow bar and the pinned sticky bar (without a desktop overlay).
- Changed: Widescreen now uses percentages (`50 %`, `80 %` default, `100 %`, custom) and now also applies to the settings pages; on screens below `800 px` the full width is used automatically.
- Changed: On the home page, the welcome greeting, subtitle and "+ Project" button are larger and structured by dividing lines; in the inbox only the folder selection and Delete remain on the right of each tile; inline code stands out more clearly from the background.
- Fixed: The calendar/due-date popover on tasks is rendered via a portal, so it no longer disappears behind following text and always stays clickable.

## [0.17.1] – 2026-11-10

- Fixed: The export menu in notes (and shared views) is now rendered via a portal outside the note header, so on desktop the following layers (metadata bar, properties and editor) no longer cover the menu, and clicks on the export options arrive reliably again.

## [0.17.0] – 2026-11-10

- New: In the dark design (Material), the sidebar on larger screens can be switched between "Overlay" (narrow bar on the left + drawer) and "Sticky" (the full menu permanently replaces the bar on the left) via Settings → Appearance or directly in the menu header.
- New: Manage attachments under "Attachments" (sidebar and settings): a gallery grid of all uploaded images and PDFs with the filter "Not used in notes", note references, multi-select and deletion with confirmation. Attachments that are still used in a note are protected and cannot be deleted.
- New (CLI): Extended server CLI with `import <source> <target>` (a single file or a recursive folder including images/PDFs and Obsidian links), `export <source> <target>` (a whole space, folder or single note, optionally `--strip-frontmatter` / `--with-files`) and helper commands (`suche`, `notizen`, `ordner`, `anhaenge`, `anhaenge-bereinigen`, `status`, `backup`, account management).
- New: Notes can be exported directly as Markdown (`.md`), Word document (`.docx`), PDF file (`.pdf`) or via the print view, each without YAML frontmatter.
- New (MCP): New tool `semantic_search` for a local semantic search across all your own notes. It takes German and English word stems, compound terms, topic-related terms and linked `[[links]]` into account.

## [0.16.0] – 2026-11-09

- New: Automatic recognition of note names in text: if the title of an existing note is mentioned in running text, it is automatically shown as a clickable hyperlink (subtly dotted underline) in the live preview and reading mode. A click opens the target note immediately. Through a small icon on hover (and through the new slash command `/verlinken` for all mentions), the match can be permanently turned into a real [[wikilink]] with one click.

## [0.15.0] – 2026-11-09

- New: Widescreen setting under Settings → Appearance: choose between "Fluid (full width)" and "Fixed width" (with a slider, numeric input and quick selection in pixels; the default is 1200 px). Notes, overviews and tables make the best use of the extra space on wide screens.

## [0.14.2] – 2026-11-09

- Fixed: On desktop, the folder dropdown in the inbox covered the delete button for longer folder names. The dropdown width is now limited cleanly, so the delete button always stays clickable.
- Fixed: On mobile devices, dialogs and input windows (e.g. the recipe import) now adapt dynamically to the virtual keyboard area and no longer disappear behind the open keyboard. On touch devices the keyboard also no longer opens automatically when the dialog appears.
- Changed: The slash menu (`/`) in the editor has more padding and was restyled in the Material design with rounded menu entries, tonal highlighting and a softer shadow.

## [0.14.1] – 2026-11-09

- Fixed: Security updates for dependencies (Mermaid, Vitest, Glob).

## [0.14.0] – 2026-11-09

- Changed: There is only one dark design left. "Material" is now called "Dark" and replaces the previous designs "Dark" and "OLED". Anyone who had chosen one of them automatically gets the new one; "System" uses it in dark mode.
- Fixed: On phones, wide tables made the whole note wider than the screen, so the page scrolled sideways. Now only the table scrolls, and cells no longer wrap in the middle of a word.
- New: The "Material" design now has its own layout instead of just its own colors: on tablet and desktop a narrow navigation rail on the left with a large button for new notes; folders and everything else open from the menu icon as a drawer. Next to an open note, wide screens show the list of notes from its folder (switchable to all notes). The content sits on a rounded surface. On phones there is a bottom navigation bar with a pill indicator and a "Capture" button. Buttons are round, chips, input fields, cards and checkboxes have Material shapes, the editor toolbar floats, and the font is Roboto Flex (available offline).

## [0.13.0] – 2026-11-09

- New: "Material" design under Settings → Appearance. Inspired by Google's Material 3: almost black, neutral gray surfaces that stand out through tonal steps instead of lines, a blue accent, larger rounding and Material's motion curves.

## [0.12.0] – 2026-11-09

- New: Git sync. Under Settings → Git sync you store a Git address (https), email and access token per account. Your own notes (not shared ones) are then pushed as Markdown files to the `main` branch, one commit per sync, about two minutes after the last change or via "Sync now". You set the commit message yourself; `{date}` becomes the current date, `{time}` the time (default: "Kladde sync {date}"). Credentials are stored encrypted in the database; the files in the repository are unencrypted. The Docker image now contains `git` for this.
- New: Free tasks. The "New task" field on the home page creates tasks without a note (in a hidden system note, encrypted and synced); they appear together with the scheduled tasks from your notes.
- New: Every task on the home page has a small calendar button for due date and repetition, with shortcuts for Today, Tomorrow and Next week (Monday), date picker and repetition (daily to yearly).

## [0.11.0] – 2026-11-09

- New: Version history for notes. The "History" button (clock icon) at the top of a note lists the saved versions (encrypted on the server, up to 100 per note; a writing session counts as one version, and a new one only starts after a 10-minute pause or after an hour). A click shows the changes compared to the previous version as in `git diff` (green added, red removed, with line numbers) or, switchable, the rendered text. "Restore" resets the note to the chosen version. The history starts with the update; deleted notes lose their history.
- Changed: "Delete" in the inbox now asks for confirmation, like in the note before.

## [0.10.0] – 2026-11-08

- New: Note lists can be switched between tiles, list and table, in folders, "All notes", "Shared with me", the search and "Recently edited" on the home page. The choice applies everywhere and is remembered on the device.
- New: Queries as a Kanban board: ```` ```query ```` with `KANBAN BY status VALUES "open", "doing", "done"` shows one column per value with the matching notes (without `VALUES` the existing values are used; `FROM`, `WHERE`, `SORT`, `LIMIT` work as usual). Cards can be dragged to another column and set the field in the note. New slash command `/kanban`.
- New: Tasks on the home page are available in a compact view (one line per task), switchable with the "Compact/Normal" button.
- New: A double-click on a task (home page and task queries) opens the note it comes from and jumps to the line.
- New: Footnotes. `[^1]` becomes a superscript number (hover shows the text, a click jumps to the definition), lines `[^1]: text` appear as a numbered footnote.

## [0.9.0] – 2026-11-08

- New: Diagrams and mind maps in notes. A code block ```` ```mermaid ```` is drawn as a Mermaid diagram (flowchart, sequence, pie, Gantt, class diagram and much more). A code block ```` ```mindmap ```` turns a simple outline into a mind map: the first line without a list marker is the center, indented list items (or headings) are the branches; links and formatting appear as text. If the cursor is in the block you see the source, otherwise the picture, also in the reading view and on public links. A click enlarges the diagram, and Kladde shows errors together with the source. The colors follow the chosen design, and everything works offline. New slash commands: `/mindmap`, `/diagramm`, `/sequenzdiagramm` and `/kreisdiagramm`.
- New: Share folders. Through the share icon next to a folder in the sidebar you release it to other users and set per person what they may do: reading is always allowed, plus optionally editing, creating new notes and deleting. The share applies to all notes in it, including subfolders and notes added later; if you move a note out, it is no longer shared. If you rename or move the folder, the share stays in place. Recipients find the shared folders under "Shared with me" and create notes there with "New note" if they are allowed to. These notes belong to you as the owner and live in your space; if you withdraw the share, the others no longer see anything of it.
- Fixed: An app update no longer makes the whole screen flash. The update waits until you are not typing (or the app is in the background); afterwards the app appears immediately with your account and without fade-in animations.

## [0.8.0] – 2026-11-08

- New: AI assistants such as Claude talk to your notes via MCP (Model Context Protocol). The address is `https://<your-kladde>/mcp`; when connecting, you sign in to Kladde and confirm the access (OAuth), read-only if you like. The assistant sees only your own notes, no shares from others and no settings. It can list, search and read notes, run queries and list tasks; with write permission it can also create, replace and append notes and tick off tasks (not delete or rename). You manage and disconnect connections under Settings → AI assistants; there you also create access tokens for programs without a sign-in window. A password reset by admins disconnects all connections of the account.

## [0.7.0] – 2026-11-08

- New: Templates have their own area under Settings → Templates. There you create your own templates (e.g. for projects or meetings) with a name, target folder and content, and edit and delete them. Placeholders: `{{title}}`, `{{date}}` and `{{zid}}` (Zettel ID, also placed before the title). The templates are synced encrypted with the settings.
