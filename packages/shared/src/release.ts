import { toDateString } from './tasks.js';
import type { NoteReleaseInfo } from './types.js';

/*
 * Release versioning of notes (#53): explicit, opt-in Semantic Versioning on top of the automatic history.
 * A release freezes the note's text under a version number; the note itself is the draft of the next one.
 * Pure helpers shared by server (exports) and client (rendering): version numbers and the placeholders
 * that put the version history into the note.
 */

export type ReleaseBump = 'major' | 'minor' | 'patch';

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

/** Longest release note kept (one changelog line) */
export const MAX_RELEASE_NOTE = 500;

const SEMVER_RE = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

/** "1.2.3" → numbers; prerelease and build tags are not supported, so they are refused */
export function parseSemVer(value: string): SemVer | null {
  const m = SEMVER_RE.exec(value.trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}

export function formatSemVer(v: SemVer): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/** Negative when a < b, 0 when equal, positive when a > b */
export function compareSemVer(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** The version after `latest` (null: no release yet, counted from 0.0.0, so the first major release is 1.0.0) */
export function nextVersion(latest: string | null | undefined, bump: ReleaseBump): string {
  const v = (latest && parseSemVer(latest)) || { major: 0, minor: 0, patch: 0 };
  if (bump === 'major') return formatSemVer({ major: v.major + 1, minor: 0, patch: 0 });
  if (bump === 'minor') return formatSemVer({ major: v.major, minor: v.minor + 1, patch: 0 });
  return formatSemVer({ major: v.major, minor: v.minor, patch: v.patch + 1 });
}

/** What the release dialog preselects: 1.0.0 for the first release, then the next minor version */
export function suggestedBump(latest: string | null | undefined): ReleaseBump {
  return latest ? 'minor' : 'major';
}

export function isReleaseBump(value: unknown): value is ReleaseBump {
  return value === 'major' || value === 'minor' || value === 'patch';
}

/** One line, trimmed and capped (release notes end up in table cells) */
export function cleanReleaseNote(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_RELEASE_NOTE) : '';
}

/**
 * Short fingerprint of a text (FNV-1a, not cryptographic). The server sends it for the latest release, so a
 * client can tell whether the draft still equals the release without downloading the release.
 */
export function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${text.length.toString(36)}-${h.toString(16).padStart(8, '0')}`;
}

// ------------------------------------------------------------------ placeholders

export interface ReleaseLabels {
  version: string;
  releasedAt: string;
  releasedBy: string;
  changes: string;
  /** Shown instead of a value while there is no release yet */
  none: string;
}

export const DEFAULT_RELEASE_LABELS: ReleaseLabels = { version: 'Version', releasedAt: 'Released on', releasedBy: 'By', changes: 'Changes', none: '—' };

export interface ReleaseRenderOptions {
  /** Release date as text (default YYYY-MM-DD) */
  formatDate?: (ms: number) => string;
  labels?: ReleaseLabels;
}

/** Placeholders a versioned note may contain (filled in when rendering and exporting; the stored text keeps them) */
export const RELEASE_PLACEHOLDERS = ['{{version}}', '{{released_at}}', '{{released_by}}', '{{release_note}}', '{{version_history}}', '{{#versions}}', '{{/versions}}'] as const;

export type ReleaseField = 'version' | 'released_at' | 'released_by' | 'release_note';

/** `{{version}}`, `{{released_at}}`, `{{released_by}}`, `{{release_note}}` */
export const RELEASE_FIELD_RE = /\{\{(version|released_at|released_by|release_note)\}\}/g;
/** A line that is only `{{version_history}}` */
export const VERSION_HISTORY_LINE_RE = /^\s*\{\{version_history\}\}\s*$/;
const SECTION_RE = /\{\{#versions\}\}([\s\S]*?)\{\{\/versions\}\}(\r?\n)?/g;

/** The value of one placeholder for a release (null: no release yet) */
export function releaseFieldValue(release: NoteReleaseInfo | null | undefined, field: ReleaseField, opts: ReleaseRenderOptions = {}): string {
  const labels = opts.labels ?? DEFAULT_RELEASE_LABELS;
  if (!release) return labels.none;
  switch (field) {
    case 'version':
      return release.version;
    case 'released_at':
      return (opts.formatDate ?? ((ms) => toDateString(new Date(ms))))(release.releasedAt);
    case 'released_by':
      return release.releasedBy || labels.none;
    case 'release_note':
      return release.note || labels.none;
  }
}

/** Text safe inside a Markdown table cell */
export function tableCell(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

/** Newest first, whatever order the list came in */
export function sortReleases(releases: readonly NoteReleaseInfo[]): NoteReleaseInfo[] {
  return [...releases].sort((a, b) => {
    const va = parseSemVer(a.version);
    const vb = parseSemVer(b.version);
    return (va && vb ? compareSemVer(vb, va) : 0) || b.releasedAt - a.releasedAt;
  });
}

/** The version history as a Markdown table, newest release first */
export function releaseHistoryTable(releases: readonly NoteReleaseInfo[], opts: ReleaseRenderOptions = {}): string {
  const l = opts.labels ?? DEFAULT_RELEASE_LABELS;
  const rows = sortReleases(releases).map(
    (r) => `| ${['version', 'released_at', 'released_by', 'release_note'].map((f) => tableCell(releaseFieldValue(r, f as ReleaseField, opts))).join(' | ')} |`
  );
  if (!rows.length) rows.push(`| ${l.none} | | | |`);
  return [`| ${l.version} | ${l.releasedAt} | ${l.releasedBy} | ${l.changes} |`, '|---|---|---|---|', ...rows].join('\n');
}

/** True when the text uses any release placeholder or a ```versions block */
export function hasReleasePlaceholders(content: string): boolean {
  return /\{\{(?:version|released_at|released_by|release_note|version_history|#versions)\}\}/.test(content) || /^\s*(```|~~~)\s*versions\s*$/m.test(content);
}

/** Fills the placeholders of a text without code blocks */
function fillText(text: string, sorted: NoteReleaseInfo[], opts: ReleaseRenderOptions): string {
  const latest = sorted[0] ?? null;
  const out = text
    .split('\n')
    .map((line) => (VERSION_HISTORY_LINE_RE.test(line) ? releaseHistoryTable(sorted, opts) : line))
    .join('\n')
    .replace(SECTION_RE, (_m, body: string, newline?: string) => {
      // The closing tag on its own line: the template ends with a line break, the one after the tag goes
      const rows = sorted.map((r) => body.replace(RELEASE_FIELD_RE, (_f, field: ReleaseField) => tableCell(releaseFieldValue(r, field, opts))));
      return rows.join('') + (body.endsWith('\n') ? '' : (newline ?? ''));
    });
  return out.replace(RELEASE_FIELD_RE, (_f, field: ReleaseField) => releaseFieldValue(latest, field, opts).replace(/\s+/g, ' '));
}

/**
 * Fills the release placeholders: `{{version}}` and friends with the latest release, a line `{{version_history}}`
 * and a ```versions block with the history table, and `{{#versions}}…{{/versions}}` once per release (newest
 * first) for a self-made layout. Code blocks other than ```versions stay as they are.
 */
export function fillReleasePlaceholders(content: string, releases: readonly NoteReleaseInfo[], opts: ReleaseRenderOptions = {}): string {
  if (!hasReleasePlaceholders(content)) return content;
  const sorted = sortReleases(releases);
  const lines = content.split('\n');
  const out: string[] = [];
  let text: string[] = [];
  const flush = () => {
    if (text.length) out.push(fillText(text.join('\n'), sorted, opts));
    text = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/.exec(lines[i]);
    if (!open) {
      text.push(lines[i]);
      continue;
    }
    flush();
    const fence = open[1];
    let end = i + 1;
    while (end < lines.length && !new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`).test(lines[end])) end++;
    if (open[2].toLowerCase() === 'versions') out.push(releaseHistoryTable(sorted, opts));
    else out.push(...lines.slice(i, Math.min(end + 1, lines.length)));
    i = end;
  }
  flush();
  return out.join('\n');
}
