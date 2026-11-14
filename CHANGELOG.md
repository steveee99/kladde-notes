# Changelog

All user-visible changes to Kladde.

## [Unreleased]

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
