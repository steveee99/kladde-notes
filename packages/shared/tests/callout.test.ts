import { describe, expect, it } from 'vitest';
import { calloutKind, isKnownCalloutType, calloutTypeTitle, parseCalloutHeader, parseCalloutLine, parseMarkdownForExport, CALLOUT_TONES } from '../src/index.js';

describe('callouts', () => {
  it('reads type, fold state and title from the first quote line', () => {
    expect(parseCalloutLine('> [!warning] Strom abschalten')).toEqual({ type: 'warning', kind: 'warning', fold: '', title: 'Strom abschalten' });
    expect(parseCalloutLine('> [!TIP]- Mehr')).toEqual({ type: 'tip', kind: 'tip', fold: '-', title: 'Mehr' });
    expect(parseCalloutLine('>[!faq]+')).toEqual({ type: 'faq', kind: 'question', fold: '+', title: '' });
    expect(parseCalloutHeader('[!custom-type] x')?.kind).toBe('note');
  });

  it('leaves ordinary quotes and other brackets alone', () => {
    expect(parseCalloutLine('> Nur ein Zitat')).toBeNull();
    expect(parseCalloutLine('> [x] done')).toBeNull();
    expect(parseCalloutLine('[!note] no quote')).toBeNull();
    expect(parseCalloutLine('> [!note]Title glued on')).toBeNull();
  });

  it('maps aliases onto kinds with a color role', () => {
    expect(calloutKind('caution')).toBe('warning');
    expect(calloutKind('error')).toBe('danger');
    expect(calloutKind('cite')).toBe('quote');
    expect(CALLOUT_TONES[calloutKind('done')]).toBe('ok');
    expect(CALLOUT_TONES.danger).toBe('error');
    expect(calloutTypeTitle('my-type')).toBe('My type');
    expect(calloutKind('constructor')).toBe('note');
    expect(isKnownCalloutType('constructor')).toBe(false);
    expect(isKnownCalloutType('FAQ')).toBe(true);
  });

  it('is kept apart from its body in exports', () => {
    const { blocks } = parseMarkdownForExport('T', '> [!note]- **Wichtig**\n> Zeile eins\n> Zeile zwei\n\n> Zitat');
    expect(blocks[0]).toMatchObject({ type: 'blockquote', callout: { kind: 'note', fold: '-', title: '**Wichtig**', titleInlines: [{ type: 'strong', text: 'Wichtig' }] } });
    expect(blocks[0].type === 'blockquote' && blocks[0].lines).toHaveLength(2);
    expect(blocks[1]).toEqual({ type: 'blockquote', lines: [[{ type: 'text', text: 'Zitat' }]] });
  });
});
