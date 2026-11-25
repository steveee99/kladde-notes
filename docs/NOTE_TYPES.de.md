# Notiztypen

[English](NOTE_TYPES.md)

Ein eigener Notiztyp legt fest, welche Eigenschaften eine Notiz hat, wo sie stehen und ob das Frontmatter sichtbar ist. Eine Notiz gehört zu einem Typ, sobald in ihrem Frontmatter `type: custom:<Name>` steht:

```yaml
---
type: custom:Besprechung
Datum: 2026-11-25
Status: geplant
---
```

## Modellieren

**Einstellungen → Notiztypen → Neuer Notiztyp.** Für die eigenen Notizen und für jede Gruppe, in der du schreiben darfst.

- **Name:** Buchstaben, Ziffern, Leerzeichen, `_`, `-` und Punkte; Groß- und Kleinschreibung ist egal. Nach einer Umbenennung gilt der alte Name weiter, Notizen müssen nicht geändert werden.
- **Frontmatter zusätzlich anzeigen:** Ohne Haken ist die Zeile mit dem Frontmatter ausgeblendet. Im Quelltext bleibt es immer sichtbar.
- **Eigenschaften anzeigen:** oben, rechts (neben dem Text, auf schmalen Bildschirmen darüber), unten oder ausgeblendet.
- **Eigenschaften:** Text, Zahl, Datum, Auswahl, Mehrfachauswahl, Kontrollkästchen oder Notiz-Link, in beliebiger Reihenfolge. Jede kann eine eigene Position haben. Vorgabewerte dürfen `{{date}}`, `{{title}}` und `{{zid}}` enthalten.

Die Werte stehen als normales Frontmatter in der Notiz; Datenbanken, Abfragen und andere Werkzeuge lesen sie wie bisher. Wird eine Eigenschaft umbenannt, ziehen ihre Werte in den Notizen mit (nicht im Online-Modus). Wird ein Typ gelöscht, bleiben Notizen und Werte erhalten.

## Verwenden

- **Vorlagen:** im Editor der Vorlage den Notiztyp wählen oder `type: custom:<Name>` selbst schreiben. Das gilt auch für Tages-, Wochen- und Monatsnotizen und für Vorlagen über MCP.
- **Neue Notiz:** den Notiztyp im Dialog wählen.
- **Bestehende Notiz:** ⋮ → **Notiztyp …**

Vorgabewerte füllen Eigenschaften, die die Notiz noch nicht nennt. Beim Eintippen von `type: custom:<Name>` in eine Notiz werden keine Vorgabewerte gesetzt.

## Geltungsbereich und Teilen

Ein Typ gilt in seinem Bereich (eigene Notizen oder eine Gruppe). In Gruppen und geteilten Notizen gelten ersatzweise deine eigenen Typen desselben Namens. Ist ein Typ nicht bekannt, zeigt die Notiz einen Hinweis und ihr Frontmatter wie gewohnt. Öffentliche Links zeigen die Eigenschaften wie modelliert, aber nur lesend. Ausgeblendet heißt dabei nicht geheim: Das Frontmatter ist Teil der Notiz und wird mit ihr übertragen.

Gespeichert wird ein Typ in einer ausgeblendeten Notiz `_type-<id>.md`, synchronisiert und verschlüsselt wie jede Notiz:

```yaml
---
type: note-type
name: Besprechung
frontmatter: hide
position: right
properties:
  - name: Datum
    type: date
    default: "{{date}}"
  - name: Status
    type: select
    options: [geplant, fertig]
    position: top
---
```
