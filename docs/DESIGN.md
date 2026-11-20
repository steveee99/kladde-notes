# Design: Werkbank

Werkbank ("workbench") is the planned design for Kladde. It will replace the Material 3 design described in rule 4
of [CLAUDE.md](../CLAUDE.md).

**Status: proposal.** Nothing in this document is implemented yet. The mockups below show the target; the migration
plan at the end lists the steps. Until it is merged, the Material 3 rules stay in force.

![Home on the desktop](images/design/d1-start.png)

## Idea

Kladde is a tool for people with large vaults who write, link and plan every day. Werkbank treats it like that:

- **Dense, calm, dark.** Graphite surfaces, small type, thin lines instead of filled surfaces and shadows. Much of
  the vault fits on the screen at once.
- **One accent.** Amber marks what matters right now: the selection, the primary action, links, today. Everything else
  is grey.
- **Keyboard first.** ⌘K opens the command palette from everywhere; shortcuts are shown next to the commands
  (`<kbd>`), and every action has one.
- **State is visible.** A status bar shows sync, `seq`, word count and who else is working. Presence (avatars, remote
  cursors) appears where it happens.
- **Text is the product.** The editor gets a narrow, readable column (max. 760px) and the most contrast. Chrome steps
  back.

## Colors

The dark scheme is the default. All values are CSS variables on `:root` (later
`[data-theme='werkbank'][data-scheme='dark']`); Tailwind classes use the same names (`bg-panel`, `text-muted`).

### Surfaces and lines

| Token        | Value     | Use                                                        |
| ------------ | --------- | ---------------------------------------------------------- |
| `--bg`       | `#0E0F11` | Page, editor, main content                                 |
| `--panel`    | `#121417` | Side panels (tree, inspector), cards                       |
| `--bar`      | `#15171A` | Top bar, rail, status bar, phone bars, dialogs             |
| `--raised`   | `#1C1F23` | Buttons, inline code, inputs on panels                     |
| `--line`     | `#262A30` | Dividers, card borders, selected row in a list             |
| `--line2`    | `#2D3239` | Borders of controls (buttons, chips, search field, `kbd`)  |

### Text

| Token      | Value     | Contrast on `--bg` | Use                                              |
| ---------- | --------- | ------------------ | ------------------------------------------------ |
| `--strong` | `#F2F4F6` | 17.4 : 1           | Headings, note titles                            |
| `--text`   | `#E6E8EB` | 15.6 : 1           | Default text, list entries                       |
| `--body`   | `#D5D9DF` | 13.5 : 1           | Running text in the editor (a little softer)     |
| `--soft`   | `#C3C8CF` | 11.4 : 1           | Secondary entries in the tree                    |
| `--muted`  | `#9AA1AB` | 7.4 : 1            | Meta data, captions, icons, placeholders         |
| `--faint`  | `#7D848E` | 5.1 : 1            | Completed tasks (with line-through)              |

### Accent and states

Every state has a foreground and a dark background ("pill"). Pairs are always used together.

| Token                       | Foreground | Background | Contrast | Use                                         |
| --------------------------- | ---------- | ---------- | -------- | ------------------------------------------- |
| `--amber` / `--amber-bg`    | `#E8B04A`  | `#3A2E14`  | 8.7 : 1 ¹ | Accent: selection, links, today, primary   |
| `--red` / `--red-bg`        | `#F08A7E`  | `#3A1B18`  | 6.4 : 1  | Overdue, high priority, errors              |
| `--blue` / `--blue-bg`      | `#8AB4FF`  | `#1A2740`  | 7.1 : 1  | Planned dates, recurring, other people      |
| `--ok` / `--ok-bg`          | `#7FC79A`  | `#16301F`  | 7.1 : 1  | Done, synced, saved                         |

¹ Text on `--amber-bg` uses `--amber-hi` (`#F5CB78`). Text on a filled amber button is `#1A1408` (9.4 : 1).
`--amber-line` (`#6B5320`) underlines `[[links]]` and borders selected chips.

Rules:

- Amber appears **at most once or twice per area**: the active rail entry, one primary button, the selected tab. If
  everything is amber, nothing is.
- Colors that must be told apart also differ in lightness (red vs. green pills), never in hue alone.
- PARA colors (graph, folder dots): projects amber, areas blue, resources green, archive grey `#6B727C`, journal
  violet `#C792EA`.
- Presence: every person gets a fixed avatar color from a small set of muted tones (`#3B4A63`, `#4B3B5E`, …); the
  current user is amber. Remote cursors use the person's light tone (e.g. `#8AB4FF`).

## Typography

Two families, both self-hosted through `@fontsource` (the CSP allows no font CDN):

