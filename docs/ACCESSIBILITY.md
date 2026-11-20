# Accessibility

Kladde aims for WCAG 2.1 level AA in both color schemes (dark and light) and with every accent color on phones, tablets and desktops.
This page records the audit from issue #63 (version 2.11.0), what was fixed and what is still open.

## How it is checked

`e2e/a11y.spec.ts` runs with the other browser tests (`npm run test:e2e`, see [CONTRIBUTING.md](../CONTRIBUTING.md)):

- **axe-core** (rules for WCAG 2.0/2.1 A and AA) on home, a note, tasks (list and Kanban), notes, tags, groups, settings,
  trash and the admin area, plus the side pane, the share dialog, the new-note dialog, the search overlay and the phone
  navigation drawer – in the dark and the light scheme, at phone, tablet and desktop sizes. Every violation fails
  the test.
- **Keyboard paths**: dialogs move the focus inside when they open, keep Tab and Shift+Tab inside, close with Escape
  and give the focus back to the control that opened them; the phone drawer does the same; a Kanban card changes its
  status with Enter and the arrow keys.
- **Reduced motion**: with `prefers-reduced-motion: reduce` animations and transitions are cut to 1 ms.
- **Badges**: the counters on the navigation rail and bar are part of the destination's name for screen readers.

## Findings and fixes (2.11.0)

| Finding | Where | Fix |
| --- | --- | --- |
| The note text field had no accessible name (axe `aria-input-field-name`) | Editor | The CodeMirror content is labelled "Note text" / "Notiztext" and follows the language |
| Sheets and dialogs were plain `div`s: no dialog role, no focus handling, Escape did nothing | New note and other sheets (`Sheet`), share, history, quick capture, side pane on narrow screens, phone drawer | `role="dialog"`, `aria-modal`, a name from the heading, and `useModal` (`client/src/lib/modal.ts`): focus moves to the first field, Tab is trapped, Escape closes the topmost dialog, focus returns to the opener |
| Search results nested a button inside each `option` (axe `nested-interactive`) | Search overlay | The option itself is clickable; the keyboard works through the combobox (arrows, Enter) as before |
| The settings destination was named "Settings" while it shows "Options" (axe `label-content-name-mismatch`, WCAG 2.5.3) | Navigation bar and rail | The visible label is the name; the username stays in the tooltip |
| Navigation badges were `aria-hidden`, so screen readers missed overdue tasks and inbox counts | Navigation rail and bar | The destination's name ends with e.g. ", 3 overdue or due today" |
| Task checkboxes were named after their status ("Open") instead of the task | Task lists | The checkbox is named after the task; the status stays in the tooltip and the checked state |
| The status menu (Kanban cards, note task panel) could only be used with a pointer | Kanban, task panel | It takes the focus, moves with the arrow keys, Home and End, closes with Escape and returns the focus to its button; the card's button names the current status and the task. Inside the editor the menu leaves the focus in the text, so the on-screen keyboard stays |
| Admin tabs did not expose which one is selected | Administration | `aria-pressed` on the tab buttons |

Color contrast passed axe in all three schemes of the Material 3 design without changes. The Werkbank design that
replaced it (docs/DESIGN.md) keeps text at 4.5:1 or more in the dark and the light scheme and with every accent preset.

## Known gaps

- Kanban columns accept drag and drop only with a pointer; the keyboard alternative is the status button on each card.
- In task lists the status menu (in progress, blocked) opens with a right click or long press; with a keyboard use the
  context menu key (Shift+F10) on the checkbox.
- The live preview of the editor draws some Markdown as widgets (task boxes, link pills, tables, diagrams). They are
  reachable with the cursor and read as text, but diagrams (Mermaid, Excalidraw) have no text alternative yet.
- axe checks what it can see; screen reader passes with NVDA, VoiceOver and TalkBack are still worth doing before a
  release that adds new surfaces.

Report accessibility problems as an issue with the `accessibility` label.
