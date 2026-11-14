import { safeUrl } from './util.js';

/** What another app hands over through the PWA share target (Web Share Target API) */
export interface SharedInput {
  title?: string;
  text?: string;
  url?: string;
}

/** A shared item as Quick Capture prefills it: a suggested note title and the Markdown body */
export interface SharedCapture {
  title: string;
  body: string;
}

const URL_ONLY = /^https?:\/\/[^\s<>]+$/i;
const TRAILING_URL = /\s(https?:\/\/[^\s<>]+)$/i;

const clean = (s: string | undefined) => (s ?? '').replace(/\r\n?/g, '\n').trim();
/** Characters that would break a link text are dropped, not escaped (as when pasting a link) */
const label = (s: string) => s.replace(/[[\]\\]/g, '').replace(/\s+/g, ' ').trim();
const sameUrl = (a: string, b: string) => a.replace(/\/$/, '') === b.replace(/\/$/, '');
/** A note title must not contain characters that are special in paths and links */
const titleOf = (s: string) =>
  s
    .replace(/[\\/:#[\]|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim();

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Turns what another app shares into Markdown: the URL becomes `[title](url)`, the text follows as is.
 * Many Android apps send the link inside `text` ("Look at this https://…"), so a URL alone in the text or at
 * its end is taken as the link. Only http(s) URLs become links; anything else stays plain text.
 */
export function sharedToMarkdown(input: SharedInput): SharedCapture {
  let title = clean(input.title);
  let text = clean(input.text);
  let url = clean(input.url);
  if (!url) {
    if (URL_ONLY.test(text)) {
      url = text;
      text = '';
    } else {
      const m = TRAILING_URL.exec(text);
      if (m) {
        url = m[1];
        text = text.slice(0, m.index).trim();
      }
    }
  }
  if (url && (!URL_ONLY.test(url) || safeUrl(url) === null)) {
    text = [text, url].filter(Boolean).join('\n\n');
    url = '';
  }
  // Apps often repeat the title or the URL in the text
  if (text && (text === title || (url && sameUrl(text, url)))) text = '';
  if (title && url && sameUrl(title, url)) title = '';

  let name = '';
  if (url) {
    // A one-line text without a title names the link ("Article title https://…")
    name = label(title || (!text.includes('\n') && text.length <= 120 ? text : '')) || hostOf(url) || url;
    if (!title && name === label(text)) text = '';
  }
  const body = [url ? `[${name}](${url})` : '', text].filter(Boolean).join('\n\n');
  return { title: titleOf(title) || titleOf(name) || titleOf(text.split('\n')[0] ?? ''), body };
}
