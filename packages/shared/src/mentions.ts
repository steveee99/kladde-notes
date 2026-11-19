/*
 * @mentions (#69): `@username` in a note draws that person's attention to it. A mention starts after a space,
 * the start of a line or punctuation that is not part of an e-mail address or a path, and is a valid username
 * (3–20 letters, digits, `_`, `.`, `-`); a trailing dot ends the sentence, not the name. Code is left out.
 */

import { mapOutsideCode } from './markdown.js';

/** One mention; the name is the second group. Bounded repetition after a fixed lookbehind keeps matching linear */
export const MENTION_RE = /(?<![\p{L}\p{N}_@./\\-])@([A-Za-z0-9_.-]{3,20})(?![A-Za-z0-9_-])/gu;

/** The username of a mention as written (`@ben.` → `ben`) */
export function mentionName(raw: string): string {
  let end = raw.length;
  while (end > 0 && raw[end - 1] === '.') end--;
  return raw.slice(0, end);
}

/** Lower-cased usernames mentioned in the text, outside code */
export function extractMentions(content: string): string[] {
  const out = new Set<string>();
  mapOutsideCode(content, (text) => {
    for (const m of text.matchAll(MENTION_RE)) {
      const name = mentionName(m[1]);
      if (name.length >= 3) out.add(name.toLowerCase());
    }
    return text;
  });
  return [...out];
}

/** Names mentioned in `next` but not in `previous`: who is new to the note and should hear about it */
export function newMentions(previous: string, next: string): string[] {
  const before = new Set(extractMentions(previous));
  return extractMentions(next).filter((n) => !before.has(n));
}

/** The first line (0-based) mentioning `username`, with its text, to link to the passage */
export function mentionContext(content: string, username: string): { line: number; text: string } | null {
  const lines = content.split('\n');
  const name = username.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(MENTION_RE)) {
      if (mentionName(m[1]).toLowerCase() === name) return { line: i, text: lines[i].trim().slice(0, 200) };
    }
  }
  return null;
}

/** The task text mentions the user: the task is assigned to them */
export function mentionsUser(text: string, username: string): boolean {
  if (!username) return false;
  const name = username.toLowerCase();
  for (const m of text.matchAll(MENTION_RE)) if (mentionName(m[1]).toLowerCase() === name) return true;
  return false;
}
