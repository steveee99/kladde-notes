import { describe, expect, it } from 'vitest';
import { extractMentions, mentionContext, mentionsUser, newMentions } from '../src/index.js';

describe('@mentions (#69)', () => {
  it('finds usernames, not e-mail addresses, paths or code', () => {
    expect(extractMentions('Hallo @Ben und @cara.\n- [ ] Termin @anna_b')).toEqual(['ben', 'cara', 'anna_b']);
    expect(extractMentions('mail an x@ben.de, Pfad a/@ben, `@code` und\n```\n@fenced\n```')).toEqual([]);
    expect(extractMentions('@ab zu kurz, @einnamemitmehralszwanzigzeichen zu lang')).toEqual([]);
    expect(extractMentions('(@ben) "@cara" @dora: @emil!')).toEqual(['ben', 'cara', 'dora', 'emil']);
  });

  it('tells new mentions from old ones and finds the passage', () => {
    expect(newMentions('Hallo @ben', 'Hallo @ben und @cara')).toEqual(['cara']);
    expect(newMentions('', '@ben @ben')).toEqual(['ben']);
    expect(mentionContext('# Plan\n\nBitte prüfen, @Ben.', 'ben')).toEqual({ line: 2, text: 'Bitte prüfen, @Ben.' });
    expect(mentionContext('nichts', 'ben')).toBeNull();
    expect(mentionsUser('Anrufen @ben', 'Ben')).toBe(true);
    expect(mentionsUser('Anrufen @benno', 'ben')).toBe(false);
    expect(mentionsUser('Anrufen', '')).toBe(false);
  });

  it('stays linear on hostile input', () => {
    const start = performance.now();
    extractMentions(`${'@'.repeat(50_000)}${'a'.repeat(50_000)}`);
    extractMentions(`@${'.'.repeat(50_000)}!`);
    extractMentions(`${' @aaa.'.repeat(20_000)}`);
    expect(performance.now() - start).toBeLessThan(250);
  });
});
