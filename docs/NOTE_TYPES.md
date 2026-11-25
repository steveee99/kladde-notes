# Note types

[Deutsch](NOTE_TYPES.de.md)

A custom note type decides which properties a note has, where they show and whether the frontmatter is visible. A note is of a type as soon as its frontmatter says `type: custom:<name>`:

```yaml
---
type: custom:Meeting
Date: 2026-11-25
Status: planned
---
```

## Modelling

**Settings → Note types → New note type.** For your own notes and for every group you may write in.

- **Name:** letters, digits, spaces, `_`, `-` and dots; upper and lower case do not matter. After renaming a type its old name keeps working, so notes need no change.
- **Also show the frontmatter:** without it the frontmatter row is hidden. The source view always shows it.
- **Show properties:** at the top, on the right (beside the text, above it on narrow screens), at the bottom or hidden.
- **Properties:** text, number, date, select, multi-select, checkbox or note link, in any order. Each may have its own position. Defaults may contain `{{date}}`, `{{title}}` and `{{zid}}`.

Values are plain frontmatter of the note; databases, queries and other tools read them as before. Renaming a property moves its values in the notes (not in online mode). Deleting a type keeps the notes and their values.

## Using

- **Templates:** choose the note type in the template's editor, or write `type: custom:<name>` yourself. This also works for daily, weekly and monthly notes and for templates over MCP.
- **New note:** choose the note type in the dialog.
- **Existing note:** ⋮ → **Note type …**

Defaults fill properties the note does not mention yet. Typing `type: custom:<name>` into a note sets no defaults.

## Scope and sharing

A type applies in its space (own notes or one group). In groups and shared notes your own types of the same name are the fallback. If a type is not known, the note says so and shows its frontmatter as usual. Public links show the properties as modelled, read-only. Hidden does not mean secret: the frontmatter is part of the note and is sent with it.

A type is stored in a hidden note `_type-<id>.md`, synced and encrypted like any note:

```yaml
---
type: note-type
name: Meeting
frontmatter: hide
position: right
properties:
  - name: Date
    type: date
    default: "{{date}}"
  - name: Status
    type: select
    options: [planned, done]
    position: top
---
```
