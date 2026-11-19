/*
 * Callouts (#86): Obsidian-style quotes whose first line is `> [!type] Title`. The type picks an icon and a color
 * role; `-` or `+` right after it (`> [!warning]- Title`) makes the callout collapsible, collapsed or expanded by
 * default. Unknown types are shown like a note, their name stays the default title.
 */

export const CALLOUT_KINDS = ['note', 'abstract', 'info', 'todo', 'tip', 'success', 'question', 'warning', 'failure', 'danger', 'bug', 'example', 'quote'] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

/** Material 3 color role of a callout: primary, secondary, tertiary, the custom ok/warn colors, error or neutral */
export type CalloutTone = 'primary' | 'secondary' | 'tertiary' | 'ok' | 'warn' | 'error' | 'neutral';

export const CALLOUT_TONES: Record<CalloutKind, CalloutTone> = {
  note: 'primary',
  info: 'primary',
  todo: 'primary',
  abstract: 'tertiary',
  example: 'tertiary',
  tip: 'ok',
  success: 'ok',
  question: 'secondary',
  warning: 'warn',
  failure: 'error',
  danger: 'error',
  bug: 'error',
  quote: 'neutral',
};

/** Other names Obsidian accepts for the same callout */
const ALIASES: Record<string, CalloutKind> = {
  summary: 'abstract',
  tldr: 'abstract',
  hint: 'tip',
  important: 'tip',
  check: 'success',
  done: 'success',
  help: 'question',
  faq: 'question',
  caution: 'warning',
  attention: 'warning',
  fail: 'failure',
  missing: 'failure',
  error: 'danger',
  cite: 'quote',
};

export interface CalloutHeader {
  /** The type as written, lower case (`warning`, `faq`, `custom`) */
  type: string;
  kind: CalloutKind;
  /** '' = always open, '+' = collapsible and open, '-' = collapsible and collapsed */
  fold: '' | '+' | '-';
  /** Title after the type; empty when none is written */
  title: string;
}

/** `[!type]`, an optional `+`/`-`, then the title (text after the quote mark `> `) */
const HEADER = /^\[!([A-Za-z][\w-]*)\]([+-]?)(.*)$/;
/** A whole quote line: up to three spaces, `>`, an optional space */
const QUOTE_LINE = /^ {0,3}>[ \t]?/;

export function calloutKind(type: string): CalloutKind {
  const t = type.toLowerCase();
  return (CALLOUT_KINDS as readonly string[]).includes(t) ? (t as CalloutKind) : Object.hasOwn(ALIASES, t) ? ALIASES[t] : 'note';
}

/** The type is one of the kinds or one of their other names (not a type of the note's own) */
export function isKnownCalloutType(type: string): boolean {
  const t = type.toLowerCase();
  return (CALLOUT_KINDS as readonly string[]).includes(t) || Object.hasOwn(ALIASES, t);
}

/** Reads the head of a callout from the text after the quote mark; null when it is an ordinary quote */
export function parseCalloutHeader(text: string): CalloutHeader | null {
  // One unambiguous pattern, the spaces before the title are checked by hand: `\s+(.*?)\s*$` backtracks
  // polynomially on long runs of spaces (CodeQL js/polynomial-redos)
  const m = HEADER.exec(text);
  if (!m || (m[3] && !/^[ \t]/.test(m[3]))) return null;
  const type = m[1].toLowerCase();
  return { type, kind: calloutKind(type), fold: m[2] as CalloutHeader['fold'], title: m[3].trim() };
}

/** Reads the head of a callout from a whole Markdown line (`> [!tip] Title`) */
export function parseCalloutLine(line: string): CalloutHeader | null {
  const q = QUOTE_LINE.exec(line);
  return q ? parseCalloutHeader(line.slice(q[0].length)) : null;
}

/** The type as a title (`warning` → `Warning`), for callouts without one of their own */
export function calloutTypeTitle(type: string): string {
  const words = type.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
