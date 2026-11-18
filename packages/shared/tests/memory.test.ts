import { describe, expect, it } from 'vitest';
import {
  LinkIndex,
  addMemoryLogEntry,
  addVerification,
  applyMemoryFields,
  checkMemoryNote,
  fromOkfBundle,
  guardVerified,
  memoryInstructions,
  memoryMeta,
  memoryOverview,
  memoryRules,
  normalizeFeatures,
  parseYaml,
  runQuery,
  setFrontmatterValues,
  stampGenerated,
  syncMemoryIndex,
  toOkfBundle,
  zipStore,
} from '../src/index.js';

const NOTE = `---
type: Reference
title: Kaffeemaschine X1
description: Wartung und Eigenheiten der X1.
tags: [geräte, küche]
resource: https://example.com/x1
custom_key: bleibt
sources:
  - id: manual
    resource: https://example.com/x1.pdf
    title: Handbuch
generated:
  by: claude
  at: 2026-11-18T10:00:00Z
verified:
  - by: human:stefan
    at: 2026-11-18T11:00:00+01:00
---

Entkalken alle 4 Wochen.[^manual]
`;

describe('yaml subset', () => {
  it('reads nested maps, lists of maps and inline lists', () => {
    const data = parseYaml(NOTE.split('---')[1]);
    expect(data.type).toBe('Reference');
    expect(data.tags).toEqual(['geräte', 'küche']);
    expect(data.resource).toBe('https://example.com/x1');
    expect(data.sources).toEqual([{ id: 'manual', resource: 'https://example.com/x1.pdf', title: 'Handbuch' }]);
    expect(data.generated).toEqual({ by: 'claude', at: '2026-11-18T10:00:00Z' });
  });

  it('reads block scalars and quoted values', () => {
    const data = parseYaml('a: "x: y"\nb: |\n  eins\n\n  zwei\nc: \'it\'\'s\'');
    expect(data).toEqual({ a: 'x: y', b: 'eins\n\nzwei', c: "it's" });
  });

  it('changes one key and keeps the others as written', () => {
    const next = setFrontmatterValues(NOTE, { status: 'deprecated', generated: { by: 'chatgpt', at: '2026-11-19T08:00:00Z' } });
    expect(next).toContain('custom_key: bleibt');
    expect(next).toContain('  - id: manual');
    expect(next).toContain('status: deprecated');
    expect(parseYaml(next.split('---')[1]).generated).toEqual({ by: 'chatgpt', at: '2026-11-19T08:00:00Z' });
    expect(next.endsWith('Entkalken alle 4 Wochen.[^manual]\n')).toBe(true);
  });

  it('round-trips lists of maps', () => {
    const next = setFrontmatterValues('Text', { verified: [{ by: 'human:a', at: '2026-01-01T00:00:00Z' }, { by: 'b', at: '2026-01-02T00:00:00Z' }] });
    expect(parseYaml(next.split('---')[1]).verified).toEqual([
      { by: 'human:a', at: '2026-01-01T00:00:00Z' },
      { by: 'b', at: '2026-01-02T00:00:00Z' },
    ]);
    expect(next.endsWith('Text')).toBe(true);
  });
});

describe('memory metadata', () => {
  it('derives trust, staleness and change after verification', () => {
    const m = memoryMeta(NOTE, 'AI-Memory/Geräte/X1.md', Date.parse('2026-12-01'));
    expect(m.trust).toBe('human-reviewed');
    expect(m.changedSinceVerified).toBe(false);
    const changed = stampGenerated(NOTE, 'chatgpt', '2026-11-20T09:00:00Z');
    expect(memoryMeta(changed).changedSinceVerified).toBe(true);
    expect(memoryMeta(changed).generated).toEqual({ by: 'chatgpt', at: '2026-11-20T09:00:00Z' });
    expect(memoryMeta(setFrontmatterValues(NOTE, { stale_after: '2026-11-30' }), '', Date.parse('2026-12-01')).stale).toBe(true);
    expect(memoryMeta('---\ntype: X\nverified:\n  - by: claude\n    at: 2026-01-01T00:00:00Z\n---\n').trust).toBe('machine-confirmed');
  });

  it('keeps the model an agent claimed when the server stamps its own id', () => {
    const next = stampGenerated('---\ntype: X\ngenerated:\n  by: claude-opus-5-5\n  at: 2026-01-01T00:00:00Z\n---\n', 'claude', '2026-02-01T00:00:00Z');
    expect(parseYaml(next.split('---')[1]).generated).toEqual({ by: 'claude', at: '2026-02-01T00:00:00Z', model: 'claude-opus-5-5' });
  });

  it('adds a human confirmation once per actor', () => {
    const once = addVerification(NOTE, 'human:stefan', '2026-11-21T00:00:00Z');
    expect(memoryMeta(once).verified).toEqual([{ by: 'human:stefan', at: '2026-11-21T00:00:00Z' }]);
  });
});

