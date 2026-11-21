# Design: Werkbank

Werkbank ("workbench") is the design of Kladde. It replaced the Material 3 design.

**Status: in use since the release after 2.13.0.** The tokens, both color schemes, the accent colors, the
components and the shell are implemented; [Still to come](#still-to-come) lists what the mockups show beyond that.
Rule 4 in [CLAUDE.md](../CLAUDE.md) is the short version for contributors.

![Home on the desktop](images/design/d1-start.png)

## Idea

Kladde is a tool for people with large vaults who write, link and plan every day. Werkbank treats it like that:

- **Dense, calm, dark.** Warm slate surfaces, small type, thin lines instead of filled surfaces and shadows. Much of
  the vault fits on the screen at once. The light scheme is paper and ink: a cream page, near-black text.
- **A notebook, not a dashboard.** A "Kladde" is a rough notebook. Titles are set in a book serif, the home page reads
  like a day sheet, sections are open (a heading over a line, no boxes), and a few notebook marks (dot grid, margin
  line, the notebook logo) give it a face. They are used sparingly; the text stays the product.
- **One accent, chosen by each user.** The accent color marks what matters right now: the selection, the primary
  action, links, the user's own cursor. Everything else is grey. The default is ink blue; every user can pick another one
  (see [Accent color](#accent-color)).
- **Keyboard first.** ⌘K opens the command palette from everywhere; shortcuts are shown next to the commands
  (`<kbd>`), and every action has one.
- **State is visible.** A status bar shows sync, `seq`, word count and who else is working. Presence (avatars, remote
  cursors) appears where it happens.
- **Text is the product.** The editor gets the full width of the content area and the most contrast; focus mode
  narrows it to a reading column. Chrome steps back.

## Colors

The dark scheme is the default. All values are CSS variables in `client/src/index.css` (`:root`, light values in
`[data-theme='werkbank'][data-scheme='light']`) as `R G B` triplets; Tailwind classes use the same names (`bg-panel`,
`text-muted`, `bg-acc/20`). The Material 3 role names (`--surface-container-high`, `--primary`, …) remain as aliases
onto these tokens so older views keep working; new code uses the Werkbank names.

### Surfaces and lines

| Token        | Dark      | Light     | Use                                                        |
| ------------ | --------- | --------- | ---------------------------------------------------------- |
| `--bg`        | `#131210` | `#FBF9F4` | Page, editor, main content |
| `--panel`     | `#171614` | `#F5F2EB` | Side panels (tree, inspector), cards |
| `--bar`       | `#1B1917` | `#F0EDE5` | Top bar, rail, status bar, phone bars, dialogs |
| `--raised`    | `#22201D` | `#EAE6DD` | Buttons, inline code, inputs on panels |
| `--line`      | `#2D2A26` | `#E2DDD3` | Dividers, card borders, selected row in a list |
| `--line2`     | `#36332E` | `#D2CCC0` | Borders of controls (buttons, chips, search field, `kbd`) |

### Text

| Token      | Dark      | on `--bg` | Light     | on `--bg` | Use                                          |
| ---------- | --------- | --------- | --------- | --------- | -------------------------------------------- |
| `--strong` | `#F4F1EC` | 16.6 : 1 | `#171512` | 17.3 : 1 | Headings, note titles |
| `--text` | `#E9E5DE` | 14.9 : 1 | `#211F1C` | 15.6 : 1 | Default text, list entries |
| `--body` | `#DAD5CD` | 12.8 : 1 | `#302D28` | 13.0 : 1 | Running text in the editor (a little softer) |
| `--soft` | `#C7C1B8` | 10.5 : 1 | `#44403A` | 9.8 : 1 | Secondary entries in the tree |
| `--muted` | `#A29B91` | 6.8 : 1 | `#645F57` | 6.0 : 1 | Meta data, captions, icons, placeholders |
| `--faint` | `#888279` | 4.9 : 1 | `#706A62` | 5.1 : 1 | Completed tasks (with line-through) |

### Accent

The accent is a set of five tokens. Components only use these tokens, never a fixed accent value, so changing the
accent changes the whole interface at once.

| Token        | Default (ink)  | Use                                                                      |
| ------------ | -------------- | ------------------------------------------------------------------------ |
| `--acc`      | `#7C9BF7`      | Active rail entry and icons, primary button, links, done checkboxes, own cursor and avatar, focus ring |
| `--acc-hi`   | `#BACAFB`      | Text on `--acc-bg` (selected chips and segments), values in code         |
| `--acc-bg`   | `#1B213C`      | Background of selected chips and segments                                |
| `--acc-line` | `#364680`      | Underline of `[[links]]`, border of selected chips                       |
| `--on-acc`   | `#0A0E22`      | Text and icons on a filled accent (primary button, checkbox tick)        |

### Accent color

Every user picks an accent color in *Settings › Appearance*. The choice belongs to the **account** and follows the
user to all devices (unlike the color scheme, which stays per device). New accounts get **ink** (the preset `blue`,
shown as "Tinte": the blue of fountain pen ink).

There is a fixed set of presets instead of a free color picker, because every preset is checked for contrast in both
schemes:

| Preset            | `--acc`   | `--acc-hi` | `--acc-bg` | `--acc-line` | `--on-acc` | `--acc` on `--bg` | `--on-acc` on `--acc` |
| ----------------- | --------- | ---------- | ---------- | ------------ | ---------- | ----------------- | --------------------- |
| `blue` (ink, default) | `#7C9BF7` | `#BACAFB` | `#1B213C` | `#364680` | `#0A0E22` | 7.0 : 1 | 7.2 : 1 |
| `amber` | `#E8B04A` | `#F5CB78` | `#3A2E14` | `#6B5320` | `#1A1408` | 9.6 : 1 | 9.4 : 1 |
| `green` | `#4FC385` | `#9BE3B8` | `#12301F` | `#2A5C3E` | `#06170D` | 8.4 : 1 | 8.3 : 1 |
| `teal` | `#3EC1C4` | `#95E2E3` | `#0F2E30` | `#265B5D` | `#041616` | 8.6 : 1 | 8.5 : 1 |
| `violet` | `#A98BFF` | `#CDBDFF` | `#241B3F` | `#46387A` | `#130C26` | 7.0 : 1 | 7.1 : 1 |
| `pink` | `#F27BB0` | `#F9B5D3` | `#3A1729` | `#6E2E4D` | `#22081A` | 7.3 : 1 | 7.4 : 1 |
| `coral` | `#F2876B` | `#F8B9A7` | `#3A1D15` | `#6E3828` | `#220C05` | 7.5 : 1 | 7.5 : 1 |
| `graphite` | `#C7C1B8` | `#E9E5DE` | `#2D2A26` | `#544F48` | `#131210` | 10.5 : 1 | 10.5 : 1 |

`--acc-hi` on `--acc-bg` is at least 8.6 : 1 for every preset; `--acc` on `--line` (active rail entry) at least
5.3 : 1. The settings show the presets as Tinte, Bernstein, Grün, Türkis, Violett, Rosa, Koralle and Graphit (German UI).

Light scheme values (on the paper `--bg`; `--on-acc` is white for every preset):

| Preset     | `--acc`   | `--acc-hi` | `--acc-bg` | `--acc-line` | `--acc` on `--bg` | white on `--acc` |
| ---------- | --------- | ---------- | ---------- | ------------ | ----------------- | ---------------- |
| `blue` | `#2642BA` | `#1E349C` | `#E7EBFA` | `#A0AFE8` | 7.8 : 1 | 8.2 : 1 |
| `amber` | `#8F5D00` | `#7A4F00` | `#FFF1D6` | `#E3C27D` | 5.3 : 1 | 5.6 : 1 |
| `green` | `#187042` | `#17673D` | `#E3F4EA` | `#93CDAE` | 5.8 : 1 | 6.1 : 1 |
| `teal` | `#0A6A6E` | `#095E61` | `#E0F4F4` | `#8FCFD0` | 6.0 : 1 | 6.4 : 1 |
| `violet` | `#6B46D9` | `#5734BC` | `#EFEAFE` | `#B9A6F2` | 5.7 : 1 | 6.0 : 1 |
| `pink` | `#B22666` | `#A3215D` | `#FCE8F1` | `#EBA2C3` | 5.9 : 1 | 6.2 : 1 |
| `coral` | `#B03A0A` | `#A3360A` | `#FDEBE4` | `#F0AE93` | 5.8 : 1 | 6.1 : 1 |
| `graphite` | `#44403A` | `#211F1C` | `#EAE6DD` | `#B0A99D` | 9.8 : 1 | 10.3 : 1 |

How it works:

- The preset name (`shared/accent.ts`: `ACCENTS`, default `blue`) is stored in `users.accent` (migration 26), sent
  with the account (`Me.accent`) and changed with `PUT /api/me/accent`. The client (`lib/accent.ts`) caches it in
  `kladde_accent`, so the inline script in `index.html` sets it before the first paint, also offline.
- The client sets `data-accent="green"` on `<html>` (next to `data-scheme`); the token values live in CSS as
  `[data-theme='werkbank'][data-accent='green'] { --acc: …; }` blocks for each scheme. No inline styles, so the
  strict CSP is untouched.
- Settings → Appearance shows the presets as round swatches with their name (`views/AccentPicker.tsx`, a radio
  group). Picking one applies it at once and goes back to the previous one if saving fails.

### States

State colors do **not** follow the accent. They mean the same thing for everyone. Every state has a foreground and a
dark background ("pill"); pairs are always used together.

| Token                       | Foreground | Background | Contrast | Use                                         |
| --------------------------- | ---------- | ---------- | -------- | ------------------------------------------- |
| `--amber` / `--amber-bg`    | `#F5CB78`  | `#3A2E14`  | 8.7 : 1  | Today, in progress, warnings                |
| `--red` / `--red-bg`        | `#F08A7E`  | `#3A1B18`  | 6.4 : 1  | Overdue, high priority, errors              |
| `--violet` / `--violet-bg`  | `#C3A6FF`  | `#2A2140`  | 7.4 : 1  | Planned dates, recurring tasks              |
| `--ok` / `--ok-bg`          | `#7FC79A`  | `#16301F`  | 7.1 : 1  | Done, synced, saved                         |

Rules:

- The accent appears **at most once or twice per area**: the active rail entry, one primary button, the selected tab.
  If everything is accented, nothing is.
- Colors that must be told apart also differ in lightness (red vs. green pills), never in hue alone.
- When the accent resembles a state color (Bernstein ≈ today, Grün ≈ done, Violett ≈ planned), state pills stay
  recognizable by their dark background and their label; accent elements never use the pill shape.
- PARA colors (graph, folder dots) are fixed too: projects amber `#E8B04A`, areas violet `#B49CFF`, resources green
  `#7FC79A`, archive grey `#6B727C`, journal pink `#F28FB8`. The selected node and its links use the accent.
- Presence: each person is shown in their own accent (see above); before their accent is known, a muted tone from a
  small fixed set (`#1F4A4A`, `#4B3B5E`, …).

## Typography

Three families with fixed roles, all self-hosted through `@fontsource-variable` (the CSP allows no font CDN):

- **Newsreader** (variable, with optical sizes; `--font-serif`, Tailwind `font-serif`, the classes `.font-display`,
  `.panel-title`, `.note-title`) for the voice of the page: note titles, the editor's h1–h3, page titles, the date on
  Home and the day sheet, section headings (`Panel`), empty states and the wordmark. Weight 520–560, slightly
  tightened. h4–h6 stay in Inter: they mark structure, not voice.
- **Inter** (variable) for the interface and running text: lists, tree, buttons, editor body.
- **JetBrains Mono** for everything machine-like: counts, `seq`, dates and times in lists, the week number, tags,
  frontmatter values, queries, code, keyboard shortcuts, the status bar.

| Style          | Family     | Size / line height | Weight | Use                                              |
| -------------- | ---------- | ------------------ | ------ | ------------------------------------------------ |
| note title     | Newsreader | 36 / 44 (30 phones)| 560    | Title of the open note                           |
| display        | Newsreader | 38 / 44 (30 phones)| 560    | Home date (`PageHeader display`)                 |
| page title     | Newsreader | 23 / 32            | 560    | `PageHeader` title (Tasks, Inbox, Settings …)    |
| section        | Newsreader | 18 / 24            | 560    | `Panel` heading (Aufgaben, Inbox on Home)        |
| h1 / h2 / h3   | Newsreader | 2 / 1.55 / 1.25 em | 560    | Headings in notes                                |
| `body-l`       | Inter      | 15 / 26 (1.7)      | 400    | Editor text (15.5 on phones)                     |
| `body-m`       | Inter      | 13 / 20            | 400    | Interface default: lists, tree, buttons          |
| `body-s`       | Inter      | 12 / 18            | 400    | Meta lines below list entries                    |
| `.section-label` | Inter    | 12 / 16            | 600    | Small captions in sentence case ("Backlinks"); no uppercase |
| mono           | JetBrains  | 11–12.5            | 400    | Numbers, tags, `kbd`, status bar                 |

Numbers in tables and counters use the mono font so columns line up. Captions are written in sentence case; letter
spaced uppercase labels are not used.

## Character

The notebook marks, each in one place only:

- **Dot grid** (`.paper-dots`): behind the Home header, fading out towards the text. `.paper-grid` fills the knowledge
  graph, `.empty-sheet` sits behind empty states (a serif line, a muted hint, the dots fading out at the edges).
- **Margin line** (`.note-sheet`): two thin lines in `--acc-line` left of the note text on the desktop, like the ruled
  margin of an exercise book. Not on phones, not in focus mode, not in print.
- **Logo** (`views/AppLogo.tsx`, `public/icons/icon.svg`): a notebook with a darker spine, an elastic band and a
  label, drawn in the accent, next to the wordmark "Kladde" in Newsreader. The app icons (PNG) are the same drawing
  on a slate tile.
- **One filled button per page.** Filled accent is reserved for the page's main action (on Home and lists: Capture).
  Buttons that are always there ("New note" in the side panel, "Open daily note") are tonal.

## Shape, spacing, depth

- **Radii:** 4px (pills, `kbd`, tree rows), 6px (buttons, inputs, rail entries, tabs), 8px (cards), 10px (dialogs,
  command palette), 14px (phone FAB), full (chips, avatars).
- **Spacing:** 4px grid. Typical paddings: list rows 5×8 (tree) and 8×14 (cards), page headers 18×28, editor column
  36×40.
- **Lines, not shadows:** areas are separated by 1px `--line` borders. Shadows only for floating layers (command
  palette, menus, FAB): `0 24px 60px rgb(0 0 0 / .55)`. A modal dims the page with `rgb(5 6 8 / .62)`.
- **Motion:** short and functional (120–160ms ease-out for menus and the palette). Three small motions carry a
  meaning: the tick of a task draws itself when it is done (`check-draw`), the sync dot in the status bar sends out a
  ring while syncing and once when the state changes (`.sync-dot`), and a changed count rolls in (`.num-tick`, nav
  badges, task buckets, note count). No decorative animation; `prefers-reduced-motion` turns it all off.

## Icons

Outline icons with round caps, 1.7px stroke at 18px (15px inside buttons and rows, 21px in the phone navigation bar),
colored `--muted` by default and `--acc` when active. We keep the pipeline from `lib/icons.tsx` /
`scripts/gen-icons.mjs` and switch to Material Symbols Rounded **outlined, weight 300**, which matches this look; no
filled icons.

## Layout

### Desktop (`nav:` screen and up)

```
┌──────────────────────── top bar: logo · search field (⌘K) · read-only · account ───────────────┐
│rail│ folder panel      │ main                                              │ inspector (opt.) │
│52px│ resizable,        │ page header or note                               │ outline, tasks,  │
│    │ collapsible       │ content                                           │ links, comments  │
└──────────────────────── status bar: sync · number of notes · version ──────────────────────────┘
```

- **Top bar (48px):** logo (to Home), the search field in the middle (a button that opens the search, Ctrl/⌘+K),
  the read-only switch and the account avatar (to the settings).
- **Rail (52px):** at the top the panel toggle and "new note"; then Home, daily note, Notes, Tasks, Calendar, Inbox,
  mentions; Graph, Tags, Review, Shared, Groups. Icons only, each with a tooltip and an accessible name (badges are
  read out with it). The active entry has a `--line` background and an accent icon. The rail never collapses.
- **Folder panel:** `Sidebar` with `panel`: caption "Notes" with the count and the collapse button, the new-note split
  button, favorites and the folder tree with the groups. Resizable at its edge (`SidebarResizeHandle`).
- **Tabs (38px):** every note opened in the main pane gets a tab (`views/NoteTabs.tsx`, state per device in
  `lib/tabs.ts`, at most 15). Active tab: `--bg` with a 2px accent line on top; others `--muted` on `--panel`. ×
  or a middle click closes (the neighbour opens), drag to reorder, `+` for a new note, Ctrl/⌘+Alt+PageDown/PageUp
  switch. The tab row is a navigation landmark ("Open notes") with links, not an ARIA tablist.
- **Main:** pages and notes on `--bg`, separated by lines; split view shows two notes side by side.
- **Command palette (Ctrl/⌘+K):** `views/SearchDialog.tsx` with the commands from `views/commands.tsx`. Notes,
  open tasks and commands in groups; `>` (or the "Commands" chip) shows only commands; Enter runs, Ctrl/⌘+Enter
  opens a note in the side pane. 640px, `--bar`, 10px radius, the only element with a large shadow.
- **Inspector:** the note's side panel (outline, tasks, links, comments), as before.
- **Status bar (24px, mono 11px):** the sync state with a colored dot (green synced, amber syncing or pending, red
  error; a click syncs), the number of own notes and the version.
- **Capture button:** bottom right, filled with the accent (56px on phones, 44px on the desktop).

### Collapsible side panel

The folder panel can be collapsed so the content gets the full width.

- **Toggle:** the button in the panel's caption row, the button at the top of the rail, `Ctrl/⌘+\` and a click on the
  active "Notes" destination in the rail.
- **Collapsed:** the panel is gone completely; the rail stays. Reopening keeps the last width.
- **Remembered per device** (`lib/sidebarMode.ts`, like the width in `lib/sidebarWidth.ts`), because it depends on the
  screen. It is open unless the user collapsed it.
- On phones there is no panel; the tree lives in the drawer as before.

### Phone (below `nav:`)

- **Top bar (60px):** menu (opens the drawer with the tree) or back, title, at most two actions (search, ⋮), presence
  avatar inside a note.
- **Bottom navigation bar:** Start, Notizen, Aufgaben, Eingang, Suche. The active destination is in the accent color
  with a short accent line above the icon; badges as on the rail.
- **FAB (56px, accent, 14px radius):** on lists for "new note"/"new task", bottom right above the navigation bar.
- **Editor:** no navigation bar. Instead a formatting bar (heading, bold, list, task, link, attachment, undo) above the
  keyboard and a mono status line (saved, words, who else is here). Properties collapse to one line (status pill and
  tags) and expand on tap.
- **Filters** are chips in a horizontally scrolling row below the top bar.
- Touch targets are at least 44×44px even where the drawing looks smaller.

## Components

| Component          | Look                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------- |
| Button             | 32px high, `--raised`, 1px `--line2`, 6px radius, icon 15px + label                          |
| Primary button     | `--acc` fill, text `--on-acc`, weight 600; one per view                                       |
| Icon button        | 40×40, transparent, `--muted` icon; `aria-label` always                                       |
| Chip               | 26px, full radius, 1px `--line2`; selected: `--acc-bg`, `--acc-line`, `--acc-hi`              |
| Pill               | 19px high, 4px radius, state foreground on state background (see colors)                      |
| Input / search     | 34px, `--bg` or `--panel`, 1px `--line2`, icon left, `kbd` hint right                         |
| Card               | `--panel`, 1px `--line`, 8px radius; header row with an uppercase `label` and a mono count    |
| List / tree row    | 5–11px vertical padding, selected: `--line` background, no extra border                       |
| Tab                | 38px, selected: `--bg` with a 2px `--acc` line on top, others `--muted`                       |
| Checkbox           | 15px, 1.5px `#59616C` border (3.1 : 1), done: `--acc` fill with `--on-acc` tick, text line-through |
| `kbd`              | mono 11px, 1px `--line2`, 4px radius, `--bar` background                                      |
| Properties         | Two-column grid in a `--bar` card: key in `--muted`, value as text, pill or mono              |
| Wiki link          | `--acc` text with a 1px `--acc-line` underline                                                |
| Inline code        | mono 12.5px, `--raised`, `--acc-hi`, no wrapping                                              |
| Command palette    | 640px, 110px from the top, `--bar`, 10px radius, shadow; input row with scope chips, grouped results (notes, tasks, commands) with icons and shortcuts, hint row at the bottom |
| Avatar             | 26px circle, initial in 11px/600, in the person's accent                                      |
| Segmented control  | 1px `--line2`, 6px radius; selected segment `--acc-bg` with `--acc-hi` text                  |
| Switch             | 36×20 track in a 24px tall target, 14px knob; on: `--acc` track with `--on-acc` knob, off: `--sunken` track with `--edge` line and `--muted` knob |
| Accent swatch      | 36px circle (44px on phones) with the name below; selected: 2px ring in the color and a tick  |

Dialogs keep the rules from CLAUDE.md (role, name, `useModal`).

## Screens

### Desktop

| | |
| --- | --- |
| ![Home](images/design/d1-start.png) **Home:** today's tasks, inbox with "sort in", activity, recently edited | ![Tasks](images/design/d2-aufgaben.png) **Tasks:** saved queries, query line, table grouped by due date |
| ![Command palette](images/design/d3-befehlspalette.png) **Command palette:** notes, tasks and commands in one list | ![Graph](images/design/d4-graph.png) **Graph:** PARA colors, highlighted neighbours, inspector with filters and forces |
| ![Editor with collapsed side panel](images/design/d5-editor-eingeklappt.png) **Editor, side panel collapsed:** toggle in the tab row, breadcrumb, wider column | ![Appearance settings](images/design/d6-darstellung.png) **Settings › Appearance:** accent presets with preview, scheme, density, side panel |

### Phone

| | | | |
| --- | --- | --- | --- |
| ![Home](images/design/m1-start.png) | ![Notes](images/design/m2-notizen.png) | ![Editor](images/design/m3-editor.png) | ![Tasks](images/design/m4-aufgaben.png) |
| Home | Notes | Editor with a remote cursor | Tasks |
| ![Appearance](images/design/m5-darstellung.png) | | | |
| Appearance (accent color) | | | |

## Accessibility

- All text pairs above reach WCAG AA (4.5 : 1) for every accent preset; most reach AAA. A new preset is only added
  after the same checks. Control borders that carry meaning (checkbox)
  reach 3 : 1; plain dividers (`--line`, `--line2`) are decoration and need not.
- Focus: a 2px `--acc` outline with 2px offset on every focusable element; never removed.
- The axe checks in `e2e/a11y.spec.ts` stay the gate for every screen and scheme.

## Still to come

The mockups go further than the first implementation. Not built yet:

- The breadcrumb above a note with a collapsed panel and a "show panel" button in the tab row.
- `seq`, word count and other people's activity in the status bar; presence avatars in the top bar.
- The inspector's own shortcut, the settings "start collapsed" and "collapse automatically below 1280px".
- Other people's avatars and cursors in their accent color (cursors still use the fixed set `--cursor-1…6`).
- The density setting and the live preview next to the accent swatches (the settings navigation and the row layout
  are built: `views/SettingsNav.tsx`, sections in `views/Settings.tsx`).
- A few rarely used views (sign-in, Confluence, presentation) still carry Material-era spacing; the role aliases and
  the shared components keep them in the new colors and shapes.
