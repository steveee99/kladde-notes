/**
 * The editor for process stage scripts (shared/processScript.ts): highlighting, completion and inline problems for
 * the small script language. Used by `views/ScriptEditor.tsx`, which mounts it only while a script is being edited.
 */
import { StreamLanguage, HighlightStyle, syntaxHighlighting, type StreamParser } from '@codemirror/language';
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { linter, type Diagnostic } from '@codemirror/lint';
import type { Extension } from '@codemirror/state';
import { tags as t } from '@lezer/highlight';
import { parseScript, SCRIPT_FUNCTIONS, RUN_FIELDS } from '@kladde/shared';
import { syntaxRules } from './syntaxRules';

const KEYWORDS = new Set(['if', 'and', 'or', 'not']);
const FUNCTIONS = new Set(SCRIPT_FUNCTIONS.map((f) => f.name));

interface State {
  /** The quote of the string the line is in, '' outside */
  quote: string;
}

/** Line based tokens: comments, strings (with `{{run.x}}` marked inside), numbers, keywords, calls, names */
const parser: StreamParser<State> = {
  name: 'kladde-process-script',
  startState: () => ({ quote: '' }),
  token(stream, state) {
    if (state.quote) {
      if (stream.match(/^\{\{\s*run\.[A-Za-z][A-Za-z0-9_]*\s*\}\}/)) return 'variableName.special';
      while (!stream.eol()) {
        if (stream.match(/^\\./)) continue;
        if (stream.peek() === state.quote) {
          stream.next();
          state.quote = '';
          return 'string';
        }
        // Stop before a variable, but only after reading something: a token must never be empty
        if (stream.pos > stream.start && stream.match(/^\{\{\s*run\./, false)) return 'string';
        stream.next();
      }
      // A string never runs over the end of its line
      state.quote = '';
      return 'string';
    }
    if (stream.eatSpace()) return null;
    if (stream.peek() === '#') {
      stream.skipToEnd();
      return 'comment';
    }
    const ch = stream.peek();
    if (ch === '"' || ch === "'") {
      stream.next();
      state.quote = ch;
      return 'string';
    }
    if (stream.match(/^\d+(\.\d+)?/)) return 'number';
    const word = stream.match(/^[A-Za-z_][A-Za-z0-9_.]*/) as RegExpMatchArray | null;
    if (word) {
      const w = word[0];
      if (KEYWORDS.has(w)) return 'keyword';
      if (FUNCTIONS.has(w) && stream.match(/^\s*\(/, false)) return 'variableName.function';
      return RUN_FIELDS.includes(w.replace(/^run\./, '')) ? 'propertyName' : 'variableName';
    }
    if (stream.match(/^(==|!=|<=|>=|[<>=+-])/)) return 'operator';
    stream.next();
    return 'punctuation';
  },
  blankLine: (state) => void (state.quote = ''),
  languageData: { commentTokens: { line: '#' } },
};

export const processScriptLanguage = StreamLanguage.define(parser);

const scriptHighlight = HighlightStyle.define([
  ...syntaxRules,
  { tag: t.special(t.variableName), color: 'rgb(var(--syn-escape))' },
  { tag: t.variableName, color: 'rgb(var(--text))' },
  { tag: t.punctuation, color: 'rgb(var(--syn-punct))' },
]);

/** What completion offers: known names of the model and its space */
export interface ScriptHints {
  variables: string[];
  /** Step ids, the current stage's first */
  steps: { id: string; label: string }[];
  templates: string[];
  people: string[];
  lang: 'de' | 'en';
}

const RECIPIENTS = [
  { label: 'owner', de: 'wer den Lauf gestartet hat', en: 'who started the run' },
  { label: 'me', de: 'wer den Lauf gerade bewegt', en: 'who moves the run' },
  { label: 'all', de: 'alle, die den Lauf sehen', en: 'everyone who sees the run' },
];

/** The call and the argument the cursor is in, when it is inside a string argument */
function stringArgument(before: string): { fn: string; arg: number; typed: string } | null {
  const m = /([A-Za-z]+)\(((?:\s*(?:"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|[^,"'()]+)\s*,)*)\s*["']([^"']*)$/.exec(before);
  if (!m) return null;
  const done = m[2].trim() ? m[2].split(',').length - 1 : 0;
  return { fn: m[1], arg: done, typed: m[3] };
}

export function scriptCompletion(hints: () => ScriptHints) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);
    if (/^\s*#/.test(before)) return null;
    const h = hints();
    const vars = [...RUN_FIELDS, ...h.variables];
    // {{run.… inside a string
    const tpl = /\{\{\s*run\.([A-Za-z0-9_]*)$/.exec(before);
    if (tpl) {
      return {
        from: ctx.pos - tpl[1].length,
        options: vars.map((v): Completion => ({ label: v, type: 'variable', apply: `${v}}}` })),
        validFor: /^[A-Za-z0-9_]*$/,
      };
    }
    const arg = stringArgument(before);
    if (arg) {
      const from = ctx.pos - arg.typed.length;
      if ((arg.fn === 'done' || arg.fn === 'undone') && arg.arg === 0) return { from, options: h.steps.map((s) => ({ label: s.id, detail: s.label, type: 'constant' })), validFor: /^[\w-]*$/ };
      if ((arg.fn === 'set' || arg.fn === 'inc' || arg.fn === 'clear') && arg.arg === 0) return { from, options: h.variables.map((v) => ({ label: v, type: 'variable' })), validFor: /^\w*$/ };
      if (arg.fn === 'note' && arg.arg === 1) return { from, options: h.templates.map((name) => ({ label: name, type: 'text' })) };
      if (arg.fn === 'notify' && arg.arg === 0) {
        const word = /(@?[\w.-]*)$/.exec(arg.typed)![1];
        return {
          from: ctx.pos - word.length,
          options: [...RECIPIENTS.map((r) => ({ label: r.label, detail: h.lang === 'de' ? r.de : r.en, type: 'keyword' })), ...h.people.map((p) => ({ label: `@${p}`, type: 'variable' }))],
          validFor: /^@?[\w.-]*$/,
        };
      }
      return null;
    }
    // Inside a string elsewhere: nothing to offer
    const quotes = (before.match(/(?<!\\)["']/g) ?? []).length;
    if (quotes % 2 === 1) return null;
    const word = ctx.matchBefore(/[A-Za-z_][\w.]*/);
    if (!word && !ctx.explicit) return null;
    const from = word ? word.from : ctx.pos;
    const atStart = /^\s*(?:if\b.*:\s*)?[\w.]*$/.test(before);
    const options: Completion[] = [
      ...SCRIPT_FUNCTIONS.map((f) => ({ label: f.name, detail: f.args, info: h.lang === 'de' ? f.de : f.en, type: 'function', apply: `${f.name}(` })),
      ...vars.map((v) => ({ label: v, type: 'variable', boost: -1 })),
      ...(atStart ? [{ label: 'if', type: 'keyword', apply: 'if ', boost: 1 }] : [{ label: 'and', type: 'keyword' }, { label: 'or', type: 'keyword' }, { label: 'not', type: 'keyword' }]),
    ];
    return { from, options, validFor: /^[\w.]*$/ };
  };
}

/** The problems `parseScript` finds, at their lines */
const problems = linter(
  (view) => {
    const doc = view.state.doc;
    return parseScript(doc.toString()).errors.flatMap((e): Diagnostic[] => {
      if (e.line > doc.lines) return [];
      const line = doc.line(e.line);
      const indent = line.text.length - line.text.trimStart().length;
      return [{ from: line.from + indent, to: Math.max(line.from + indent, line.to), severity: 'error', message: e.message }];
    });
  },
  { delay: 300 }
);

export function processScriptExtensions(hints: () => ScriptHints): Extension {
  return [processScriptLanguage, syntaxHighlighting(scriptHighlight), autocompletion({ override: [scriptCompletion(hints)], activateOnTyping: true, icons: false }), problems];
}
