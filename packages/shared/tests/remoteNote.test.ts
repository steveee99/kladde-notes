import { describe, expect, it } from 'vitest';
import {
  clearRemoteSource,
  keepRemoteBody,
  normalizeRemoteHost,
  parseRemoteUrl,
  prepareRemoteMarkdown,
  publicRemoteContent,
  remoteNoteMarkdown,
  remoteNoteOf,
  remoteProjectAllowed,
  remoteWebUrl,
  resolveRemoteSource,
  searchableText,
  searchNotes,
  setRemoteSource,
  variableScope,
  type RemoteBase,
  type RemoteHost,
  type RemoteSnapshot,
} from '../src';

const hosts: RemoteHost[] = [
  { kind: 'gitlab', url: 'https://gitlab.example.com' },
  { kind: 'gitlab', url: 'https://example.org/tools/gitlab' },
  { kind: 'github', url: 'https://github.com' },
  { kind: 'github', url: 'https://ghe.example.com' },
  { kind: 'gitlab', url: 'http://10.0.0.5:8080' },
];

/** project | ref:path, ref:path … or the problem */
function parse(url: string, ref?: string): string {
  const r = parseRemoteUrl(url, hosts, ref);
  if (!r.ok) return r.problem;
  return `${r.target.project} | ${r.target.candidates.map((c) => `${c.ref}:${c.path}`).join(', ')}`;
}

describe('remote note frontmatter', () => {
  it('reads and writes the source', () => {
    const content = remoteNoteMarkdown({ source: 'https://gitlab.example.com/a/{{var:p|x}}/-/blob/main/README.md', ref: '' });
    expect(content).toBe('---\ntype: remote\nsource: "https://gitlab.example.com/a/{{var:p|x}}/-/blob/main/README.md"\n---\n');
    expect(remoteNoteOf(content)).toEqual({ source: 'https://gitlab.example.com/a/{{var:p|x}}/-/blob/main/README.md', ref: '' });
    const changed = setRemoteSource(content, { source: 'https://github.com/o/r', ref: 'v1' });
    expect(changed).toBe('---\ntype: remote\nsource: https://github.com/o/r\nref: v1\n---\n');
    expect(setRemoteSource(changed, { source: 'https://github.com/o/r', ref: '' })).not.toContain('ref');
    expect(remoteNoteOf(setRemoteSource(content, { source: 'https://h/"\n---\nevil: 1', ref: '' }))!.source).not.toContain('\n');
    expect(clearRemoteSource(`${changed}Own\n`)).toBe('Own\n');
  });

  it('leaves other notes alone', () => {
    for (const c of ['', 'type: remote', '---\ntype: remote\n---\n', '---\ntype: remote\nsource: LinkedIn\n---\n', '---\ntype: job\nsource: https://x\n---\n', '# a\n---\ntype: remote\nsource: https://x\n---\n']) expect(remoteNoteOf(c)).toBeNull();
    expect(remoteNoteOf('---\ntype: "Remote"\nsource: "{{var:repo}}"\n---\n')).toEqual({ source: '{{var:repo}}', ref: '' });
  });

  it('never writes the body of a remote note, and public links carry no source', () => {
    const before = `${remoteNoteMarkdown({ source: 'https://github.com/o/r', ref: '' })}kept\n`;
    const after = `${remoteNoteMarkdown({ source: 'https://github.com/o/other', ref: '' })}changed`;
    expect(keepRemoteBody(before, after)).toBe(`${remoteNoteMarkdown({ source: 'https://github.com/o/other', ref: '' })}kept\n`);
    expect(keepRemoteBody('plain', after)).toBe(after);
    expect(keepRemoteBody(before, 'plain')).toBe('plain');
    const open = publicRemoteContent(before);
    expect(open).not.toContain('github');
    expect(open).not.toContain('kept');
    expect(remoteNoteOf(open)).toEqual({ source: '', ref: '' });
    expect(publicRemoteContent('plain')).toBe('plain');
  });

  it('fills in variables', () => {
    const scope = variableScope('', new Map([['', [{ name: 'p', value: 'team/docs' }, { name: 'b', value: 'feature/x' }]]]));
    expect(resolveRemoteSource({ source: 'https://gitlab.example.com/{{var:p}}/-/blob/main/a.md', ref: '{{var:b}}' }, scope)).toEqual({ url: 'https://gitlab.example.com/team/docs/-/blob/main/a.md', ref: 'feature/x', complete: true });
    expect(resolveRemoteSource({ source: 'https://gitlab.example.com/{{var:gone}}', ref: '' }, scope).complete).toBe(false);
    expect(resolveRemoteSource({ source: 'https://gitlab.example.com/a/b', ref: '{{var:gone}}' }, scope).complete).toBe(false);
  });
});

