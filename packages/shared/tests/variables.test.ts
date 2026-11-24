import { describe, expect, it } from 'vitest';
import {
  cleanHeadingText,
  databaseRows,
  EMPTY_VARIABLE_SCOPE,
  escapeMarkdown,
  fillTemplate,
  fillVariables,
  findPlaceholders,
  fixedVariableScope,
  isHiddenPath,
  isVariableName,
  isVariablesPath,
  markdownPlaceholders,
  markdownToConfluence,
  maskVariables,
  MAX_VARIABLE_VALUE,
  parseMarkdownForExport,
  parseVariables,
  resolveVariables,
  resolveVariableUrl,
  runQuery,
  safeUrl,
  setVariable,
  splitMasked,
  usedVariables,
  variableDefinitions,
  variablesFileName,
  variableScope,
  writeVariables,
} from '../src/index';

const note = (folder: string, vars: Record<string, string>, file = '_variables.md') => ({
  path: folder ? `${folder}/${file}` : file,
  content: writeVariables(
    '',
    Object.entries(vars).map(([name, value]) => ({ name, value }))
  ),
});
const scopeOf = (folder: string, ...notes: { path: string; content: string }[]) => variableScope(folder, variableDefinitions(notes));
const one = (vars: Record<string, string>) => scopeOf('', note('', vars));

describe('definition notes', () => {
  it('knows its file names', () => {
    expect(isVariablesPath('A/_variables.md')).toBe(true);
    expect(isVariablesPath(variablesFileName('0b9f6c1e-3d52-4c0e-9a7e-5f1d2c3b4a69'))).toBe(true);
    expect(isVariablesPath('A/my_variables.md')).toBe(false);
    expect(isVariablesPath('A/_variables-notes.md')).toBe(false);
    expect(isVariablesPath('_variables/A.md')).toBe(false);
    expect(isHiddenPath('A/_variables.md')).toBe(true);
    expect(isHiddenPath('A/_database.md')).toBe(true);
    expect(isHiddenPath('A/note.md')).toBe(false);
  });

  it('writes and reads every kind of value', () => {
    const vars = { customer: 'ACME: "Nord" #1', repo: '{{var:base}}/x', Größe: '10', 'a.b-c_d': 'true', empty: '', list: '[a, b]', quote: "it's", url: 'https://h/p?q=1#x' };
    const content = note('', vars).content;
    expect(Object.fromEntries(parseVariables(content)!.map((d) => [d.name, d.value]))).toEqual(vars);
    const changed = writeVariables(`${content}\nText below\n`, setVariable(parseVariables(content)!, 'CUSTOMER', 'New'));
    expect(parseVariables(changed)!.find((d) => d.name === 'customer')!.value).toBe('New');
    expect(changed).toContain('Text below');
    expect(setVariable(parseVariables(content)!, 'größe', null)).toHaveLength(Object.keys(vars).length - 1);
  });

  it('reads hand-written notes and leaves out what is not valid', () => {
    const content =
      '---\ntype: variables\nvariables:\n  a: 1\n  A: second\n  bad name: x\n  list: [x, y]\n  block: |\n    one\n    two\n  nested:\n    k: v\n  __proto__: x\n---\n';
    expect(parseVariables(content)).toEqual([
      { name: 'a', value: '1' },
      { name: 'list', value: 'x, y' },
      { name: 'block', value: 'one two' },
    ]);
    expect(parseVariables('---\ntype: database\n---\n')).toBeNull();
    expect(parseVariables('text')).toBeNull();
    expect(parseVariables('---\ntype: variables\n---\n')).toEqual([]);
  });

  it('checks names', () => {
    for (const ok of ['a', 'Straße', '1x', '_x', 'a.b', 'a-b']) expect(isVariableName(ok)).toBe(true);
    for (const bad of ['', '-a', '.a', 'a b', 'a|b', 'a}', 'x'.repeat(65), '__proto__']) expect(isVariableName(bad)).toBe(false);
  });

  it('is no row of a database and no result of a query', () => {
    const notes = [
      { id: '1', ...note('F', { a: '1' }), createdAt: 1, updatedAt: 1 },
      { id: '2', path: 'F/Row.md', content: '', createdAt: 1, updatedAt: 1 },
    ];
    expect(databaseRows({ properties: [], views: [], subfolders: false }, 'F', notes).map((r) => r.title)).toEqual(['Row']);
    expect(runQuery('TABLE title\nFROM "F"', notes).rows.map((r) => r.noteId)).toEqual(['2']);
  });
});

