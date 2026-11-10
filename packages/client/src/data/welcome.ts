import { INBOX_FOLDER, toDateString } from '@kladde/shared';
import { getLang, type Lang } from '../lib/i18n';

/** Example content for a new space: shows core features while PARA & Zettelkasten remain opt-in */
export function welcomeNotes(lang: Lang = getLang()): { folder: string; title: string; content: string }[] {
  const today = new Date();
  const d = (n: number) => {
    const x = new Date(today);
    x.setDate(x.getDate() + n);
    return toDateString(x);
  };

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
| Topic | Status | Progress |
| --- | --- | --- |
| Garden | aktiv | 40 |
| Moving | geplant | 5 |
| Website | fertig | 100 |
| Taxes | aktiv | 70 |

Click any column header to sort or use the filter input above the table.

## Queries
\`\`\`query
TABLE title, updated
FROM "0 Inbox"
SORT updated DESC
\`\`\`

## Code
\`\`\`ts
function greet(name: string) {
  return \`Hello \${name}!\`;
}
\`\`\`

## Organization & Features
- **Inbox**: Quick captures land here before you sort them into your folders.
- **Linking**: Connect notes with \`[[Note title]]\` or explore connections in the **Knowledge Graph**. #start
- **Weekly Review**: Highlights overdue items and notes needing attention.
- **Optional workflows**: Enable **PARA method**, **Zettelkasten**, or **Recipe import** (with custom target folders) anytime in **Settings**.
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
| Thema | Status | Fortschritt |
| --- | --- | --- |
| Garten | aktiv | 40 |
| Umzug | geplant | 5 |
| Website | fertig | 100 |
| Steuer | aktiv | 70 |

Klicke auf eine Spaltenüberschrift zum Sortieren oder filtere über das Suchfeld.

## Abfragen
\`\`\`query
TABLE title, updated
FROM "0 Inbox"
SORT updated DESC
\`\`\`

## Code
\`\`\`ts
function greet(name: string) {
  return \`Hallo \${name}!\`;
}
\`\`\`

## Organisation & Funktionen
- **Inbox**: Schnell Erfasstes landet hier und wartet auf das Einsortieren in deine Ordner.
- **Verknüpfen**: Verlinke Notizen mit \`[[Notiztitel]]\` und entdecke Zusammenhänge im **Wissensnetz**. #start
- **Wochenrückblick**: zeigt, was Aufmerksamkeit braucht.
- **Optionale Arbeitsweisen**: Aktiviere **PARA-Methode**, **Zettelkasten** oder den **Rezeptimport** (jeweils mit freiem Zielordner) jederzeit in den **Einstellungen**.
`,
    },
  ];
}
