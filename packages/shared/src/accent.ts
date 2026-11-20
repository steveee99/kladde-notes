/**
 * Accent colors of the Werkbank design (docs/DESIGN.md). Every user picks one preset; it belongs to the
 * account and follows the user to all devices. The CSS values per preset and scheme live in the client's
 * index.css (`[data-accent='…']`).
 */
export const ACCENTS = ['blue', 'amber', 'green', 'teal', 'violet', 'pink', 'coral', 'graphite'] as const;

export type Accent = (typeof ACCENTS)[number];

/** Accent of new accounts and of accounts that never picked one */
export const DEFAULT_ACCENT: Accent = 'blue';

export function isAccent(value: unknown): value is Accent {
  return typeof value === 'string' && (ACCENTS as readonly string[]).includes(value);
}

/** A stored or received value as a valid accent, falling back to the default */
export function normalizeAccent(value: unknown): Accent {
  return isAccent(value) ? value : DEFAULT_ACCENT;
}
