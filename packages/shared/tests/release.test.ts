import { describe, expect, it } from 'vitest';
import {
  cleanReleaseNote,
  contentHash,
  fillReleasePlaceholders,
  hasReleasePlaceholders,
  nextVersion,
  parseSemVer,
  releaseHistoryTable,
  sortReleases,
  suggestedBump,
} from '../src/release';
import type { NoteReleaseInfo } from '../src/types';

const day = (d: string) => Date.parse(`${d}T12:00:00`);
const releases: NoteReleaseInfo[] = [
  { version: '1.0.0', releasedAt: day('2026-01-10'), releasedBy: 'anna', note: 'First approved version' },
  { version: '1.1.0', releasedAt: day('2026-03-02'), releasedBy: 'ben', note: 'Adds | the appendix' },
];

describe('semantic versions', () => {
  it('parses strict X.Y.Z and refuses prerelease tags', () => {
    expect(parseSemVer('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemVer(' 0.10.0 ')).toEqual({ major: 0, minor: 10, patch: 0 });
    expect(parseSemVer('1.3.0-rc.1')).toBeNull();
    expect(parseSemVer('01.2.3')).toBeNull();
    expect(parseSemVer('1.2')).toBeNull();
  });

  it('suggests the next number per bump, counting the first release from 0.0.0', () => {
    expect(nextVersion('1.2.0', 'minor')).toBe('1.3.0');
    expect(nextVersion('1.2.7', 'major')).toBe('2.0.0');
    expect(nextVersion('1.2.7', 'patch')).toBe('1.2.8');
    expect(nextVersion(null, 'major')).toBe('1.0.0');
    expect(nextVersion(null, 'minor')).toBe('0.1.0');
    expect(nextVersion(undefined, 'patch')).toBe('0.0.1');
    expect(suggestedBump(null)).toBe('major');
    expect(suggestedBump('1.0.0')).toBe('minor');
  });

  it('sorts newest first by version', () => {
    expect(sortReleases([...releases, { version: '0.9.0', releasedAt: day('2026-04-01'), releasedBy: 'x', note: '' }]).map((r) => r.version)).toEqual(['1.1.0', '1.0.0', '0.9.0']);
  });

  it('keeps release notes to one capped line', () => {
    expect(cleanReleaseNote('  a\n  b ')).toBe('a b');
    expect(cleanReleaseNote(5)).toBe('');
    expect(cleanReleaseNote('x'.repeat(900))).toHaveLength(500);
  });

  it('fingerprints texts', () => {
    expect(contentHash('abc')).toBe(contentHash('abc'));
    expect(contentHash('abc')).not.toBe(contentHash('abd'));
  });
});

describe('release placeholders', () => {
  it('fills the single fields with the latest release', () => {
    expect(fillReleasePlaceholders('Version {{version}} vom {{released_at}} ({{released_by}}): {{release_note}}', releases)).toBe(
      'Version 1.1.0 vom 2026-03-02 (ben): Adds | the appendix'
    );
  });

  it('shows a dash while there is no release', () => {
    expect(fillReleasePlaceholders('v{{version}}', [])).toBe('v—');
  });

  it('expands the row template once per release, newest first, for a free layout', () => {
    const text = [
      '| Version | Released on | By | Changes |',
      '|---|---|---|---|',
      '{{#versions}}| {{version}} | {{released_at}} | {{released_by}} | {{release_note}} |',
      '{{/versions}}',
      'After',
    ].join('\n');
    expect(fillReleasePlaceholders(text, releases)).toBe(
      [
        '| Version | Released on | By | Changes |',
        '|---|---|---|---|',
        '| 1.1.0 | 2026-03-02 | ben | Adds \\| the appendix |',
        '| 1.0.0 | 2026-01-10 | anna | First approved version |',
        'After',
      ].join('\n')
    );
    expect(fillReleasePlaceholders('{{#versions}}{{version}}, {{/versions}}.', releases)).toBe('1.1.0, 1.0.0, .');
  });

  it('turns a versions block and a version_history line into the history table', () => {
    const table = releaseHistoryTable(releases, { labels: { version: 'V', releasedAt: 'Am', releasedBy: 'Von', changes: 'Was', none: '–' }, formatDate: () => 'D' });
    expect(table.split('\n')).toEqual(['| V | Am | Von | Was |', '|---|---|---|---|', '| 1.1.0 | D | ben | Adds \\| the appendix |', '| 1.0.0 | D | anna | First approved version |']);
    expect(fillReleasePlaceholders('# Spec\n\n```versions\n```\n\nEnd', releases)).toBe(`# Spec\n\n${releaseHistoryTable(releases)}\n\nEnd`);
    expect(fillReleasePlaceholders('A\n{{version_history}}\nB', releases)).toBe(`A\n${releaseHistoryTable(releases)}\nB`);
    expect(releaseHistoryTable([])).toContain('| — | | | |');
  });

  it('leaves other code blocks and texts without placeholders alone', () => {
    const code = '```md\n{{version}}\n```\n{{version}}';
    expect(fillReleasePlaceholders(code, releases)).toBe('```md\n{{version}}\n```\n1.1.0');
    expect(hasReleasePlaceholders('plain {{title}}')).toBe(false);
    expect(fillReleasePlaceholders('plain {{title}}', releases)).toBe('plain {{title}}');
  });
});
