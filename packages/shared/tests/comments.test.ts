import { describe, expect, it } from 'vitest';
import { makeAnchor, resolveAnchor } from '../src/index.js';

describe('comment anchors (#68)', () => {
  const doc = 'Einleitung.\n\nDer Termin ist am Montag. Danach Pause.\n\nZweiter Absatz: der Termin ist am Montag. Ende.';

  it('finds the passage after edits before it', () => {
    const from = doc.indexOf('Termin ist am Montag');
    const anchor = makeAnchor(doc, from, from + 'Termin ist am Montag'.length);
    expect(anchor.quote).toBe('Termin ist am Montag');
    const edited = `Neue Zeile oben.\n${doc}`;
    const r = resolveAnchor(edited, anchor)!;
    expect(edited.slice(r.from, r.to)).toBe('Termin ist am Montag');
    expect(r.from).toBe(from + 'Neue Zeile oben.\n'.length);
    expect(r.exact).toBe(true);
  });

  it('tells repeated passages apart by their surroundings', () => {
    const second = doc.lastIndexOf('Termin ist am Montag');
    const anchor = makeAnchor(doc, second, second + 20);
    // The first occurrence moved closer to the old offset; the context still picks the second one
    const edited = doc.replace('Einleitung.', 'E.');
    const r = resolveAnchor(edited, anchor)!;
    expect(r.from).toBe(edited.lastIndexOf('Termin ist am Montag'));
  });

  it('falls back to the text between the old neighbours, and gives up when it is gone', () => {
    const from = doc.indexOf('Montag. Danach');
    const anchor = makeAnchor(doc, from, from + 'Montag. Danach'.length);
    const edited = doc.replace('Montag. Danach', 'Dienstag. Später');
    const r = resolveAnchor(edited, anchor)!;
    expect(r.exact).toBe(false);
    expect(edited.slice(r.from, r.to)).toBe('Dienstag. Später');
    expect(resolveAnchor('Ganz anderer Text', anchor)).toBeNull();
  });

  it('stays fast on many repeats', () => {
    const big = 'ab'.repeat(100_000);
    const anchor = { quote: 'a', prefix: 'b'.repeat(32), suffix: 'c'.repeat(32), pos: 5 };
    const start = performance.now();
    resolveAnchor(big, anchor);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
