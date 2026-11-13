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

/** The embedded PDF of a note marked `type: pdf`, or null for any other note */
export function pdfNoteOf(content: string): { url: string; name: string } | null {
  const { data, body } = parseFrontmatter(content);
  if (data.type?.toLowerCase() !== 'pdf') return null;
  for (const m of body.matchAll(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g)) {
    const [, name, raw] = m;
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