describe('scope', () => {
  const root = note('', { name: 'root', only: 'top' });
  const a = note('A', { name: 'a' });
  const ab = note('A/B', { NAME: 'ab' });

  it('takes the nearest folder and inherits the rest', () => {
    expect(scopeOf('', root, a, ab).resolve('name').text).toBe('root');
    expect(scopeOf('A', root, a, ab).resolve('name').text).toBe('a');
    const deep = scopeOf('A/B/C', root, a, ab);
    expect(deep.resolve('Name').text).toBe('ab');
    expect(deep.resolve('only')).toMatchObject({ status: 'ok', text: 'top', entry: { folder: '' } });
    expect(deep.get('name')!.outer!.folder).toBe('A');
    expect(deep.list().map((e) => e.name)).toEqual(['NAME', 'only']);
    // A neighbour with the same beginning is no parent
    expect(scopeOf('AB', root, a, ab).resolve('name').text).toBe('root');
  });

  it('joins several definition notes of one folder, the first by path first', () => {
    const s = scopeOf('A', note('A', { x: '2', y: '2' }, '_variables-bbbbbbbb-1.md'), note('A', { x: '1' }, '_variables-aaaaaaaa-1.md'));
    expect(s.resolve('x').text).toBe('1');
    expect(s.resolve('y').text).toBe('2');
  });

  it('expands values from the folder of the note', () => {
    const s = (f: string) => scopeOf(f, note('', { base: 'https://h', repo: '{{var:base}}/r' }), note('A', { base: 'https://a' }));
    expect(s('').resolve('repo').text).toBe('https://h/r');
    expect(s('A').resolve('repo').text).toBe('https://a/r');
  });

  it('lets an override use the value it overrides', () => {
    const s = scopeOf('A/B', note('', { p: 'x' }), note('A', { p: '{{var:p}}/y' }), note('A/B', { p: '{{var:p}}/z' }));
    expect(s.resolve('p').text).toBe('x/y/z');
  });

  it('stops at cycles, unknown names and large values', () => {
    const s = one({ a: '{{var:b}}', b: '{{var:a}}', self: '{{var:self}}', miss: 'x {{var:gone}}', dflt: '{{var:gone|d}}' });
    expect(s.resolve('a')).toMatchObject({ status: 'cycle', text: '{{var:a}}' });
    expect(s.resolve('self').status).toBe('cycle');
    expect(s.resolve('miss')).toMatchObject({ status: 'unknown', text: 'x {{var:gone}}' });
    expect(s.resolve('dflt')).toMatchObject({ status: 'ok', text: 'd' });
    expect(s.resolve('gone')).toMatchObject({ status: 'unknown', text: '{{var:gone}}', entry: null });
    expect(s.resolve('gone', ' fb ')).toMatchObject({ status: 'fallback', text: 'fb' });

    const chain = one(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`v${i}`, `{{var:v${i + 1}}}`])));
    expect(chain.resolve('v0').status).toBe('limit');
    const bomb = one(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`v${i}`, i === 8 ? 'x' : `{{var:v${i + 1}}}`.repeat(50)])));
    const t0 = Date.now();
    expect(bomb.resolve('v0').status).toBe('limit');
    expect(Date.now() - t0).toBeLessThan(500);
    const long = one({ a: 'x'.repeat(MAX_VARIABLE_VALUE), b: '{{var:a}}{{var:a}}' });
    expect(long.resolve('b').status).toBe('limit');
  });

  it('bounds the text all values add', () => {
    const s = one({ a: 'x'.repeat(2000) });
    expect(resolveVariables('{{var:a}}'.repeat(5000), s).length).toBeLessThan(1_100_000);
  });

  it('keeps finished values as they are', () => {
    expect(fixedVariableScope({ a: '{{var:b}}', b: 'x' }).resolve('A').text).toBe('{{var:b}}');
  });
});

