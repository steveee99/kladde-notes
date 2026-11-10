import { INBOX_FOLDER, ZETTEL_FOLDER, toDateString } from '@kladde/shared';
import { getLang, type Lang } from '../lib/i18n';

/** Example content for a new space: shows every feature once */
export function welcomeNotes(lang: Lang = getLang()): { folder: string; title: string; content: string }[] {
  const today = new Date();
  const d = (n: number) => {
    const x = new Date(today);
    x.setDate(x.getDate() + n);
    return toDateString(x);
  };
  const zid = `${toDateString(today).replace(/-/g, '')}0900`;

  if (lang === 'en') {
    return [
      {
        folder: INBOX_FOLDER,
        title: 'Welcome',
        content: `# Welcome to Kladde 👋

##TOC##

Everything here is **Markdown**. When your cursor leaves a line, it renders formatted – move your cursor back in to edit the raw syntax.

## Tasks
- [ ] Get familiar with Kladde 📅 ${d(0)}
- [ ] Write weekly review 📅 ${d(2)} 🔁 weekly
- [ ] Water plants due:${d(-1)} every:3 days
- [x] Install the app

Tasks with dates automatically show up on the **Home** screen. On mobile, quick keywords work without emoji: \`due:tomorrow\` and \`every:week\`.

## Tables
| Project | Status | Progress |
| --- | --- | --- |
| Garden | aktiv | 40 |
| Moving | geplant | 5 |
| Website | fertig | 100 |
| Taxes | aktiv | 70 |

Click any column header to sort or use the filter input above the table.

## Queries
\`\`\`query
TABLE title, status, updated
FROM "1 Projekte"
SORT updated DESC
\`\`\`

## Code
\`\`\`ts
function greet(name: string) {
  return \`Hello \${name}!\`;
}
\`\`\`

## Linking
Link notes using [[Sample project]] or create a new Zettel note. #start

## PARA and Zettelkasten
- **Inbox**: Quick captures land here before you sort them into a project, area, resource, Zettel, or archive.
- **Projects** have a status and move to the archive when you finish them.
- **Weekly Review**: Highlights overdue items and notes needing attention.
- **Knowledge Graph**: Explore all connections visually.
`,
      },
      {
        folder: '1 Projekte',
        title: 'Sample project',
        content: `---
status: aktiv
---
# Sample project

A project following the **PARA** method: projects have a clear goal and a deadline.

- [ ] Define first milestone 📅 ${d(5)}
- [ ] Kickoff #project

Back to [[Welcome]].
`,
      },
      {
        folder: ZETTEL_FOLDER,
        title: `${zid} Zettelkasten`,
        content: `---
id: ${zid}
typ: dauerhaft
---
# Zettelkasten

One idea per note, written in your own words and linked to other notes such as [[Welcome]].
Open the split pane on the right to see the table of contents, backlinks, unlinked mentions, and local graph.
The permanent ID above keeps links like [[${zid}]] working even if you rename the title.
`,
      },
    ];
  }

  return [
    {
      folder: INBOX_FOLDER,
      title: 'Willkommen',
      content: `# Willkommen bei Kladde 👋

##TOC##

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
      title: `${zid} Zettelkasten`,
      content: `---
id: ${zid}
typ: dauerhaft
---
# Zettelkasten

Ein Gedanke pro Zettel, in eigenen Worten, mit Verbindungen zu anderen Zetteln, z. B. [[Willkommen]].
In der Seitenansicht rechts siehst du das Inhaltsverzeichnis, Verlinkungen (Backlinks und unverlinkte Erwähnungen) sowie das lokale Wissensnetz.
Die feste ID oben macht Links wie [[${zid}]] unabhängig vom Titel.
`,
    },
  ];
}