- **Inter** (variable) for the interface and text.
- **JetBrains Mono** for everything machine-like: counts, `seq`, dates in lists, tags, frontmatter values, queries,
  code, keyboard shortcuts, the status bar.

| Style       | Size / line height | Weight | Use                                              |
| ----------- | ------------------ | ------ | ------------------------------------------------ |
| `title-xl`  | 30 / 36            | 600    | Note title in the editor (26 on phones)          |
| `title-l`   | 20 / 28            | 600    | Page headings (Home, Tasks, Graph)               |
| `title-m`   | 18 / 26            | 600    | H2 in notes                                      |
| `body-l`    | 15 / 26 (1.7)      | 400    | Editor text (15.5 on phones)                     |
| `body-m`    | 13 / 20            | 400    | Interface default: lists, tree, buttons          |
| `body-s`    | 12 / 18            | 400    | Meta lines below list entries                    |
| `label`     | 11 / 16, +0.06em, uppercase | 400 | Section captions ("TODAY", "BACKLINKS")   |
| `mono-s`    | 11–12.5            | 400    | Numbers, tags, `kbd`, status bar                 |

Numbers in tables and counters use the mono font so columns line up.

## Shape, spacing, depth

- **Radii:** 4px (pills, `kbd`, tree rows), 6px (buttons, inputs, rail entries, tabs), 8px (cards), 10px (dialogs,
  command palette), 14px (phone FAB), full (chips, avatars).
- **Spacing:** 4px grid. Typical paddings: list rows 5×8 (tree) and 8×14 (cards), page headers 18×28, editor column
  36×40.
- **Lines, not shadows:** areas are separated by 1px `--line` borders. Shadows only for floating layers (command
  palette, menus, FAB): `0 24px 60px rgb(0 0 0 / .55)`. A modal dims the page with `rgb(5 6 8 / .62)`.
- **Motion:** short and functional (120–160ms ease-out for menus and the palette); no decorative animation;
  `prefers-reduced-motion` turns it off.

## Icons

Outline icons with round caps, 1.7px stroke at 18px (15px inside buttons and rows, 21px in the phone navigation bar),
colored `--muted` by default and `--amber` when active. We keep the pipeline from `lib/icons.tsx` /
`scripts/gen-icons.mjs` and switch to Material Symbols Rounded **outlined, weight 300**, which matches this look; no
filled icons.

## Layout

### Desktop (`nav:` screen and up)

```
┌──────────────────────── top bar: logo · command field (⌘K) · presence ────────────────────────┐
│rail│ side panel        │ main                                              │ inspector (opt.) │
│52px│ 240px, resizable  │ tabs / page header                                │ 280px            │
│    │ tree, views,      │ content (editor column max. 760px, centered)      │ outline,         │
│    │ saved queries     │                                                   │ backlinks, …     │
└──────────────────────── status bar: sync · seq · counts · activity of others ─────────────────┘
```

- **Top bar (48px):** logo, the command field in the middle (it is a button that opens the palette), avatars of the
  people online.
- **Rail (52px):** Home, Notes, Tasks, Calendar, Inbox (dot for new items), Graph, Tags, Groups; settings at the
  bottom. The active entry has `--line` background and an amber icon. Tooltips name every entry.
- **Side panel:** depends on the destination: the folder tree with pinned notes and groups (notes), views and saved
  queries (tasks), nothing (graph). Resizable with `ResizeHandle`, can be collapsed.
- **Main:** a page header (title, short summary, actions on the right) or the tab row of open notes (active tab: amber
  line on top). Split view shows two editor columns side by side.
- **Inspector:** optional, per note: outline, backlinks, unlinked mentions, properties. Collapses below 1280px.
- **Status bar (24px, mono 11px):** `● synchron` in green (amber while syncing, red when offline), `seq`, counts that
  belong to the page, and on the right what others are doing ("Ben bearbeitet …").

### Phone (below `nav:`)

- **Top bar (60px):** menu (opens the drawer with the tree) or back, title, at most two actions (search, ⋮), presence
  avatar inside a note.
- **Bottom navigation bar:** Start, Notizen, Aufgaben, Eingang, Suche. The active destination is amber with a short
  amber line above the icon; badges as on the rail.
- **FAB (56px, amber, 14px radius):** on lists for "new note"/"new task", bottom right above the navigation bar.
- **Editor:** no navigation bar. Instead a formatting bar (heading, bold, list, task, link, attachment, undo) above the
  keyboard and a mono status line (saved, words, who else is here). Properties collapse to one line (status pill and
  tags) and expand on tap.
- **Filters** are chips in a horizontally scrolling row below the top bar.
- Touch targets are at least 44×44px even where the drawing looks smaller.

