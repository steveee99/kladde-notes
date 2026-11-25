# Variablen

[English](VARIABLES.md)

Variablen halten Werte fest, die in vielen Notizen vorkommen: ein Kunde, ein Hostname, die Adresse eines Repositories. Sie werden in einem Ordner (oder einer Gruppe) definiert, an Unterordner vererbt und lassen sich dort überschreiben. Notizen zeigen den aktuellen Wert; im Text bleibt der Platzhalter stehen, eine Änderung wirkt also in allen Notizen.

## Verwenden

```
{{var:kunde}}
{{var:kunde|niemand}}
[Repository](https://git.example.com/{{var:kunde}})
```

- `{{var:name}}` zeigt den Wert, `{{var:name|Ersatz}}` den Ersatzwert, wenn die Variable nicht definiert ist. Ohne beides bleibt der Platzhalter sichtbar und ist als unbekannt markiert.
- Namen bestehen aus Buchstaben, Ziffern, `_`, `-` und `.`; Groß- und Kleinschreibung ist egal.
- Werte sind reiner Text: Markdown oder HTML darin wird nicht ausgewertet. Ein Wert, der eine Webadresse ist, wird zum Link. In Links und Bildern werden Werte Teil der Adresse (dort keine Leerzeichen im Platzhalter).
- In Code, Formeln, `[[Links]]`, Abfrage-Ergebnissen und im Frontmatter wird nichts ersetzt; eine Datenbank zeigt Werte in ihren Zellen, wo diese keine Eingabefelder sind. In einer Markdown-Tabelle schreibt man den Strich des Ersatzwerts als `\|`.
- `{{` oder `/Variable` bietet die Variablen des Ordners an. Der Tooltip eines Werts nennt die Variable und den Ordner, aus dem sie kommt.
- Vorlagen behalten den Platzhalter, daraus erstellte Notizen folgen also der Variable.
- Word-, PDF-, Folien- und Markdown-Export, Confluence-Seiten, Präsentationen und öffentliche Links enthalten die Werte. Der Exportordner des Servers, Kontoexporte, MCP und „Als Markdown kopieren“ enthalten die Notiz wie geschrieben.

## Eingebaute Datumsvariablen

Sie funktionieren in jeder Notiz und Vorlage, ohne sie anzulegen, und zeigen immer das Datum des Tages, an dem die
Notiz gelesen wird (wie jede Variable werden sie beim Anzeigen und Exportieren eingesetzt). Eine gleichnamige Variable
eines Ordners hat Vorrang. Jede gibt es auf Deutsch und Englisch.

| Deutsch | Englisch | Beispiel (Mi 25.11.2026) |
| --- | --- | --- |
| `heute` | `today` | 2026-11-25 |
| `morgen` | `tomorrow` | 2026-11-26 |
| `gestern` | `yesterday` | 2026-11-24 |
| `woche` | `week` | 2026-W48 |
| `nächsteWoche` | `nextWeek` | 2026-W49 |
| `letzteWoche` | `lastWeek` | 2026-W47 |
| `kw` | `weekNumber` | 48 |
| `wochenstart` / `wochenende` | `weekStart` / `weekEnd` | 2026-11-23 / 2026-11-29 |
| `nächsterMontag` | `nextWeekStart` | 2026-11-30 |
| `monat` | `month` | 2026-11 |
| `nächsterMonat` / `letzterMonat` | `nextMonth` / `lastMonth` | 2026-12 / 2026-10 |
| `jahr` / `nächstesJahr` | `year` / `nextYear` | 2026 / 2027 |

`{{` in einer Notiz oder Vorlage schlägt sie unter den Variablen des Ordners vor.

## Definieren

**Variablen …** im Kopf eines Ordners, von „Alle Notizen“ (oberste Ebene) oder einer Gruppe, oder im Menü eines Ordners in der Seitenleiste. Der Dialog zeigt die eigenen Variablen des Ordners und die geerbten mit ihrer Herkunft und **Überschreiben**. Leser einer Gruppe sehen sie, können sie aber nicht ändern.

Ein Wert darf andere Variablen enthalten, zum Beispiel `repo` = `https://{{var:host}}/{{var:kunde}}`. Sie werden vom Ordner der Notiz aus gesucht: Wird `kunde` in einem Unterordner überschrieben, ändert sich dort auch `repo`. Ein Wert, der sich selbst nennt, meint den überschriebenen (`pfad` = `{{var:pfad}}/unten`). Kreise und Werte über 2.000 Zeichen werden als Fehler markiert.

Gespeichert werden sie in einer ausgeblendeten Notiz `_variables-<id>.md` im Ordner (auch `_variables.md` geht), synchronisiert und verschlüsselt wie jede Notiz:

```yaml
---
type: variables
variables:
  kunde: ACME
  repo: "https://{{var:host}}/{{var:kunde}}"
---
```

## Geltungsbereich und Teilen

- Der nächste Ordner gewinnt, bis zur obersten Ebene der eigenen Notizen oder der Gruppe. Zwischen verschiedenen Bereichen wird nichts vererbt, und eine eingebettete Notiz nutzt die Variablen ihres eigenen Ordners.
- Geteilte Notizen: Empfänger sehen die Variablen, auf die sie Zugriff haben, also die eines geteilten Ordners und seiner Unterordner. Variablen nicht geteilter Ordner erscheinen als unbekannt (oder mit Ersatzwert). Eine Notiz zu teilen verrät nie die Variablen ihres Ordners.
- Öffentliche Links: Der Server schickt nur die fertigen Werte der Variablen, die die Seite verwendet. Wer eine Notiz mit öffentlichem Link bearbeiten darf, kann `{{var:…}}` einfügen und so eine Variable ihres Ordners auf der Seite zeigen. Dasselbe gilt für Notizen, die mit Confluence synchronisiert werden.
