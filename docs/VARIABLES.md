# Variables

[Deutsch](VARIABLES.de.md)

Variables hold values that many notes share: a customer, a host name, the address of a repository. They are defined in a folder (or a group), inherited by its subfolders and can be overridden there. Notes show the current value; the text keeps the placeholder, so changing a variable changes every note that uses it.

## Use

```
{{var:customer}}
{{var:customer|nobody}}
[Repository](https://git.example.com/{{var:customer}})
```

- `{{var:name}}` shows the value, `{{var:name|fallback}}` the fallback when the variable is not defined. Without either the placeholder stays visible, marked as unknown.
- `!{{var:name}}` (or `!{{name}}`) is no placeholder: the value is put into the text once, when it is typed, pasted or completed, and when a note is made from a template (also over MCP). Use it for what should stay as it was, e.g. `!{{today}}` for the day a note was written. Inside code it stays as written; without a value it stays as well.
- Placeholders in the frontmatter show their value in the properties row and in the fields of databases and note types; while a field is edited it shows the placeholder.
- Names consist of letters, digits, `_`, `-` and `.` and are matched without upper and lower case.
- Values are plain text: Markdown or HTML in them is not interpreted. A value that is a web address becomes a link. In links and images, values are part of the address (no spaces in the placeholder there).
- Nothing is filled in inside code, formulas, `[[links]]`, query results and the frontmatter; a database shows values in its cells where they are not input fields. In a Markdown table write the bar of a fallback as `\|`.
- Typing `{{` or `/Variable` offers the variables of the note's folder. The tooltip of a value names the variable and the folder it comes from.
- Templates keep the placeholder, so notes made from them follow the variable.
- Word, PDF, slide and Markdown exports, Confluence pages, presentations and public links contain the values. The export folder on the server, account exports, MCP and "Copy as Markdown" contain the note as written.

## Built-in date variables

These work in every note and template without defining them, and always show the date of the day the note is read
(they are filled in when shown or exported, like every variable). A folder variable of the same name wins. Each has a
German alias.

| Name | German | Example (Wed 2026-11-25) |
| --- | --- | --- |
| `today` | `heute` | 2026-11-25 |
| `tomorrow` | `morgen` | 2026-11-26 |
| `yesterday` | `gestern` | 2026-11-24 |
| `week` | `woche` | 2026-W48 |
| `nextWeek` | `nächsteWoche` | 2026-W49 |
| `lastWeek` | `letzteWoche` | 2026-W47 |
| `weekNumber` | `kw` | 48 |
| `weekStart` / `weekEnd` | `wochenstart` / `wochenende` | 2026-11-23 / 2026-11-29 |
| `nextWeekStart` | `nächsterMontag` | 2026-11-30 |
| `month` | `monat` | 2026-11 |
| `nextMonth` / `lastMonth` | `nächsterMonat` / `letzterMonat` | 2026-12 / 2026-10 |
| `year` / `nextYear` | `jahr` / `nächstesJahr` | 2026 / 2027 |

Typing `{{` in a note or template offers them below the folder's own variables.

## Define

**Variables …** in the header of a folder, "All notes" (top level) or a group, or in the menu of a folder in the sidebar. The dialog lists the folder's own variables and the inherited ones with their origin and an **Override** button. Readers of a group see them but cannot change them.

A value may use other variables, for example `repo` = `https://{{var:host}}/{{var:customer}}`. They are looked up from the note's folder, so overriding `customer` in a subfolder also changes `repo` there. A value that names itself means the one it overrides (`path` = `{{var:path}}/sub`). Circles and values above 2,000 characters are marked as errors.

They are stored in a hidden note `_variables-<id>.md` in the folder (`_variables.md` works too), synced and encrypted like any note:

```yaml
---
type: variables
variables:
  customer: ACME
  repo: "https://{{var:host}}/{{var:customer}}"
---
```

## Scope and sharing

- The nearest folder wins, up to the top level of your notes or of the group. Nothing is inherited from one space into another, and an embedded note uses the variables of its own folder.
- Shared notes: recipients see the variables they have access to, so those of a shared folder and its subfolders. Variables of folders that are not shared show as unknown (or with their fallback). Sharing a note never reveals its folder's variables.
- Public links: the server sends only the final values of the variables the page uses. Whoever may edit a note with a public link can put `{{var:…}}` into it and so show a variable of its folder on that page. The same goes for notes synced to Confluence.
