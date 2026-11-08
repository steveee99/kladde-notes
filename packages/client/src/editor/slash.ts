import { Completion, CompletionContext, CompletionResult, startCompletion } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';
import { toDateString } from '@kladde/shared';

/**
 * Slash commands: "/" at the start of a line or after a space opens a menu of blocks (table, lists,
 * headings, code, query …). The typed "/word" is replaced by the block; `|` in a template marks the cursor.
 */
interface SlashCommand {
  label: string;
  detail: string;
  /** Extra search words (English names, abbreviations) */
  keywords: string;
  /** Markdown to insert; `|` is the cursor (or the selected range `|…|`). A function is evaluated at insert time */
  template?: string | (() => string);
  /** Cursor range inside the template instead of `|` marks (tables keep their pipes) */
  select?: [number, number];
  /** Block templates start on their own line */
  block?: boolean;
  run?: (view: EditorView, from: number, to: number) => void;
}

const TABLE = '| Spalte 1 | Spalte 2 | Spalte 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |';

export type FileInserter = (view: EditorView, files: File[], pos: number) => void;

function commands(insertFiles: FileInserter): SlashCommand[] {
  return [
    { label: 'Überschrift 1', detail: '#', keywords: 'h1 heading titel', template: '# |', block: true },
    { label: 'Überschrift 2', detail: '##', keywords: 'h2 heading', template: '## |', block: true },
    { label: 'Überschrift 3', detail: '###', keywords: 'h3 heading', template: '### |', block: true },
    { label: 'Liste', detail: '-', keywords: 'aufzählung bullet list ul punkte', template: '- |', block: true },
    { label: 'Nummerierte Liste', detail: '1.', keywords: 'numbered ordered ol zahlen', template: '1. |', block: true },
    { label: 'Aufgabe', detail: '- [ ]', keywords: 'todo task checkbox checkliste', template: '- [ ] |', block: true },
    { label: 'Tabelle', detail: '3 × 2', keywords: 'table grid', template: TABLE, select: [2, 10], block: true },
    { label: 'Zitat', detail: '>', keywords: 'quote blockquote', template: '> |', block: true },
    { label: 'Codeblock', detail: '```', keywords: 'code snippet pre', template: '```|\n\n```', block: true },
    { label: 'Trennlinie', detail: '---', keywords: 'divider hr linie separator', template: '---\n|', block: true },
    { label: 'Abfrage', detail: 'query', keywords: 'query table dataview tabelle', template: '```query\nTABLE title, updated\nFROM "|"\nSORT updated DESC\n```', block: true },
    { label: 'Kanban', detail: 'query', keywords: 'kanban board status spalten abfrage', template: '```query\nKANBAN BY status VALUES "offen", "läuft", "fertig"\nFROM "|"\n```', block: true },
    { label: 'Offene Aufgaben', detail: 'query', keywords: 'tasks todo query abfrage', template: '```query\nTASKS\nWHERE done = false|\n```', block: true },
    { label: 'Mindmap', detail: 'mindmap', keywords: 'mindmap gedanken map baum tree', template: '```mindmap\n|Thema\n- Idee 1\n  - Detail\n- Idee 2\n```', block: true },
    { label: 'Diagramm', detail: 'mermaid', keywords: 'mermaid diagram flowchart chart ablauf graph', template: '```mermaid\nflowchart LR\n  A[Start] --> B{Entscheidung}\n  B -->|Ja| C[Ergebnis]\n  B -->|Nein| A\n```', select: [28, 33], block: true },
    { label: 'Sequenzdiagramm', detail: 'mermaid', keywords: 'mermaid sequence diagramm ablauf', template: '```mermaid\nsequenceDiagram\n  Anna->>Ben: |Hallo\n  Ben-->>Anna: Hi!\n```', block: true },
    { label: 'Kreisdiagramm', detail: 'mermaid', keywords: 'mermaid pie chart torte', template: '```mermaid\npie title |Verteilung\n  "A" : 40\n  "B" : 35\n  "C" : 25\n```', block: true },
    { label: 'Galerie', detail: 'gallery', keywords: 'gallery bilder images', template: '```gallery\n|\n```', block: true },
    { label: 'Notiz verlinken', detail: '[[ ]]', keywords: 'link wiki verweis', template: '[[|]]' },
    { label: 'Link', detail: '[ ]( )', keywords: 'url web link', template: '[|](https://)' },
    { label: 'Datum heute', detail: 'YYYY-MM-DD', keywords: 'date today heute', template: () => `${toDateString(new Date())}|` },
    {
      label: 'Datei hochladen',
      detail: 'Bild/PDF',
      keywords: 'upload bild image pdf datei foto',
      run: (view, from, to) => {
        view.dispatch({ changes: { from, to, insert: '' } });
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*,application/pdf';
        input.multiple = true;
        input.onchange = () => {
          const files = [...(input.files ?? [])];
          if (files.length) insertFiles(view, files, from);
        };
        input.click();
      },
    },
  ];
}

/** Replaces "/word" with the template and puts the cursor at `|` (a second `|` selects the range) */
function applyTemplate(view: EditorView, cmd: SlashCommand, from: number, to: number) {
  const raw = typeof cmd.template === 'function' ? cmd.template() : cmd.template ?? '';
  const line = view.state.doc.lineAt(from);
  const before = view.state.doc.sliceString(line.from, from);
  const after = view.state.doc.sliceString(to, line.to);
  let prefix = '';
  if (cmd.block && before.trim()) {
    prefix = '\n';
    from = line.from + before.trimEnd().length;
  }
  let text = raw;
  if (cmd.block && after.trim()) text += '\n';
  const marks: number[] = [];
  if (!cmd.select) text = text.replace(/\|/g, (_m, offset: number) => (marks.push(offset - marks.length), ''));
  const start = from + prefix.length;
  const [a, h] = cmd.select ?? [marks[0] ?? text.length, marks[1] ?? marks[0] ?? text.length];
  const anchor = start + a;
  const head = start + h;
  view.dispatch({ changes: { from, to, insert: prefix + text }, selection: { anchor, head }, userEvent: 'input.complete' });
  if (cmd.label === 'Notiz verlinken') setTimeout(() => startCompletion(view));
}

export function slashCompletion(insertFiles: FileInserter) {
  const list = commands(insertFiles);
  const options: Completion[] = list.map((cmd) => ({
    label: cmd.label,
    detail: cmd.detail,
    type: 'slash',
    apply: (view, _c, from, to) => (cmd.run ? cmd.run(view, from - 1, to) : applyTemplate(view, cmd, from - 1, to)),
  }));
  return (ctx: CompletionContext): CompletionResult | null => {
    const m = ctx.matchBefore(/(?:^|\s)\/[\p{L}\d]*$/u);
    if (!m) return null;
    const slash = m.from + m.text.indexOf('/');
    // Not inside fenced code blocks
    const doc = ctx.state.doc;
    let fences = 0;
    for (let i = 1; i < doc.lineAt(slash).number; i++) if (/^\s*(```|~~~)/.test(doc.line(i).text)) fences++;
    if (fences % 2) return null;
    const query = m.text.slice(m.text.indexOf('/') + 1).toLowerCase();
    const matching = query
      ? options.filter((_o, i) => `${list[i].label} ${list[i].keywords}`.toLowerCase().split(/\s+/).some((w) => w.startsWith(query)))
      : options;
    if (!matching.length) return null;
    return { from: slash + 1, options: matching, filter: false };
  };
}