describe('placeholders', () => {
  const wild = '**b** [x](y) <i> `c` #t | _u_ a_b';
  const s = one({ name: 'ACME', md: wild, bad: 'javascript:alert(1)', sp: 'a b)c', link: 'https://h/x_y', num: '1. x', my_var: 'v' });

  it('finds names, fallbacks and the pipe of table cells', () => {
    expect(findPlaceholders('{{var:a}} {{var: b |x y}} {{var:c\\|d}} {{var:}} {{version}} {{var:a b}}').map((p) => [p.name, p.fallback])).toEqual([
      ['a', undefined],
      ['b', 'x y'],
      ['c', 'd'],
    ]);
  });

  it('leaves unknown ones visible and other placeholders alone', () => {
    expect(resolveVariables('{{var:name}} {{var:gone}} {{title}} {{version}} {{var:gone|x}}', s)).toBe('ACME {{var:gone}} {{title}} {{version}} x');
    expect(resolveVariables('{{var:name}}', EMPTY_VARIABLE_SCOPE)).toBe('{{var:name}}');
  });

  it('skips code, formulas, frontmatter and wiki links', () => {
    const md = ['---', 'x: {{var:name}}', '---', '{{var:name}} `{{var:name}}` ``a`{{var:name}}`` $x^{{var:name}}$', '```', '{{var:name}}', '```', '> ~~~', '> {{var:name}}', '> ~~~', '[[{{var:name}}]] {{var:name}}'].join('\n');
    expect(fillVariables(md, s)).toBe(md.replace('\n{{var:name}} `', '\nACME `').replace(']] {{var:name}}', ']] ACME'));
    expect(markdownPlaceholders(md)).toHaveLength(2);
  });

  it('knows the parts of URLs', () => {
    const inUrl = (md: string) => markdownPlaceholders(md).map((p) => p.inUrl);
    expect(inUrl('[a](https://h/{{var:name}}/{{var:name|x y}}) {{var:name}}')).toEqual([true, true, false]);
    expect(inUrl('![{{var:name}}]({{var:name}}/x.png)')).toEqual([false, true]);
    expect(inUrl('see https://h/{{var:name}} {{var:name}}')).toEqual([true, false]);
    expect(inUrl('({{var:name}})')).toEqual([false]);
  });

  it('builds URLs that safeUrl checks afterwards', () => {
    expect(resolveVariableUrl('https://h/{{var:sp}}', s)).toEqual({ url: 'https://h/a%20b%29c', complete: true });
    expect(safeUrl(resolveVariableUrl('{{var:bad}}', s).url)).toBeNull();
    expect(safeUrl(resolveVariableUrl('java{{var:gone|script}}:alert(1)', s).url)).toBeNull();
    expect(resolveVariableUrl('https://h/{{var:gone}}', s).complete).toBe(false);
    expect(resolveVariableUrl('https://h/{{var:gone|x}}', s)).toEqual({ url: 'https://h/x', complete: true });
  });

  it('escapes values in Markdown', () => {
    expect(fillVariables('A {{var:name}}', s)).toBe('A ACME');
    expect(fillVariables('{{var:md}}', s)).toBe('\\*\\*b\\*\\* \\[x\\](y) \\<i\\> \\`c\\` \\#t \\| \\_u\\_ a_b');
    expect(fillVariables('{{var:num}}', s)).toBe('1\\. x');
    expect(fillVariables('{{var:link}} [x](https://h/{{var:sp}})', s)).toBe('https://h/x_y [x](https://h/a%20b%29c)');
    expect(escapeMarkdown('- a &amp; {{x}}')).toBe('\\- a \\&amp; \\{\\{x}}');
  });

  it('masks values while Markdown is parsed', () => {
    const m = maskVariables('**{{var:md}}** {{var:name}}', s);
    expect(m.text).not.toContain('[x]');
    expect(splitMasked(m.text)).toEqual(['**', 0, '** ', 1]);
    expect(m.fill(m.text)).toBe(`**${wild}** ACME`);
  });

  it('keeps names with underscores in headings', () => {
    expect(cleanHeadingText('**A** {{var:my_var}} _x_')).toBe('A {{var:my_var}} x');
  });

  it('exports values as text', () => {
    const doc = parseMarkdownForExport('T', '# H {{var:name}}\n\n{{var:md}}\n\n{{var:num}}\n\n[l {{var:name}}](https://h/{{var:sp}})\n\n| a |\n|---|\n| {{var:md}} |\n\n##TOC##\n\n`{{var:name}}`', s);
    const text = { type: 'text', text: wild };
    expect(doc.blocks[0]).toMatchObject({ inlines: [{ type: 'text', text: 'H ACME' }] });
    expect(doc.blocks[1]).toEqual({ type: 'paragraph', inlines: [text] });
    expect(doc.blocks[2].type).toBe('paragraph');
    expect(doc.blocks[3]).toMatchObject({ inlines: [{ type: 'link', text: 'l ACME', url: 'https://h/a%20b%29c' }] });
    expect(doc.blocks[4]).toMatchObject({ type: 'table', rows: [[[text]]] });
    expect(doc.blocks[5]).toMatchObject({ type: 'toc', items: [{ text: 'H ACME' }] });
    expect(doc.blocks[6]).toMatchObject({ inlines: [{ type: 'code', text: '{{var:name}}' }] });
  });

  it('escapes values on Confluence pages', () => {
    const page = markdownToConfluence('A.md', '{{var:md}} [x]({{var:bad}})', { variables: s });
    expect(page.body).toContain('&lt;i&gt;');
    expect(page.body).not.toContain('href="javascript');
  });

  it('gives public links only the values that are used', () => {
    expect(usedVariables('{{var:Name}} {{var:gone}} `{{var:sp}}` [x](https://h/{{var:link}})', s)).toEqual({ name: 'ACME', link: 'https://h/x_y' });
  });

  it('stays in notes made from a template', () => {
    expect(fillTemplate('{{title}} {{var:name}} {{var:title}} {{date}}', { title: 'T', date: 'D' })).toBe('T {{var:name}} {{var:title}} D');
  });

  it('is linear on hostile text', () => {
    const t0 = Date.now();
    for (const text of [
      '{{var:'.repeat(50_000),
      '{{var:a|'.repeat(50_000),
      `{{var:a}}${'`'.repeat(100_000)}`,
      '{{var:a}} https://'.repeat(20_000),
      `${'](('.repeat(50_000)}{{var:a}}`,
      `{{var:${'a'.repeat(200_000)}`,
    ])
      fillVariables(text, s);
    expect(Date.now() - t0).toBeLessThan(4000);
  });
});