describe('memory validation', () => {
  it('accepts a complete note', () => {
    expect(checkMemoryNote('AI-Memory/X1.md', NOTE, { resolveLink: () => true })).toEqual([]);
  });

  it('reports missing frontmatter, type and bad timestamps as errors', () => {
    expect(checkMemoryNote('AI-Memory/a.md', 'nur Text').map((p) => p.code)).toEqual(['frontmatter']);
    const codes = checkMemoryNote('AI-Memory/a.md', '---\ntitle: a\ngenerated:\n  by: x\n  at: 2026-01-01 10:00\n---\n').filter((p) => p.level === 'error').map((p) => p.code);
    expect(codes).toEqual(['type', 'timestamp']);
  });

  it('warns about broken links, uncited sources and dangling footnotes', () => {
    const note = '---\ntype: Technique\ndescription: d\nsources:\n  - id: a\n    resource: https://x\n---\nSiehe [[Fehlt]] und [^b].\n';
    const codes = checkMemoryNote('AI-Memory/a.md', note, { resolveLink: () => false }).map((p) => p.code);
    expect(codes).toEqual(['link', 'source', 'footnote']);
  });

  it('skips index and log', () => {
    expect(checkMemoryNote('AI-Memory/index.md', '# Index')).toEqual([]);
  });

  it('summarizes the memory', () => {
    const o = memoryOverview(
      [
        { id: '1', path: 'AI-Memory/X1.md', content: NOTE },
        { id: '2', path: 'AI-Memory/Regel.md', content: '---\ntype: Rule\ndescription: d\n---\nImmer Deutsch.' },
        { id: '3', path: 'AI-Memory/kaputt.md', content: 'ohne' },
        { id: '4', path: 'Andere/x.md', content: 'ohne' },
      ],
      'AI-Memory'
    );
    expect(o).toMatchObject({ total: 3, errors: 1, rules: 1, unverified: 2 });
  });
});

describe('agent guard for verified', () => {
  it('refuses human confirmations by an agent and confirmations in another name', () => {
    const fresh = '---\ntype: X\n---\n';
    expect(guardVerified(fresh, addVerification(fresh, 'human:stefan'), 'claude')).toHaveProperty('error');
    expect(guardVerified(fresh, addVerification(fresh, 'chatgpt'), 'claude')).toHaveProperty('error');
    expect(guardVerified(fresh, addVerification(fresh, 'claude'), 'claude')).toHaveProperty('content');
  });

  it('restores human confirmations an agent dropped', () => {
    const dropped = setFrontmatterValues(NOTE, { verified: undefined });
    const r = guardVerified(NOTE, dropped, 'claude') as { content: string };
    expect(memoryMeta(r.content).trust).toBe('human-reviewed');
  });
});

