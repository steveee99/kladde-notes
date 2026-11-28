import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { scriptCompletion } from '../src/editor/processScript';

// The script editor's suggestions: functions, recipients, run variables, step ids and templates where they fit

const hints = { variables: ['protokoll', 'runde'], steps: [{ id: 't1', label: 'Test' }], templates: ['Testprotokoll'], people: ['ben'], lang: 'en' as const };
const at = (text: string) => {
  const state = EditorState.create({ doc: text });
  const r = scriptCompletion(() => hints)(new CompletionContext(state, text.length, false));
  return r ? { from: r.from, labels: r.options.map((o) => o.label) } : null;
};

describe('script editor suggestions', () => {
  it('offers functions and variables at the start of a line', () => {
    expect(at('noti')!.labels).toContain('notify');
    expect(at('if ru')!.labels).toContain('runde');
  });
  it('offers recipients inside notify and people after @', () => {
    expect(at('notify("al')).toEqual({ from: 8, labels: ['owner', 'me', 'all', '@ben'] });
    expect(at('notify("owner @b')!.from).toBe(14);
  });
  it('offers run variables inside {{run.', () => {
    expect(at('notify("all", "Ready: {{run.ti')!.labels).toContain('title');
    expect(at('log("x {{run.ti')!.labels).toEqual(['title', 'ticket', 'target', 'branch', 'repos', 'protokoll', 'runde']);
  });
  it('offers step ids, variables and templates for their arguments', () => {
    expect(at('done("')!.labels).toEqual(['t1']);
    expect(at('inc("')!.labels).toEqual(['protokoll', 'runde']);
    expect(at('x = note("Pfad", "Te')!.labels).toEqual(['Testprotokoll']);
  });
  it('stays quiet in comments and other strings', () => {
    expect(at('# noti')).toBeNull();
    expect(at('log("noti')).toBeNull();
  });
});

describe('script editor highlighting', () => {
  it('reads every half-typed line without getting stuck', async () => {
    const { processScriptLanguage } = await import('../src/editor/processScript');
    const { StringStream } = await import('@codemirror/language');
    const parser = (processScriptLanguage as unknown as { streamParser: { startState: (n: number) => { quote: string }; token: (s: InstanceType<typeof StringStream>, st: { quote: string }) => string | null } }).streamParser;
    const line = 'if a == "x {{ {{run. {{run.title}}": notify("@ben", \'y\') # z';
    for (let end = 1; end <= line.length; end++) {
      const text = line.slice(0, end);
      const stream = new StringStream(text, 2, 2);
      const state = parser.startState(2);
      const tokens: [string, string | null][] = [];
      while (!stream.eol()) {
        stream.start = stream.pos;
        const style = parser.token(stream, state);
        expect(stream.pos).toBeGreaterThan(stream.start);
        tokens.push([text.slice(stream.start, stream.pos), style]);
      }
      if (end === line.length) {
        expect(tokens).toContainEqual(['{{run.title}}', 'variableName.special']);
        expect(tokens).toContainEqual(['notify', 'variableName.function']);
        expect(tokens.at(-1)).toEqual(['# z', 'comment']);
      }
    }
  });
});
