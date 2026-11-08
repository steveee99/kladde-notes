import { INBOX_FOLDER, ZETTEL_FOLDER, toDateString } from '@kladde/shared';

/** Example content for a new space: shows every feature once */
export function welcomeNotes(): { folder: string; title: string; content: string }[] {
  const today = new Date();
  const d = (n: number) => {
    const x = new Date(today);
    x.setDate(x.getDate() + n);
    return toDateString(x);
  };
  return [
    {
      folder: INBOX_FOLDER,
      title: 'Willkommen',
      content: `# Willkommen bei Kladde 👋

Alles hier ist **Markdown**. Steht der Cursor nicht in einer Zeile, siehst du sie fertig formatiert – tippe hinein, um den Quelltext zu bearbeiten.

## Aufgaben
- [ ] Mit Kladde vertraut machen 📅 ${d(0)}
- [ ] Wochenrückblick schreiben 📅 ${d(2)} 🔁 wöchentlich
- [ ] Pflanzen gießen due:${d(-1)} every:3 tage
- [x] App installieren

Aufgaben mit Datum erscheinen auf dem **Startbildschirm**. Am Handy geht es auch ohne Emoji: \`due:morgen\` und \`every:week\`.

## Tabellen
| Projekt | Status | Fortschritt |
| --- | --- | --- |
| Garten | aktiv | 40 |
| Umzug | geplant | 5 |
| Website | fertig | 100 |
| Steuer | aktiv | 70 |

Klicke auf eine Spaltenüberschrift zum Sortieren oder filtere über das Suchfeld.

## Abfragen
\`\`\`query
TABLE title, status, updated
FROM "1 Projekte"
SORT updated DESC
\`\`\`

## Code
\`\`\`ts
function greet(name: string) {
  return \`Hallo \${name}!\`;
}
\`\`\`

## Verknüpfen
Verlinke Notizen mit [[Beispielprojekt]] oder lege einen neuen Zettel an. #start

## PARA und Zettelkasten
- **Inbox**: Schnell Erfasstes landet hier und wird einsortiert – in ein Projekt, einen Bereich, eine Ressource, als Zettel oder ins Archiv.
- **Projekte** haben einen Status und werden mit „Abschließen“ archiviert.
- **Wochenrückblick**: zeigt, was Aufmerksamkeit braucht.
- **Wissensnetz**: alle Verbindungen als Graph.
`,
    },
    {
      folder: '1 Projekte',
      title: 'Beispielprojekt',
      content: `---
status: aktiv
---
# Beispielprojekt

Ein Projekt nach der **PARA**-Methode: Projekte haben ein Ziel und ein Ende.

- [ ] Ersten Meilenstein festlegen 📅 ${d(5)}
- [ ] Kickoff #projekt

Zurück zur [[Willkommen]]-Notiz.
`,
    },
    {
      folder: ZETTEL_FOLDER,
      title: `${toDateString(today).replace(/-/g, '')}0900 Zettelkasten`,
      content: `---
id: ${toDateString(today).replace(/-/g, '')}0900
typ: dauerhaft
---
# Zettelkasten

Ein Gedanke pro Zettel, in eigenen Worten, mit Verbindungen zu anderen Zetteln, z. B. [[Willkommen]].
Unten in jeder Notiz siehst du, welche Zettel auf sie verweisen (Backlinks), wo sie nur erwähnt wird und ihr lokales Netz.
Die feste ID oben macht Links wie [[${toDateString(today).replace(/-/g, '')}0900]] unabhängig vom Titel.
`,
    },
  ];
}
