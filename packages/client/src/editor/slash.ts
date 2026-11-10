import { Completion, CompletionContext, CompletionResult, startCompletion } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';
import { linkAllMentions, toDateString } from '@kladde/shared';
import { getLang, tl, type Lang } from '../lib/i18n';
import { editorHost } from './host';
import { noteIdFacet } from './livePreview';

/**
 * Slash commands: "/" at the start of a line or after a space opens a menu of blocks (table, lists,
 * headings, code, TOC, query …). The typed "/word" is replaced by the block; `|` in a template marks the cursor.
 */
interface SlashCommand {
  label: string;
  detail: string;
  /** Extra search words (German & English names, abbreviations) */
  keywords: string;
  /** Markdown to insert; `|` is the cursor (or the selected range `|…|`). A function is evaluated at insert time */
  template?: string | (() => string);
  /** Cursor range inside the template instead of `|` marks (tables keep their pipes) */
  select?: [number, number];
  /** Block templates start on their own line */
  block?: boolean;
  /** Open wiki link completion immediately after insert */
  openCompletions?: boolean;
  run?: (view: EditorView, from: number, to: number) => void;
}

export type FileInserter = (view: EditorView, files: File[], pos: number) => void;

function commands(insertFiles: FileInserter, lang: Lang): SlashCommand[] {
  const tableTpl = tl(lang, 'editor.slash.tableTemplate');
  const firstPipeEnd = tableTpl.indexOf('|', 2);
  return [
    { label: tl(lang, 'editor.slash.h1'), detail: '#', keywords: 'h1 heading titel ueberschrift', template: '# |', block: true },
    { label: tl(lang, 'editor.slash.h2'), detail: '##', keywords: 'h2 heading ueberschrift', template: '## |', block: true },
    { label: tl(lang, 'editor.slash.h3'), detail: '###', keywords: 'h3 heading ueberschrift', template: '### |', block: true },
    { label: tl(lang, 'editor.slash.toc'), detail: '##TOC##', keywords: 'toc inhaltsverzeichnis table of contents outline gliederung', template: '##TOC##\n|', block: true },
    { label: tl(lang, 'editor.slash.list'), detail: '-', keywords: 'aufzählung bullet list ul punkte', template: '- |', block: true },
    { label: tl(lang, 'editor.slash.orderedList'), detail: '1.', keywords: 'numbered ordered ol zahlen nummerierte liste', template: '1. |', block: true },
    { label: tl(lang, 'editor.slash.task'), detail: '- [ ]', keywords: 'todo task checkbox checkliste aufgabe', template: '- [ ] |', block: true },
    { label: tl(lang, 'editor.slash.table'), detail: '3 × 2', keywords: 'table grid tabelle', template: tableTpl, select: [2, Math.max(2, firstPipeEnd - 1)], block: true },
    { label: tl(lang, 'editor.slash.quote'), detail: '>', keywords: 'quote blockquote zitat', template: '> |', block: true },
    { label: tl(lang, 'editor.slash.code'), detail: '```', keywords: 'code snippet pre codeblock', template: '```|\n\n```', block: true },
    { label: tl(lang, 'editor.slash.hr'), detail: '---', keywords: 'divider hr linie separator trennlinie', template: '---\n|', block: true },
    { label: tl(lang, 'editor.slash.query'), detail: 'query', keywords: 'query table dataview tabelle abfrage', template: '```query\nTABLE title, updated\nFROM "|"\nSORT updated DESC\n```', block: true },
    {
      label: tl(lang, 'editor.slash.kanban'),
      detail: 'query',
      keywords: 'kanban board status spalten abfrage',
      template: lang === 'en' ? '```query\nKANBAN BY status VALUES "open", "in progress", "done"\nFROM "|"\n```' : '```query\nKANBAN BY status VALUES "offen", "läuft", "fertig"\nFROM "|"\n```',
      block: true,
    },
    { label: tl(lang, 'editor.slash.openTasks'), detail: 'query', keywords: 'tasks todo query abfrage aufgaben', template: '```query\nTASKS\nWHERE done = false|\n```', block: true },
    {
      label: tl(lang, 'editor.slash.mindmap'),
      detail: 'mindmap',
      keywords: 'mindmap gedanken map baum tree',
      template: lang === 'en' ? '```mindmap\n|Topic\n- Idea 1\n  - Detail\n- Idea 2\n```' : '```mindmap\n|Thema\n- Idee 1\n  - Detail\n- Idee 2\n```',
      block: true,
    },
    {
      label: tl(lang, 'editor.slash.diagram'),
      detail: 'mermaid',
      keywords: 'mermaid diagram flowchart chart ablauf graph diagramm',
      template: '```mermaid\nflowchart LR\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Result]\n  B -->|No| A\n```',
      select: [28, 33],
      block: true,
    },
    { label: tl(lang, 'editor.slash.sequence'), detail: 'mermaid', keywords: 'mermaid sequence diagramm ablauf sequenz', template: '```mermaid\nsequenceDiagram\n  Anna->>Ben: |Hello\n  Ben-->>Anna: Hi!\n```', block: true },
    { label: tl(lang, 'editor.slash.pie'), detail: 'mermaid', keywords: 'mermaid pie chart torte kreisdiagramm', template: '```mermaid\npie title |Share\n  "A" : 40\n  "B" : 35\n  "C" : 25\n```', block: true },
    { label: tl(lang, 'editor.slash.gallery'), detail: 'gallery', keywords: 'gallery bilder images galerie', template: '```gallery\n|\n```', block: true },
    { label: tl(lang, 'editor.slash.carousel'), detail: 'carousel', keywords: 'carousel karussell slider slideshow bilder images', template: '```carousel\n|\n```', block: true },
    { label: tl(lang, 'editor.slash.wikiLink'), detail: '[[ ]]', keywords: 'link wiki verweis notiz', template: '[[|]]', openCompletions: true },
    {
      label: tl(lang, 'editor.slash.linkAll'),
      detail: tl(lang, 'editor.slash.linkAllDetail'),
      keywords: 'linkify mentions autolink verlinken erwaehnungen',
      run: (view, from, to) => {
        view.dispatch({ changes: { from, to, insert: '' } });
        const currentId = view.state.facet(noteIdFacet);
        const targets = editorHost.autoLinkTargets(currentId);
        if (!targets.length) return;
        const doc = view.state.doc.toString();
        const updated = linkAllMentions(doc, targets);
        if (updated !== doc) {
          view.dispatch({ changes: { from: 0, to: doc.length, insert: updated }, userEvent: 'input' });
        }
      },
    },
    { label: tl(lang, 'editor.slash.webLink'), detail: '[ ]( )', keywords: 'url web link', template: '[|](https://)' },
    { label: tl(lang, 'editor.slash.today'), detail: 'YYYY-MM-DD', keywords: 'date today heute datum', template: () => `${toDateString(new Date())}|` },
    {
      label: tl(lang, 'editor.slash.upload'),
      detail: tl(lang, 'editor.slash.uploadDetail'),
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
  if (cmd.openCompletions) setTimeout(() => startCompletion(view));
}

export function slashCompletion(insertFiles: FileInserter) {
  let cachedLang: Lang | null = null;
  let cachedList: SlashCommand[] = [];
  let cachedOptions: Completion[] = [];

  const ensureCommands = () => {
    const lang = getLang();
    if (lang !== cachedLang) {
      cachedLang = lang;
      cachedList = commands(insertFiles, lang);
      cachedOptions = cachedList.map((cmd) => ({
        label: cmd.label,
        detail: cmd.detail,
        type: 'slash',
        apply: (view, _c, from, to) => (cmd.run ? cmd.run(view, from - 1, to) : applyTemplate(view, cmd, from - 1, to)),
      }));
    }
    return { list: cachedList, options: cachedOptions };
  };

  return (ctx: CompletionContext): CompletionResult | null => {
    const m = ctx.matchBefore(/(?:^|\s)\/[\p{L}\d]*$/u);
    if (!m) return null;
    const slash = m.from + m.text.indexOf('/');
    // Not inside fenced code blocks
    const doc = ctx.state.doc;
    let fences = 0;
    for (let i = 1; i < doc.lineAt(slash).number; i++) if (/^\s*(```|~~~)/.test(doc.line(i).text)) fences++;
    if (fences % 2) return null;
    const { list, options } = ensureCommands();
    const query = m.text.slice(m.text.indexOf('/') + 1).toLowerCase();
    const matching = query
      ? options.filter((_o, i) => `${list[i].label} ${list[i].keywords}`.toLowerCase().split(/\s+/).some((w) => w.startsWith(query)))
      : options;
    if (!matching.length) return null;
    return { from: slash + 1, options: matching, filter: false };
  };
}
