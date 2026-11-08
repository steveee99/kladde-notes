import { PARA } from './para.js';
import { toDateString } from './tasks.js';

/** Built-in templates; notes in a folder named "Vorlagen" are offered as templates too */
export interface Template {
  id: string;
  label: string;
  /** Folder new notes from this template go to */
  folder: string;
  content: string;
}

export const TEMPLATE_FOLDER_NAME = 'Vorlagen';

export const BUILTIN_TEMPLATES: Template[] = [
  {
    id: 'projekt',
    label: 'Projekt',
    folder: PARA.projects,
    content: `---
status: aktiv
ziel: 
frist: 
---
# {{title}}

## Ziel
Woran merke ich, dass das Projekt fertig ist?

## Nächste Schritte
- [ ] 

## Notizen
`,
  },
  {
    id: 'bereich',
    label: 'Bereich',
    folder: PARA.areas,
    content: `---
standard: 
---
# {{title}}

Ein Bereich hat kein Ende, sondern einen Standard, den ich halten will.

## Standard

## Laufende Projekte
\`\`\`query
LIST FROM "${PARA.projects}" WHERE bereich = "{{title}}" AND status != fertig
\`\`\`

## Wiederkehrendes
- [ ] 
`,
  },
  {
    id: 'literatur',
    label: 'Literaturnotiz',
    folder: PARA.zettel,
    content: `---
id: {{zid}}
typ: literatur
quelle: 
autor: 
---
# {{title}}

## Kernaussagen (in eigenen Worten)
- 

## Was bedeutet das für mich?

## Verbindungen
- [[]]
`,
  },
  {
    id: 'besprechung',
    label: 'Besprechung',
    folder: PARA.inbox,
    content: `---
datum: {{date}}
teilnehmer: 
---
# {{title}}

## Themen
- 

## Entscheidungen
- 

## Aufgaben
- [ ]  📅 {{date}}
`,
  },
  {
    id: 'tag',
    label: 'Tagesnotiz',
    folder: PARA.inbox,
    content: `# {{date}}

## Heute wichtig
- [ ]  📅 {{date}}

## Notizen
`,
  },
];

export function fillTemplate(content: string, vars: { title: string; date?: string; zid?: string }): string {
  const date = vars.date ?? toDateString(new Date());
  return content.replace(/\{\{title\}\}/g, vars.title).replace(/\{\{date\}\}/g, date).replace(/\{\{zid\}\}/g, vars.zid ?? '');
}
