import { parseFrontmatter } from './markdown.js';

/*
 * Presentation mode (#87): a note becomes slides. `---` on its own line (after an empty line, so it is no setext
 * heading underline) starts a new slide; a note without such breaks gets a slide per `#`/`##` heading. Everything
 * after a line `Note:` (or `Notes:`) up to the end of the slide is speaker notes. The slide format comes from the
 * frontmatter key `presentation` (e.g. `presentation: 4:3`) and is 16:9 when nothing is set.
 */

export const SLIDE_FORMATS = ['16:9', '16:10', '4:3', '1:1', '9:16'] as const;
export type SlideFormat = (typeof SLIDE_FORMATS)[number];
export const DEFAULT_SLIDE_FORMAT: SlideFormat = '16:9';
/** Frontmatter key that holds the slide format */
export const PRESENTATION_KEY = 'presentation';

export interface Slide {
  /** Markdown of the slide, without speaker notes */
  markdown: string;
  /** Speaker notes (text after `Note:`), empty when there are none */
  notes: string;
}

/** Reads a format written as `16:9`, `16/9`, `16x9` or `16 : 9`; null when it is none of the supported ones */
export function parseSlideFormat(raw: unknown): SlideFormat | null {
  if (typeof raw !== 'string') return null;
  const m = /^\s*(\d{1,2})\s*[:/x×]\s*(\d{1,2})\s*$/i.exec(raw);
  if (!m) return null;
  const value = `${Number(m[1])}:${Number(m[2])}`;
  return (SLIDE_FORMATS as readonly string[]).includes(value) ? (value as SlideFormat) : null;
}

/** The slide format chosen on the note (frontmatter `presentation`), 16:9 when nothing (valid) is set */
export function slideFormatOf(content: string): SlideFormat {
  return parseSlideFormat(parseFrontmatter(content.replace(/\r\n/g, '\n')).data[PRESENTATION_KEY]) ?? DEFAULT_SLIDE_FORMAT;
}

/** The note was set up as a presentation: it names a slide format in its frontmatter */
export function isPresentationNote(content: string): boolean {
  return PRESENTATION_KEY in parseFrontmatter(content.replace(/\r\n/g, '\n')).data;
}

/** Width divided by height */
export function slideRatio(format: SlideFormat): number {
  const [w, h] = format.split(':').map(Number);
  return w / h;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX = /^ {0,3}(#{1,6})(?:\s|$)/;
const DASH_BREAK = /^ {0,3}-(?:\s*-){2,}\s*$/;
const OTHER_BREAK = /^ {0,3}(?:\*(?:\s*\*){2,}|_(?:\s*_){2,})\s*$/;
const LIST_OR_QUOTE = /^\s*(?:[-*+]\s|\d+[.)]\s|>)/;
const NOTES = /^ {0,3}notes?:\s*(.*)$/i;

/** One line of the body with what the splitter needs to know about it */
interface LineInfo {
  text: string;
  /** Inside a fenced code block (including its fence lines) */
  code: boolean;
  /** A thematic break that starts a new slide */
  isBreak: boolean;
  /** Heading level (ATX), 0 for none */
  heading: number;
}

function scan(lines: string[]): LineInfo[] {
  const out: LineInfo[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const f = FENCE.exec(text);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !text.trim().slice(f[1].length).trim()) fence = null;
      out.push({ text, code: true, isBreak: false, heading: 0 });
      continue;
    }
    if (f) {
      fence = f[1];
      out.push({ text, code: true, isBreak: false, heading: 0 });
      continue;
    }
    // `---` right under a paragraph line underlines a heading (setext); after an empty line, a heading, a code block,
    // a list item or a quote it is a break
    const prev = out[i - 1];
    const underline = !!prev && !prev.code && !!prev.text.trim() && !prev.heading && !LIST_OR_QUOTE.test(prev.text);
    const isBreak = OTHER_BREAK.test(text) || (DASH_BREAK.test(text) && !underline);
    const h = ATX.exec(text);
    out.push({ text, code: false, isBreak, heading: h ? h[1].length : 0 });
  }
  return out;
}

const trimBlank = (lines: string[]) => {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
};

/** Splits a slide's lines into its content and its speaker notes */
function toSlide(lines: LineInfo[]): Slide | null {
  const at = lines.findIndex((l) => !l.code && NOTES.test(l.text));
  const body = trimBlank((at < 0 ? lines : lines.slice(0, at)).map((l) => l.text));
  const notes = at < 0 ? [] : trimBlank([NOTES.exec(lines[at].text)![1], ...lines.slice(at + 1).map((l) => l.text)]);
  if (!body.length && !notes.length) return null;
  return { markdown: body.join('\n'), notes: notes.join('\n') };
}

/**
 * The slides of a note. `title` (the note's title) becomes a heading on the first slide when that slide has none,
 * so the deck opens with a title. A note without any content gives one slide with just the title.
 */
export function splitSlides(content: string, title = ''): Slide[] {
  const { body } = parseFrontmatter(content.replace(/\r\n/g, '\n'));
  const info = scan(body.split('\n'));
  const groups: LineInfo[][] = [[]];
  if (info.some((l) => l.isBreak)) {
    for (const l of info) {
      if (l.isBreak) groups.push([]);
      else groups[groups.length - 1].push(l);
    }
  } else {
    // No breaks: every `#`/`##` heading starts a slide (the content before the first heading stays on the first one)
    for (const l of info) {
      if (l.heading >= 1 && l.heading <= 2 && groups[groups.length - 1].some((x) => x.text.trim())) groups.push([]);
      groups[groups.length - 1].push(l);
    }
  }
  const slides = groups.map(toSlide).filter((s): s is Slide => !!s);
  const name = title.trim().replace(/\s+/g, ' ');
  if (!slides.length) return [{ markdown: name ? `# ${name}` : '', notes: '' }];
  if (name && !scan(slides[0].markdown.split('\n')).some((l) => l.heading > 0)) {
    slides[0] = { ...slides[0], markdown: `# ${name}\n\n${slides[0].markdown}`.trimEnd() };
  }
  return slides;
}

/**
 * A title slide: only headings and at most two short lines of text. The presentation centers these vertically
 * (cover and section slides), everything else starts at the top.
 */
export function isTitleSlide(markdown: string): boolean {
  const lines = scan(markdown.split('\n')).filter((l) => l.text.trim());
  if (!lines.length || lines.some((l) => l.code)) return false;
  const text = lines.filter((l) => !l.heading);
  if (lines.length === text.length) return false;
  return text.length <= 2 && text.every((l) => l.text.trim().length <= 120 && !/^\s*(?:[-*+]|\d+[.)]|>|\||!\[)/.test(l.text));
}