describe('remote addresses', () => {
  it('understands GitLab', () => {
    expect(parse('https://gitlab.example.com/g/p/-/blob/main/README.md')).toBe('g/p | main:README.md');
    expect(parse('https://gitlab.example.com/g/sub/deep/p/-/raw/main/docs/My%20File.md?ref_type=heads&plain=1#L3')).toBe('g/sub/deep/p | main:docs/My File.md, main/docs:My File.md');
    expect(parse('https://gitlab.example.com/g/p/blob/master/a.md')).toBe('g/p | master:a.md');
    expect(parse('https://example.org/tools/gitlab/g/p/-/blob/v1.0/a.md')).toBe('g/p | v1.0:a.md');
    expect(parse('http://10.0.0.5:8080/g/p/-/blob/main/a.md')).toBe('g/p | main:a.md');
    expect(parse('https://gitlab.example.com/g/p')).toMatch(/^g\/p \| HEAD:README\.md, /);
    expect(parse('https://gitlab.example.com/g/p.git/')).toMatch(/^g\/p \| HEAD:README\.md/);
    expect(parse('https://gitlab.example.com/g/p/-/tree/main/docs')).toMatch(/^g\/p \| main:docs\/README\.md/);
  });

  it('understands GitHub and GitHub Enterprise', () => {
    expect(parse('https://github.com/o/r/blob/main/README.md')).toBe('o/r | main:README.md');
    expect(parse('https://github.com/o/.github/blob/main/README.md')).toBe('o/.github | main:README.md');
    expect(parse('https://github.com/o/r/raw/refs/heads/main/docs/a.md')).toBe('o/r | main:docs/a.md, main/docs:a.md');
    expect(parse('https://raw.githubusercontent.com/o/r/main/a.md')).toBe('o/r | main:a.md');
    expect(parse('https://raw.githubusercontent.com/o/r/refs/tags/v1/a.md')).toBe('o/r | v1:a.md');
    expect(parse('https://ghe.example.com/o/r/blob/main/a.md')).toBe('o/r | main:a.md');
    expect(parse('https://github.com/o/r', 'v2')).toMatch(/^o\/r \| v2:README\.md/);
    expect(parse('https://github.com/o/r/tree/main/docs')).toMatch(/^o\/r \| main:docs\/README\.md/);
  });

  it('reads branch names with slashes, and an explicit ref decides', () => {
    expect(parse('https://gitlab.example.com/g/p/-/blob/feature/x/docs/a.md')).toBe('g/p | feature:x/docs/a.md, feature/x:docs/a.md, feature/x/docs:a.md');
    expect(parse('https://gitlab.example.com/g/p/-/blob/feature/x/docs/a.md', 'feature/x')).toBe('g/p | feature/x:docs/a.md');
    expect(parse('https://gitlab.example.com/g/p/-/blob/main/docs/a.md', 'v1')).toBe('g/p | v1:docs/a.md');
  });

  it.each([
    ['https://evil.example.com/g/p/-/blob/main/a.md', 'host_not_configured'],
    ['https://gitlab.example.com.evil.com/g/p/-/blob/main/a.md', 'host_not_configured'],
    ['https://gitlab.example.com@evil.com/g/p/-/blob/main/a.md', 'invalid_source'],
    ['https://user:pw@gitlab.example.com/g/p/-/blob/main/a.md', 'invalid_source'],
    ['https://gitlab.example.com:8443/g/p/-/blob/main/a.md', 'host_not_configured'],
    ['http://gitlab.example.com/g/p/-/blob/main/a.md', 'host_not_configured'],
    ['https://example.org/g/p/-/blob/main/a.md', 'host_not_configured'],
    ['https://example.org/tools/gitlabx/g/p/-/blob/main/a.md', 'host_not_configured'],
    ['http://169.254.169.254/latest/meta-data', 'host_not_configured'],
    ['file:///etc/passwd', 'invalid_source'],
    ['ftp://gitlab.example.com/g/p', 'invalid_source'],
    ['javascript:alert(1)', 'invalid_source'],
    ['//gitlab.example.com/g/p', 'invalid_source'],
    ['https:\\\\gitlab.example.com\\g\\p', 'invalid_source'],
    ['https://gitlab.example.com\\@evil.com/g/p', 'invalid_source'],
    ['https://gitlab.example.com/g/p/-/blob/main/../../../../api/v4/user.md', 'invalid_source'],
    ['https://gitlab.example.com/g/p/-/blob/main/%2e%2e/%2E%2E/secret.md', 'invalid_source'],
    ['https://gitlab.example.com/g/p/-/blob/main/..%2f..%2fsecret.md', 'invalid_source'],
    ['https://gitlab.example.com/g/p/-/blob/main/a%5c..%5cb.md', 'invalid_source'],
    ['https://gitlab.example.com/g/p/-/blob/main/a%00.md', 'invalid_source'],
    ['https://gitlab.example.com/g/p/-/blob/main/%252e%252e%252fa.md', 'invalid_source'],
    ['https://gitlab.example.com/g/p/-/blob/main/%zz.md', 'invalid_source'],
    ['https://gitlab.example.com/g%2fother/p/-/blob/main/a.md', 'invalid_source'],
    ['https://gitlab.example.com/g/p/-/blob/main/a\nHost: x.md', 'invalid_source'],
    ['https://gitlab.example.com/g/p/-/blob/a..b/c.md', 'invalid_source'],
    ['https://gitlab.example.com/api/v4/projects', 'unsupported|api'],
    ['https://gitlab.example.com/g/p/-/issues/4', 'unsupported'],
    ['https://gitlab.example.com/g', 'unsupported'],
    ['https://gitlab.example.com/', 'unsupported'],
    ['https://gitlab.example.com/-/blob/main/a.md', 'unsupported'],
    ['https://gitlab.example.com/g/p/-/blob/main/.env', 'unsupported'],
    ['https://gitlab.example.com/g/p/-/blob/main/config.yml', 'unsupported'],
    ['https://github.com/o/r/issues/1', 'unsupported'],
    ['https://github.com/o', 'unsupported'],
    ['not a url', 'invalid_source'],
    ['', 'invalid_source'],
    [`https://gitlab.example.com/${'a/'.repeat(1500)}x.md`, 'invalid_source'],
  ])('refuses %s', (url, problem) => {
    // "api/v4/projects" is shaped like a project; it is only ever asked for as one
    expect(parse(url)).toMatch(problem.startsWith('unsupported|') ? /^(unsupported|api\/v4\/projects \|)/ : new RegExp(`^${problem}$`));
  });

  it('refuses refs with a meaning of their own', () => {
    for (const ref of ['../x', 'a..b', '-x', 'a b', 'a?b', 'a\\b', '/a', 'a//b', 'a/', 'x.lock', 'a\nb', 'a:b', '@{1}']) expect(parse('https://github.com/o/r/blob/main/a.md', ref)).toBe('invalid_source');
    expect(parse('https://github.com/o/r/blob/main/a.md', 'übung/1.0+x')).toBe('o/r | übung/1.0+x:a.md');
  });

  it('needs github.com configured for raw.githubusercontent.com', () => {
    expect(parseRemoteUrl('https://raw.githubusercontent.com/o/r/main/a.md', [{ kind: 'github', url: 'https://ghe.example.com' }])).toEqual({ ok: false, problem: 'host_not_configured' });
  });

  it('normalizes configured hosts', () => {
    expect(normalizeRemoteHost(' https://GitLab.example.com/ ')).toBe('https://gitlab.example.com');
    expect(normalizeRemoteHost('https://example.org/tools/gitlab//')).toBe('https://example.org/tools/gitlab');
    expect(normalizeRemoteHost('http://10.0.0.5:8080')).toBe('http://10.0.0.5:8080');
    for (const bad of ['', 'gitlab.example.com', 'ftp://x', 'https://u:p@x', 'https://x?a', 'https://x#a', 'https://x/a b', 'https://x\\y']) expect(normalizeRemoteHost(bad)).toBeNull();
  });

  it('matches allowed paths by whole parts', () => {
    expect(remoteProjectAllowed('gitlab', 'team/docs', [])).toBe(true);
    expect(remoteProjectAllowed('gitlab', 'Team/Docs', ['team'])).toBe(true);
    expect(remoteProjectAllowed('gitlab', 'team/docs', ['/team/docs/'])).toBe(true);
    expect(remoteProjectAllowed('gitlab', 'team2/docs', ['team'])).toBe(false);
    expect(remoteProjectAllowed('gitlab', 'team/docs-private', ['team/docs'])).toBe(false);
    expect(remoteProjectAllowed('gitlab', 'team/docs', ['github:team'])).toBe(false);
    expect(remoteProjectAllowed('github', 'team/docs', ['github:team'])).toBe(true);
    expect(remoteProjectAllowed('gitlab', 'team/docs', ['/', 'gitlab:'])).toBe(false);
  });
});