describe('index and log', () => {
  it('adds missing entries by type, updates descriptions and keeps hand-written parts', () => {
    const current = '---\nokf_version: "0.2"\n---\n\n# Gedächtnis\n\nHandgeschrieben.\n\n## Geräte\n- [[X1]]: alt\n- [[Weg]]: gelöscht\n- [[log]]: Historie\n';
    const next = syncMemoryIndex(current, 'AI-Memory', [
      { target: 'X1', type: 'Reference', description: 'neu' },
      { target: 'Kaffee kochen', type: 'Technique', description: 'Wie man Kaffee kocht.' },
    ], [{ target: 'Geräte/index', label: 'Geräte' }], true, (t) => t === 'log');
    expect(next).toContain('Handgeschrieben.');
    expect(next).toContain('- [[X1]]: neu');
    expect(next).not.toContain('[[Weg]]');
    expect(next).toContain('- [[log]]: Historie');
    expect(next).toContain('## Technique\n- [[Kaffee kochen]]: Wie man Kaffee kocht.');
    expect(next).toContain('## Ordner\n- [[Geräte/index|Geräte]]');
  });

  it('creates a root index with okf_version', () => {
    expect(syncMemoryIndex(null, 'AI-Memory', [], [], true)).toMatch(/^---\nokf_version: "0.2"\n---\n\n# AI-Memory/);
  });

  it('writes log entries newest first under the date', () => {
    let log = addMemoryLogEntry(null, '2026-11-18', 'Creation', '[[A]] von claude');
    log = addMemoryLogEntry(log, '2026-11-18', 'Update', '[[B]] von claude');
    log = addMemoryLogEntry(log, '2026-11-18', 'Update', '[[B]] von claude');
    log = addMemoryLogEntry(log, '2026-11-19', 'Deprecation', '[[A]] von human:stefan');
    expect(log).toBe('## 2026-11-19\n\n**Deprecation** [[A]] von human:stefan\n\n## 2026-11-18\n\n**Update** [[B]] von claude\n\n**Creation** [[A]] von claude\n');
  });
});

describe('rules for agents', () => {
  it('collects non-deprecated rules and puts them into the instructions', () => {
    const notes = [
      { id: '1', path: 'AI-Memory/Regeln/Sprache.md', content: '---\ntype: Rule\ntitle: Sprache\n---\nAntworte auf Deutsch.' },
      { id: '2', path: 'AI-Memory/Regeln/Alt.md', content: '---\ntype: Rule\nstatus: deprecated\n---\nAlt.' },
      { id: '3', path: 'Privat/Regel.md', content: '---\ntype: Rule\n---\nNicht im Gedächtnis.' },
    ];
    const rules = memoryRules(notes, 'AI-Memory');
    expect(rules.map((r) => r.title)).toEqual(['Sprache']);
    const text = memoryInstructions('AI-Memory', rules);
    expect(text).toContain('## Sprache\nAntworte auf Deutsch.');
    expect(text).not.toContain('Nicht im Gedächtnis');
  });
});

describe('OKF bundles', () => {
  it('exports [[links]] inside the memory as bundle-relative links', () => {
    const notes = [
      { id: 'a', path: 'AI-Memory/Geräte/X1.md', content: '---\ntype: Reference\n---\nSiehe [[Kaffee kochen|Anleitung]] und [[Privat]].' },
      { id: 'b', path: 'AI-Memory/Kaffee kochen.md', content: '---\ntype: Technique\n---\n' },
      { id: 'c', path: 'Privat.md', content: '' },
    ];
    const index = new LinkIndex(notes);
    const files = toOkfBundle(notes, 'AI-Memory', (t) => index.resolve(t));
    expect(files.map((f) => f.path)).toEqual(['Geräte/X1.md', 'index.md', 'Kaffee kochen.md']);
    expect(files[0].content).toContain('[Anleitung](/Kaffee%20kochen)');
    expect(files[0].content).toContain('[[Privat]]');
    expect(files[1].content).toContain('okf_version: "0.2"');
  });

  it('imports Markdown links between bundle files as [[links]]', () => {
    const files = fromOkfBundle(
      [
        { path: 'references/foo.md', content: '---\ntype: X\n---\n[Bar](/references/bar) [rel](./bar.md) [web](https://x.org)' },
        { path: 'references/bar.md', content: '---\ntype: X\n---\n' },
        { path: 'bild.png', content: '' },
      ],
      'AI-Memory'
    );
    expect(files.map((f) => f.path)).toEqual(['AI-Memory/references/foo.md', 'AI-Memory/references/bar.md']);
    expect(files[0].content).toContain('[[bar|Bar]] [[bar|rel]] [web](https://x.org)');
  });

  it('resolves OKF path links and [[folder/name]] in the link index', () => {
    const notes = [
      { id: 'a', path: 'AI-Memory/index.md', content: '[Foo](/Produkte/Foo) [[Produkte/index]]' },
      { id: 'b', path: 'AI-Memory/Produkte/Foo.md', content: '' },
      { id: 'c', path: 'AI-Memory/Produkte/index.md', content: '' },
      { id: 'd', path: 'Anderes/index.md', content: '' },
    ];
    const index = new LinkIndex(notes);
    expect(index.outgoing('a').sort()).toEqual(['b', 'c']);
    expect(index.resolve('/Produkte/Foo.md')).toBe('b');
    expect(index.resolve('Anderes/index')).toBe('d');
  });

  it('writes a readable ZIP', () => {
    const zip = zipStore([{ path: 'a.md', content: 'hallo' }]);
    expect(new DataView(zip.buffer).getUint32(0, true)).toBe(0x04034b50);
    expect(new DataView(zip.buffer).getUint32(zip.length - 22, true)).toBe(0x06054b50);
  });
});

describe('memory settings and queries', () => {
  it('is off by default with the folder AI-Memory', () => {
    expect(normalizeFeatures({}).memory).toEqual({ enabled: false, folder: 'AI-Memory' });
    expect(normalizeFeatures({ memory: { enabled: true, folder: 'KI' } }).memory).toEqual({ enabled: true, folder: 'KI' });
  });

  it('offers trust and generated_by as query fields', () => {
    const r = runQuery('TABLE trust, generated_by WHERE trust = "human-reviewed"', [{ id: '1', path: 'AI-Memory/X1.md', content: NOTE, createdAt: 0, updatedAt: 0 }]);
    expect(r.rows[0].values).toMatchObject({ trust: 'human-reviewed', generated_by: 'claude' });
  });

  it('sets the core fields and keeps other keys', () => {
    const next = applyMemoryFields(NOTE, { type: 'Technique', description: 'neu', sources: [] });
    expect(memoryMeta(next)).toMatchObject({ type: 'Technique', description: 'neu', sources: [] });
    expect(next).toContain('custom_key: bleibt');
  });
});

describe('memory upkeep', () => {
  it('updates the folder index, its parents and the root log', async () => {
    const { memoryUpkeep } = await import('../src/index.js');
    const notes = [
      { id: 'a', path: 'AI-Memory/Geräte/X1.md', content: NOTE },
      { id: 'r', path: 'AI-Memory/index.md', content: '# AI-Memory\n\nMeins.\n' },
    ];
    const index = new LinkIndex(notes);
    const writes = memoryUpkeep(notes, 'AI-Memory', 'AI-Memory/Geräte/X1.md', (t) => index.resolve(t), { kind: 'Creation', actor: 'claude', date: '2026-11-18' });
    expect(writes.map((w) => [w.id, w.path])).toEqual([
      [null, 'AI-Memory/Geräte/index.md'],
      ['r', 'AI-Memory/index.md'],
      [null, 'AI-Memory/log.md'],
    ]);
    expect(writes[0].content).toContain('- [[X1]]: Wartung und Eigenheiten der X1.');
    expect(writes[1].content).toContain('Meins.');
    expect(writes[1].content).toContain('okf_version: "0.2"');
    expect(writes[1].content).toContain('## Ordner\n- [[AI-Memory/Geräte/index|Geräte]]');
    expect(writes[2].content).toBe('## 2026-11-18\n\n**Creation** [[X1]] (claude)\n');
  });

  it('does nothing outside the memory or for index/log', async () => {
    const { memoryUpkeep } = await import('../src/index.js');
    expect(memoryUpkeep([], 'AI-Memory', 'Privat/x.md', () => null, null)).toEqual([]);
    expect(memoryUpkeep([], 'AI-Memory', 'AI-Memory/index.md', () => null, null)).toEqual([]);
  });
});
