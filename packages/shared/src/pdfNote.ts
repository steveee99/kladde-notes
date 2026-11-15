/**
 * PDF notes: an ordinary Markdown note with `type: pdf` in its frontmatter and the uploaded PDF
 * embedded in the body. The note view shows such a note as a full-size PDF viewer.
 *
 * ---
 * type: pdf
 * ---
 * ![Bericht.pdf](/api/files/<id>)
 */
import { parseFrontmatter, setFrontmatter } from './markdown.js';
import { safeUrl } from './util.js';

/** Markdown of a new PDF note for an uploaded file */
export function pdfNoteMarkdown(name: string, url: string): string {
  const alt = name.replace(/\[/g, '(').replace(/\]/g, ')').replace(/[\r\n]+/g, ' ');
  return setFrontmatter(`![${alt}](${url})\n`, { type: 'pdf' });
}

/**
 * Image embeds `![name](url)` in order, as `/!\[([^\]\n]*)\]\(([^)\s]+)\)/g` would find them, in linear time.
 * That regex is polynomial: on `![![![…` or `![](![](…` every start scans to the end of the line again
 * (CodeQL js/polynomial-redos). Two tables computed from the right make each candidate O(1).
 */
function* imageEmbeds(text: string): Generator<[name: string, url: string]> {
  const n = text.length;
  // Next `]` or line break at or after i (n if none), and next `)` or whitespace at or after i
  const bracket = new Int32Array(n + 1);
  const stop = new Int32Array(n + 1);
  bracket[n] = n;
  stop[n] = n;
  for (let i = n - 1; i >= 0; i--) {
    const c = text[i];
    bracket[i] = c === ']' || c === '\n' ? i : bracket[i + 1];
    stop[i] = c === ')' || /\s/.test(c) ? i : stop[i + 1];
  }
  let i = text.indexOf('![');
  while (i !== -1) {
    const j = bracket[Math.min(i + 2, n)];
    let next = i + 1;
    if (j < n && text[j] === ']' && text[j + 1] === '(') {
      const k = stop[Math.min(j + 2, n)];
      if (k > j + 2 && text[k] === ')') {
        yield [text.slice(i + 2, j), text.slice(j + 2, k)];
        next = k + 1;
      }
    }
    i = text.indexOf('![', next);
  }
}

/** The embedded PDF of a note marked `type: pdf`, or null for any other note */
export function pdfNoteOf(content: string): { url: string; name: string } | null {
  const { data, body } = parseFrontmatter(content);
  if (data.type?.toLowerCase() !== 'pdf') return null;
  for (const [name, raw] of imageEmbeds(body)) {
    // The URL ends up in an iframe: only http(s) or relative, never javascript:
    const url = safeUrl(raw, 'media');
    if (!url) continue;
    if (/\.pdf$/i.test(url) || /\.pdf$/i.test(name) || url.startsWith('/api/files/')) return { url, name };
  }
  return null;
}

/** Note title for an uploaded PDF: the file name without `.pdf` */
export function pdfNoteTitle(fileName: string): string {
  return fileName.replace(/\.pdf$/i, '').trim() || 'PDF';
}