describe('remote text', () => {
  const base: RemoteBase = { kind: 'gitlab', host: 'https://gitlab.example.com', project: 'g/p', ref: 'main', path: 'docs/guide.md' };
  const prepare = (text: string, b = base) => prepareRemoteMarkdown(text, b, (p) => `IMG:${p}`);
  const web = 'https://gitlab.example.com/g/p/-/blob/main';

  it('makes links absolute and images go through the proxy', () => {
    expect(prepare('[a](other.md) [b](../README.md#Top) [c](/x/y.md) [d](#here) [e](https://x.org/a) [f](<My File.md> "T")')).toBe(
      `[a](${web}/docs/other.md) [b](${web}/README.md#Top) [c](${web}/x/y.md) [d](${web}/docs/guide.md#here) [e](https://x.org/a) [f](${web}/docs/My%20File.md "T")`
    );
    expect(prepare('![i](img/a.png) ![j](../b.svg?raw=true) ![k](https://x.org/c.png)')).toBe('![i](IMG:docs/img/a.png) ![j](IMG:b.svg) ![k](https://x.org/c.png)');
    expect(prepare('[![badge](b.png)](other.md)')).toBe(`[![badge](IMG:docs/b.png)](${web}/docs/other.md)`);
    // Not an image: a link to the file
    expect(prepare('![v](clip.mp4) ![p](a.pdf)')).toBe(`[v](${web}/docs/clip.mp4) [p](${web}/docs/a.pdf)`);
    expect(prepare('[a](x(1).md)', { ...base, kind: 'github' })).toBe('[a](https://gitlab.example.com/g/p/blob/main/docs/x%281%29.md)');
  });

  it('never points at this server or at unsafe addresses', () => {
    expect(prepare('![x](/api/files/abc) [y](/api/auth/logout)')).toBe(`[x](${web}/api/files/abc) [y](${web}/api/auth/logout)`);
    expect(prepare('[x](javascript:alert) ![y](kladde-pending:1) [z](data:text/html,x) ![q](javascript:1)')).toBe('[x](about:blank) ![y](about:blank) [z](about:blank) ![q](about:blank)');
    expect(prepare('[x](../../../etc/passwd) ![x](../../a.png) [y](%2e%2e/%2e%2e/%2e%2e/a.md)')).toBe('[x](about:blank) [x](about:blank) [y](about:blank)');
    expect(prepare('[x](//evil.org/a) [y](\\\\evil.org\\a)')).toMatch(/^\[x\]\(https:\/\/evil\.org\/a\)/);
  });

  it('leaves code alone, switches off active blocks and drops the frontmatter', () => {
    expect(prepare('`[a](b.md)` and ``x ` [a](b.md)``\n\n```md\n[a](b.md)\n```\n')).toBe('`[a](b.md)` and ``x ` [a](b.md)``\n\n```md\n[a](b.md)\n```\n');
    expect(prepare('```query\nTASKS\n```\n~~~gallery\n/api/files/x\n~~~\n```mermaid\na\n```')).toBe('```text\nTASKS\n```\n~~~text\n/api/files/x\n~~~\n```mermaid\na\n```');
    expect(prepare('﻿---\r\ntype: database\r\nsource: x\r\n---\r\n# T\r\n')).toBe('# T\n');
    expect(prepare('---\n---\n\n---\n').startsWith('---')).toBe(false);
    expect(prepare('\\[a](b.md) [a\\](b.md)')).toBe('\\[a](b.md) [a\\](b.md)');
  });

  it('stays linear on hostile text', () => {
    const start = performance.now();
    for (const s of ['[', '![', '](', '[](', '[](x', '`', '```` ` ``', '[a](<', '[a](b "', '\\[', '(((((']) prepare(s.repeat(200_000));
    prepare(Array.from({ length: 600 }, (_, i) => `${'`'.repeat(i + 1)}x`).join(' '));
    expect(performance.now() - start).toBeLessThan(8000);
  });

  it('builds addresses of files', () => {
    expect(remoteWebUrl({ ...base, ref: 'feature/ü', path: 'a b/c.md' })).toBe('https://gitlab.example.com/g/p/-/blob/feature/%C3%BC/a%20b/c.md');
    expect(remoteWebUrl({ ...base, kind: 'github' }, 'raw')).toBe('https://gitlab.example.com/g/p/raw/main/docs/guide.md');
  });
});

describe('synced remote notes', () => {
  const source = 'https://gitlab.example.com/g/p/-/blob/main/a.md';
  const snap = (over: Partial<RemoteSnapshot> = {}): RemoteSnapshot => ({ source, ref: '', text: 'Kopie mit Seegras', base: null, url: '', commit: null, fetchedAt: 1, checkedAt: 1, ...over });

  it('writes and reads the switch', () => {
    const on = remoteNoteMarkdown({ source, ref: '', sync: true });
    expect(on).toContain('sync: true');
    expect(remoteNoteOf(on)).toEqual({ source, ref: '', sync: true });
    const off = setRemoteSource(on, { source, ref: '' });
    expect(off).not.toContain('sync');
    expect(remoteNoteOf(off)).toEqual({ source, ref: '' });
    expect(remoteNoteOf(on.replace('sync: true', 'sync: false'))?.sync).toBeUndefined();
    expect(clearRemoteSource(on)).not.toContain('sync');
  });

  it('searches the kept copy only of a synced note and only of its current source', () => {
    const content = remoteNoteMarkdown({ source, ref: '', sync: true });
    const note = { path: 'A.md', content, updatedAt: 1, remoteSnapshot: snap() };
    expect(searchableText(note)).toContain('Seegras');
    expect(searchNotes([note], ['seegras'], () => 'A', undefined, searchableText)).toHaveLength(1);
    expect(searchNotes([note], ['seegras'], () => 'A')).toHaveLength(0);
    expect(searchableText({ ...note, content: remoteNoteMarkdown({ source, ref: '' }) })).not.toContain('Seegras');
    expect(searchableText({ ...note, remoteSnapshot: snap({ source: `${source}x` }) })).not.toContain('Seegras');
  });
});