## Components

| Component          | Look                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------- |
| Button             | 32px high, `--raised`, 1px `--line2`, 6px radius, icon 15px + label                          |
| Primary button     | `--amber` fill, text `#1A1408`, weight 600; one per view                                      |
| Icon button        | 40×40, transparent, `--muted` icon; `aria-label` always                                       |
| Chip               | 26px, full radius, 1px `--line2`; selected: `--amber-bg`, `--amber-line`, `--amber-hi`        |
| Pill               | 19px high, 4px radius, state foreground on state background (see colors)                      |
| Input / search     | 34px, `--bg` or `--panel`, 1px `--line2`, icon left, `kbd` hint right                         |
| Card               | `--panel`, 1px `--line`, 8px radius; header row with an uppercase `label` and a mono count    |
| List / tree row    | 5–11px vertical padding, selected: `--line` background, no extra border                       |
| Tab                | 38px, selected: `--bg` with a 2px amber line on top, others `--muted`                         |
| Checkbox           | 15px, 1.5px `#59616C` border (3.1 : 1), done: amber fill with dark tick, text line-through     |
| `kbd`              | mono 11px, 1px `--line2`, 4px radius, `--bar` background                                      |
| Properties         | Two-column grid in a `--bar` card: key in `--muted`, value as text, pill or mono              |
| Wiki link          | `--amber` text with a 1px `--amber-line` underline                                            |
| Inline code        | mono 12.5px, `--raised`, `--amber-hi`, no wrapping                                            |
| Command palette    | 640px, 110px from the top, `--bar`, 10px radius, shadow; input row with scope chips, grouped results (notes, tasks, commands) with icons and shortcuts, hint row at the bottom |
| Avatar             | 26px circle, initial in 11px/600                                                              |

Dialogs keep the rules from CLAUDE.md (role, name, `useModal`).

## Screens

### Desktop

| | |
| --- | --- |
| ![Home](images/design/d1-start.png) **Home:** today's tasks, inbox with "sort in", activity, recently edited | ![Tasks](images/design/d2-aufgaben.png) **Tasks:** saved queries, query line, table grouped by due date |
| ![Command palette](images/design/d3-befehlspalette.png) **Command palette:** notes, tasks and commands in one list | ![Graph](images/design/d4-graph.png) **Graph:** PARA colors, highlighted neighbours, inspector with filters and forces |

### Phone

| | | | |
| --- | --- | --- | --- |
| ![Home](images/design/m1-start.png) | ![Notes](images/design/m2-notizen.png) | ![Editor](images/design/m3-editor.png) | ![Tasks](images/design/m4-aufgaben.png) |
| Home | Notes | Editor with a remote cursor | Tasks |

## Accessibility

- All text pairs above reach WCAG AA (4.5 : 1); most reach AAA. Control borders that carry meaning (checkbox)
  reach 3 : 1; plain dividers (`--line`, `--line2`) are decoration and need not.
- Focus: a 2px `--amber` outline with 2px offset on every focusable element; never removed.
- The axe checks in `e2e/a11y.spec.ts` stay the gate for every screen and scheme.

## Open points

- **Light scheme.** Werkbank is designed dark first. A light scheme (paper-white surfaces, graphite text, a darker amber
  such as `#9A6A12` for text on white) has to be designed and checked before release; the `system` choice follows the
  OS as today.
- **`darker` tone.** Werkbank is already close to the old "darker" tone; it is probably dropped and mapped to dark.
- **Screens not drawn yet:** calendar, inbox triage, settings, admin, sharing and group dialogs, database view, split
  view, presentation mode.

## Migration plan

1. Add the tokens above to `client/src/index.css` under `data-theme="werkbank"` and expose them in
   `tailwind.config.js` (colors, the type scale, radii). Keep the Material roles as aliases for one release so
   existing views keep working.
2. Self-host Inter and JetBrains Mono through `@fontsource`; drop Roboto Flex.
3. Rebuild the components in `@layer components` (`.btn-*`, `.chip`, `.input`, `.card`, `.segmented`, `Switch`) and
   regenerate the icons with weight 300.
4. Replace `MaterialShell` with a Werkbank shell: top bar, rail, side panel, inspector, status bar; on phones the top
   bar, bottom navigation bar, drawer and FAB. Keep the `nav:`, `phone:` and `tablet:` screens.
5. Add the command palette as the central entry (it can grow out of `SearchDialog`).
6. Move the views over one by one, remove the Material aliases, then update rule 4 in `CLAUDE.md` and the screenshots
   in `docs/images`.
7. Run the axe checks in all schemes and sizes; record the results in `docs/ACCESSIBILITY.md`.
