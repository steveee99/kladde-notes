import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IParagraphOptions,
  type ParagraphChild,
} from 'docx';
import { jsPDF } from 'jspdf';
import {
  CALLOUT_TONES,
  calloutTypeTitle,
  isKnownCalloutType,
  isTitleSlide,
  parseMarkdownForExport,
  safeExportFilename,
  slideFormatOf,
  slideRatio,
  splitSlides,
  type VariableScope,
  stripFrontmatter,
  type CalloutKind,
  type CalloutTone,
  type ExportBlock,
  type ExportInline,
  type TableAlign,
} from '@kladde/shared';
import { CALLOUT_ICON_PATHS } from '../editor/calloutIcons';
import { renderDiagram, type DiagramKind } from '../editor/diagram';
import { t } from './i18n';
import { MATH_RENDER_PX, mathKey, mathToDocx, prepareMath, rasterizeMath, type MathImage } from './mathExport';

type Rgb = [number, number, number];
/** Callout colors (#86) on paper: the light Material 3 scheme (color role, its container, text on the container) */
const CALLOUT_PRINT: Record<CalloutTone, { bar: Rgb; bg: Rgb; on: Rgb }> = {
  primary: { bar: [73, 93, 146], bg: [218, 226, 255], on: [48, 69, 120] },
  secondary: { bar: [88, 94, 113], bg: [220, 226, 249], on: [64, 70, 89] },
  tertiary: { bar: [115, 84, 113], bg: [254, 215, 249], on: [90, 61, 89] },
  ok: { bar: [0, 109, 67], bg: [196, 250, 216], on: [0, 33, 17] },
  warn: { bar: [145, 76, 0], bg: [255, 220, 195], on: [47, 21, 0] },
  error: { bar: [186, 26, 26], bg: [255, 218, 214], on: [147, 0, 10] },
  neutral: { bar: [117, 119, 128], bg: [232, 231, 239], on: [26, 27, 33] },
};
const hex = (c: Rgb) => c.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
type CalloutBlock = Extract<ExportBlock, { type: 'blockquote' }> & { callout: NonNullable<Extract<ExportBlock, { type: 'blockquote' }>['callout']> };
const calloutColors = (kind: CalloutKind) => CALLOUT_PRINT[CALLOUT_TONES[kind]];
/** The callout's title; without one its type's name, in the app language for the known types */
function calloutTitle(c: NonNullable<Extract<ExportBlock, { type: 'blockquote' }>['callout']>): ExportInline[] {
  if (c.title.trim()) return c.titleInlines;
  return [{ type: 'text', text: isKnownCalloutType(c.type) ? t(`callout.${c.kind}`) : calloutTypeTitle(c.type) }];
}
/** A list item in a callout's body (`- item`) starts with a bullet instead of the dash (in the PDF the middle dot of its Latin-1 font) */
function calloutBullet(line: ExportInline[], bullet = '•'): ExportInline[] {
  const [first, ...rest] = line;
  if (first?.type !== 'text') return line;
  const m = /^(\s*)[-*+]\s+(?:\[[ xX]\]\s+)?/.exec(first.text);
  return m ? [{ type: 'text', text: `${m[1]}${bullet}  ${first.text.slice(m[0].length)}` }, ...rest] : line;
}

/** The callout's icon as a small PNG on its container color (PDF and Word cannot draw the Material Symbol paths) */
async function calloutIcon(kind: CalloutKind): Promise<LoadedImage | null> {
  const { bar, bg } = calloutColors(kind);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" width="96" height="96"><path fill="#${hex(bar)}" d="${CALLOUT_ICON_PATHS[kind]}"/></svg>`;
  try {
    return await rasterizeToPng(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, 96, `#${hex(bg)}`);
  } catch {
    return null;
  }
}

interface LoadedImage {
  bytes: Uint8Array;
  docxType: 'png' | 'jpg';
  pdfFormat: 'PNG' | 'JPEG';
  width: number;
  height: number;
  dataUrl: string;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Exports a note as pure Markdown with YAML frontmatter stripped */
export function exportNoteAsMarkdown(title: string, content: string): void {
  const body = stripFrontmatter(content);
  const finalText = body && !body.endsWith('\n') ? `${body}\n` : body;
  downloadBlob(new Blob([finalText], { type: 'text/markdown;charset=utf-8' }), safeExportFilename(title, 'md', t('export.fallbackName')));
}

// ------------------------------------------------------------------ Image & Diagram loading

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Lesen fehlgeschlagen'));
    reader.readAsDataURL(blob);
  });
}

async function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Bild konnte nicht dekodiert werden'));
    img.src = src;
  });
}

/**
 * Draws an image into a PNG. `oversample` renders vector images (diagrams) with that many pixels per unit so they stay
 * sharp when a slide shows them larger; the reported size stays the drawing's own.
 */
async function rasterizeToPng(src: string, maxDim = 1600, background?: string, oversample = 1): Promise<LoadedImage> {
  const img = await loadHtmlImage(src);
  const w0 = Math.max(1, img.naturalWidth || img.width || 800);
  const h0 = Math.max(1, img.naturalHeight || img.height || 400);
  const scale = Math.min(1, maxDim / Math.max(w0, h0));
  const pixels = Math.min(oversample, Math.max(1, (maxDim * oversample) / Math.max(w0 * scale, h0 * scale)));
  const width = Math.max(1, Math.round(w0 * scale));
  const height = Math.max(1, Math.round(h0 * scale));

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * pixels);
  canvas.height = Math.round(height * pixels);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Kein Canvas-Kontext');
  ctx.fillStyle = background ?? '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const dataUrl = canvas.toDataURL('image/png');
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) throw new Error('PNG-Konvertierung fehlgeschlagen');
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    docxType: 'png',
    pdfFormat: 'PNG',
    width,
    height,
    dataUrl,
  };
}

async function fetchNoteImage(url: string): Promise<LoadedImage | null> {
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) return null;

    const dataUrl = await blobToDataUrl(blob);
    if (blob.type === 'image/jpeg' || blob.type === 'image/png') {
      try {
        const img = await loadHtmlImage(dataUrl);
        return {
          bytes: new Uint8Array(await blob.arrayBuffer()),
          docxType: blob.type === 'image/jpeg' ? 'jpg' : 'png',
          pdfFormat: blob.type === 'image/jpeg' ? 'JPEG' : 'PNG',
          width: Math.max(1, img.naturalWidth || 600),
          height: Math.max(1, img.naturalHeight || 400),
          dataUrl,
        };
      } catch {
        return null;
      }
    }
    // WebP, AVIF, GIF, SVG -> rasterize to PNG
    return await rasterizeToPng(dataUrl);
  } catch {
    return null;
  }
}

async function renderDiagramImage(kind: DiagramKind, src: string): Promise<LoadedImage | null> {
  try {
    const res = await renderDiagram(kind, src);
    if (!res.svg) return null;
    const parser = new DOMParser();
    const doc = parser.parseFromString(res.svg, 'image/svg+xml');
    const svgEl = doc.documentElement;
    if (!svgEl.getAttribute('xmlns')) svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

    // Read current surface color so Mermaid/Mindmap diagrams retain theme contrast
    const rawBg = getComputedStyle(document.documentElement).getPropertyValue('--surface-container-low').trim().split(/[\s/]+/).slice(0, 3).map(Number);
    const bg = rawBg.length >= 3 && !rawBg.some(Number.isNaN) ? `rgb(${rawBg[0]}, ${rawBg[1]}, ${rawBg[2]})` : '#ffffff';

    const serialized = new XMLSerializer().serializeToString(svgEl);
    const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`;
    return await rasterizeToPng(svgUrl, 1600, bg, 3);
  } catch {
    return null;
  }
}

/** Every formula (#85) of the blocks: display blocks and the ones inside text */
function collectMath(blocks: ExportBlock[]): { tex: string; display: boolean }[] {
  const out: { tex: string; display: boolean }[] = [];
  const scan = (inlines: ExportInline[]) => {
    for (const i of inlines) if (i.type === 'math') out.push({ tex: i.tex, display: i.display });
  };
  for (const b of blocks) {
    if (b.type === 'math') out.push({ tex: b.tex, display: true });
    else if (b.type === 'heading' || b.type === 'paragraph' || b.type === 'footnote') scan(b.inlines);
    else if (b.type === 'list') b.items.forEach((it) => scan(it.inlines));
    else if (b.type === 'blockquote') {
      b.lines.forEach(scan);
      if (b.callout) scan(b.callout.titleInlines);
    } else if (b.type === 'table') {
      b.headers.forEach(scan);
      b.rows.forEach((r) => r.forEach(scan));
    }
  }
  return out;
}

/** Rasterized formulas of the PDF being drawn (set while one is exported) */
let pdfMath = new Map<string, MathImage | null>();

async function preloadMedia(blocks: ExportBlock[]) {
  const images = new Map<string, LoadedImage | null>();
  const diagrams = new Map<string, LoadedImage | null>();
  const icons = new Map<CalloutKind, LoadedImage | null>();
  const jobs: Promise<void>[] = [];

  for (const b of blocks) {
    if (b.type === 'blockquote' && b.callout && !icons.has(b.callout.kind)) {
      const kind = b.callout.kind;
      icons.set(kind, null);
      jobs.push(calloutIcon(kind).then((res) => void icons.set(kind, res)));
    } else if (b.type === 'image' && !images.has(b.url)) {
      images.set(b.url, null);
      jobs.push(
        fetchNoteImage(b.url).then((res) => {
          images.set(b.url, res);
        })
      );
    } else if (b.type === 'code' && (b.lang === 'mermaid' || b.lang === 'mindmap')) {
      const key = `${b.lang}\n${b.code}`;
      if (!diagrams.has(key)) {
        diagrams.set(key, null);
        jobs.push(
          renderDiagramImage(b.lang as DiagramKind, b.code).then((res) => {
            diagrams.set(key, res);
          })
        );
      }
    }
  }
  await Promise.all(jobs);
  return { images, diagrams, icons };
}

function fitSize(w: number, h: number, maxW: number, maxH: number) {
  const ratio = Math.min(1, maxW / w, maxH / h);
  return { width: Math.max(1, Math.round(w * ratio)), height: Math.max(1, Math.round(h * ratio)) };
}

// ------------------------------------------------------------------ Word (.docx) Export

function docxRuns(
  inlines: ExportInline[],
  opts: { muted?: boolean; strike?: boolean; bold?: boolean; color?: string; font?: string; italics?: boolean; size?: number } = {}
): ParagraphChild[] {
  const runs: ParagraphChild[] = [];
  for (const span of inlines) {
    const base = {
      font: opts.font,
      size: opts.size,
      color: opts.color ?? (opts.muted ? '666666' : undefined),
      strike: opts.strike || undefined,
      bold: opts.bold || undefined,
      italics: opts.italics || undefined,
    };
    switch (span.type) {
      case 'text':
        runs.push(new TextRun({ ...base, text: span.text }));
        break;
      case 'strong':
        runs.push(new TextRun({ ...base, text: span.text, bold: true }));
        break;
      case 'em':
        runs.push(new TextRun({ ...base, text: span.text, italics: true }));
        break;
      case 'strike':
        runs.push(new TextRun({ ...base, text: span.text, strike: true, color: '777777' }));
        break;
      case 'code':
        runs.push(
          new TextRun({
            text: span.text,
            font: 'Courier New',
            bold: opts.bold || undefined,
            size: opts.size ? opts.size - 2 : 20,
            shading: { type: ShadingType.SOLID, color: 'F1EFEA', fill: 'F1EFEA' },
          })
        );
        break;
      case 'link':
        if (/^https?:\/\//i.test(span.url)) {
          runs.push(
            new ExternalHyperlink({
              link: span.url,
              children: [new TextRun({ ...base, text: span.text, color: '4F46E5', underline: {} })],
            })
          );
        } else {
          runs.push(new TextRun({ ...base, text: span.text, color: '4F46E5' }));
        }
        break;
      case 'wikilink':
        runs.push(new TextRun({ ...base, text: span.label, color: '4F46E5', underline: {} }));
        break;
      case 'tag':
        runs.push(new TextRun({ ...base, text: span.text, color: '0D9488' }));
        break;
      case 'footnoteRef':
        runs.push(new TextRun({ ...base, text: `[${span.id}]`, superScript: true, color: '4F46E5' }));
        break;
      case 'math':
        runs.push(mathToDocx(span.tex, span.display));
        break;
    }
  }
  return runs;
}

const DOCX_HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

const docxAlign = (a: TableAlign) =>
  a === 'center' ? AlignmentType.CENTER : a === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT;

/** Exports a note as a Word (.docx) document without frontmatter */
export async function exportNoteAsWord(title: string, content: string, variables?: VariableScope): Promise<void> {
  const parsed = parseMarkdownForExport(title, content, variables);
  const { images, diagrams, icons } = await preloadMedia(parsed.blocks);
  if (collectMath(parsed.blocks).length) await prepareMath();

  const children: (Paragraph | Table)[] = [];

  if (!parsed.hasLeadingH1 && title.trim()) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { after: 200 },
        children: [new TextRun({ text: title.trim(), bold: true })],
      })
    );
  }

  for (const block of parsed.blocks) {
    switch (block.type) {
      case 'heading':
        children.push(
          new Paragraph({
            heading: DOCX_HEADINGS[block.level - 1] ?? HeadingLevel.HEADING_6,
            spacing: { before: 220, after: 100 },
            children: docxRuns(block.inlines),
          })
        );
        break;

      case 'paragraph':
        children.push(
          new Paragraph({
            spacing: { after: 140 },
            children: docxRuns(block.inlines),
          })
        );
        break;

      case 'list':
        for (const item of block.items) {
          const level = Math.min(4, item.indent);
          if (item.checked !== undefined) {
            children.push(
              new Paragraph({
                indent: { left: 360 * (level + 1), hanging: 260 },
                spacing: { after: 80 },
                children: [
                  new TextRun({
                    text: item.checked ? '☑  ' : '☐  ',
                    color: item.checked ? '22A05A' : '686674',
                  }),
                  ...docxRuns(item.inlines, { strike: item.checked, muted: item.checked }),
                ],
              })
            );
          } else {
            const listOpts: IParagraphOptions = block.ordered
              ? { numbering: { reference: 'kladde-numbered', level } }
              : { bullet: { level } };
            children.push(
              new Paragraph({
                ...listOpts,
                spacing: { after: 80 },
                children: docxRuns(item.inlines),
              })
            );
          }
        }
        break;

      case 'blockquote':
        if (block.callout) {
          // Callout (#86): shaded paragraphs with a bar in the type's color, the head with icon and bold title
          const { bar, bg, on } = calloutColors(block.callout.kind);
          const box = {
            shading: { type: ShadingType.SOLID, color: hex(bg), fill: hex(bg) },
            border: { left: { style: BorderStyle.SINGLE, size: 24, color: hex(bar), space: 8 } },
            indent: { left: 240, right: 120 },
          };
          const icon = icons.get(block.callout.kind);
          children.push(
            new Paragraph({
              ...box,
              spacing: { before: 120, after: block.lines.length ? 40 : 160 },
              children: [
                ...(icon ? [new ImageRun({ type: icon.docxType, data: icon.bytes, transformation: { width: 14, height: 14 } }), new TextRun({ text: '  ' })] : []),
                ...docxRuns(calloutTitle(block.callout), { bold: true, color: hex(on) }),
              ],
            })
          );
          block.lines.forEach((l, idx) =>
            children.push(new Paragraph({ ...box, spacing: { after: idx === block.lines.length - 1 ? 160 : 40 }, children: docxRuns(calloutBullet(l), { color: hex(on) }) }))
          );
          break;
        }
        for (let idx = 0; idx < block.lines.length; idx++) {
          children.push(
            new Paragraph({
              indent: { left: 360 },
              border: { left: { style: BorderStyle.SINGLE, size: 18, color: '6D5DFC', space: 10 } },
              spacing: { after: idx === block.lines.length - 1 ? 160 : 60 },
              children: docxRuns(block.lines[idx], { italics: true, muted: true }),
            })
          );
        }
        break;

      case 'code': {
        if (block.lang === 'mermaid' || block.lang === 'mindmap') {
          const img = diagrams.get(`${block.lang}\n${block.code}`);
          if (img) {
            const size = fitSize(img.width, img.height, 560, 420);
            children.push(
              new Paragraph({
                spacing: { before: 80, after: 140 },
                children: [new ImageRun({ type: img.docxType, data: img.bytes, transformation: size })],
              })
            );
            break;
          }
        }
        const codeLines = block.code.split('\n');
        // File name from `title="…"` (codeInfo.ts) as a caption above the block
        if (block.title) {
          children.push(
            new Paragraph({
              shading: { type: ShadingType.SOLID, color: 'E6E3DC', fill: 'E6E3DC' },
              indent: { left: 160, right: 160 },
              spacing: { before: 80, after: 0 },
              children: [new TextRun({ text: block.title, font: 'Courier New', size: 17, color: '5A574F' })],
            })
          );
        }
        for (let idx = 0; idx < codeLines.length; idx++) {
          children.push(
            new Paragraph({
              shading: { type: ShadingType.SOLID, color: 'F3F2EE', fill: 'F3F2EE' },
              indent: { left: 160, right: 160 },
              spacing: { before: idx === 0 && !block.title ? 80 : 0, after: idx === codeLines.length - 1 ? 160 : 20 },
              children: [new TextRun({ text: codeLines[idx] || ' ', font: 'Courier New', size: 19 })],
            })
          );
        }
        break;
      }

      case 'table': {
        const colBorder = { style: BorderStyle.SINGLE, size: 4, color: 'D4D1C8' };
        const cellMargins = { top: 80, bottom: 80, left: 120, right: 120 };
        const headerRow = new TableRow({
          tableHeader: true,
          children: block.headers.map(
            (h, c) =>
              new TableCell({
                shading: { type: ShadingType.SOLID, color: 'EAE8E3', fill: 'EAE8E3' },
                margins: cellMargins,
                borders: { top: colBorder, bottom: colBorder, left: colBorder, right: colBorder },
                children: [
                  new Paragraph({
                    alignment: docxAlign(block.align[c] ?? null),
                    children: docxRuns(h, { bold: true }),
                  }),
                ],
              })
          ),
        });
        const bodyRows = block.rows.map(
          (row) =>
            new TableRow({
              children: row.map(
                (cell, c) =>
                  new TableCell({
                    margins: cellMargins,
                    borders: { top: colBorder, bottom: colBorder, left: colBorder, right: colBorder },
                    children: [
                      new Paragraph({
                        alignment: docxAlign(block.align[c] ?? null),
                        children: docxRuns(cell),
                      }),
                    ],
                  })
              ),
            })
        );
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [headerRow, ...bodyRows],
          }),
          new Paragraph({ spacing: { after: 140 }, children: [] })
        );
        break;
      }

      case 'image': {
        const img = images.get(block.url);
        if (img) {
          const size = fitSize(img.width, img.height, 560, 440);
          children.push(
            new Paragraph({
              spacing: { before: 80, after: block.alt ? 40 : 140 },
              children: [new ImageRun({ type: img.docxType, data: img.bytes, transformation: size })],
            })
          );
          if (block.alt) {
            children.push(
              new Paragraph({
                spacing: { after: 140 },
                children: [new TextRun({ text: block.alt, italics: true, size: 18, color: '686674' })],
              })
            );
          }
        } else {
          const label = block.alt ? `${t('export.docAttachment')}: ${block.alt}` : `${t('export.docAttachment')}: ${block.url}`;
          children.push(
            new Paragraph({
              spacing: { after: 120 },
              children: [new TextRun({ text: `[${label}]`, italics: true, color: '686674' })],
            })
          );
        }
        break;
      }

      case 'math':
        children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 80, after: 140 }, children: [mathToDocx(block.tex, true)] }));
        break;

      case 'hr':
        children.push(
          new Paragraph({
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D4D1C8', space: 4 } },
            spacing: { before: 100, after: 180 },
            children: [],
          })
        );
        break;

      case 'toc':
        children.push(
          new Paragraph({
            spacing: { before: 120, after: 80 },
            children: [new TextRun({ text: t('export.docTocTitle'), bold: true, size: 22, color: '4F46E5' })],
          })
        );
        if (!block.items.length) {
          children.push(
            new Paragraph({
              spacing: { after: 120 },
              children: [new TextRun({ text: t('export.docTocEmpty'), italics: true, size: 19, color: '686674' })],
            })
          );
        } else {
          for (const item of block.items) {
            children.push(
              new Paragraph({
                indent: { left: Math.max(0, item.level - 1) * 280 + 160 },
                spacing: { after: 40 },
                children: [new TextRun({ text: item.text, size: 20, bold: item.level === 1, color: item.level <= 2 ? '1C1B22' : '555462' })],
              })
            );
          }
        }
        break;

      case 'footnote':
        children.push(
          new Paragraph({
            spacing: { after: 60 },
            children: [
              new TextRun({ text: `[${block.id}] `, bold: true, size: 18, color: '4F46E5' }),
              ...docxRuns(block.inlines, { size: 18, muted: true }),
            ],
          })
        );
        break;
    }
  }

  const doc = new Document({
    title: title || t('export.fallbackName'),
    numbering: {
      config: [
        {
          reference: 'kladde-numbered',
          levels: [0, 1, 2, 3, 4].map((level) => ({
            level,
            format: 'decimal',
            text: `%${level + 1}.`,
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 420 * (level + 1), hanging: 260 } } },
          })),
        },
      ],
    },
    styles: {
      default: {
        document: {
          run: { font: 'Calibri', size: 22, color: '1C1B22' },
          paragraph: { spacing: { line: 276 } },
        },
      },
    },
    sections: [{ children }],
  });

  const blob = await Packer.toBlob(doc);
  downloadBlob(blob, safeExportFilename(title, 'docx', t('export.fallbackName')));
}

// ------------------------------------------------------------------ PDF Export

/** Normalizes symbols not present in PDF standard WinAnsi fonts */
function pdfSafeText(text: string): string {
  return text
    .replace(/📅\s*/g, 'Faellig: ')
    .replace(/🔁\s*/g, 'Wdh: ')
    .replace(/✅\s*/g, 'Erledigt: ')
    .replace(/⚡\s*/g, '*')
    .replace(/→/g, '->')
    .replace(/←/g, '<-')
    .replace(/↔/g, '<->')
    .replace(/≥/g, '>=')
    .replace(/≤/g, '<=')
    .replace(/[^\x09\x0a\x20-\xff]/g, (ch) => {
      const code = ch.charCodeAt(0);
      if (code === 0x2013 || code === 0x2014) return '-';
      if (code === 0x2026) return '...';
      if (code === 0x2018 || code === 0x2019) return "'";
      if (code === 0x201c || code === 0x201d || code === 0x201e) return '"';
      if (code === 0x2022) return '*';
      if (code === 0x20ac) return 'EUR';
      if (code === 0x202f || code === 0x00a0) return ' ';
      return '';
    });
}

interface PdfSeg {
  text: string;
  font: 'helvetica' | 'courier';
  style: 'normal' | 'bold' | 'italic' | 'bolditalic';
  color: [number, number, number];
  url?: string;
  codeBg?: boolean;
  strike?: boolean;
  /** A formula (#85) drawn as an image in the text line */
  math?: MathImage;
}

/** Width and height of a formula image at a font size, in points */
const mathSize = (m: MathImage, fontSize: number) => ({ w: (m.width * fontSize) / MATH_RENDER_PX, h: (m.height * fontSize) / MATH_RENDER_PX, base: (m.baseline * fontSize) / MATH_RENDER_PX });

function inlinesToPdfSegs(inlines: ExportInline[], baseStyle: 'normal' | 'italic' = 'normal', baseColor: [number, number, number] = [28, 27, 34], strikeAll = false): PdfSeg[] {
  const segs: PdfSeg[] = [];
  for (const span of inlines) {
    const push = (raw: string, extra: Partial<PdfSeg> = {}) => {
      const text = pdfSafeText(raw);
      if (!text) return;
      segs.push({ text, font: 'helvetica', style: baseStyle, color: baseColor, strike: strikeAll, ...extra });
    };
    switch (span.type) {
      case 'text':
        push(span.text);
        break;
      case 'strong':
        push(span.text, { style: baseStyle === 'italic' ? 'bolditalic' : 'bold' });
        break;
      case 'em':
        push(span.text, { style: 'italic' });
        break;
      case 'strike':
        push(span.text, { strike: true, color: [120, 118, 130] });
        break;
      case 'code':
        push(span.text, { font: 'courier', style: 'normal', codeBg: true });
        break;
      case 'link':
        push(span.text, { color: [79, 70, 229], url: /^https?:\/\//i.test(span.url) ? span.url : undefined });
        break;
      case 'wikilink':
        push(span.label, { color: [79, 70, 229] });
        break;
      case 'tag':
        push(span.text, { color: [13, 148, 136] });
        break;
      case 'footnoteRef':
        push(`[${span.id}]`, { color: [79, 70, 229] });
        break;
      case 'math': {
        const img = pdfMath.get(mathKey(span.tex, span.display));
        if (img) segs.push({ text: '', font: 'helvetica', style: baseStyle, color: baseColor, math: img });
        else push(span.tex, { font: 'courier', style: 'normal' });
        break;
      }
    }
  }
  return segs;
}

/** Wraps styled inline segments into lines matching maxWidth without splitting words unnecessarily */
function wrapPdfSegs(pdf: jsPDF, segs: PdfSeg[], fontSize: number, maxWidth: number): PdfSeg[][] {
  pdf.setFontSize(fontSize);
  const measure = (s: PdfSeg) => {
    if (s.math) return mathSize(s.math, fontSize).w;
    pdf.setFont(s.font, s.style);
    return pdf.getTextWidth(s.text);
  };

  // Split segments into whitespace-preserving tokens for clean wrapping
  const tokens: PdfSeg[] = [];
  for (const seg of segs) {
    if (seg.math) {
      tokens.push(seg);
      continue;
    }
    const parts = seg.text.split(/(\s+)/);
    for (const part of parts) {
      if (!part) continue;
      if (/^\s+$/.test(part) || measure({ ...seg, text: part }) <= maxWidth) {
        tokens.push({ ...seg, text: part });
      } else {
        // Hard-wrap long token (e.g. long URL)
        let chunk = '';
        for (const ch of part) {
          if (measure({ ...seg, text: chunk + ch }) > maxWidth && chunk) {
            tokens.push({ ...seg, text: chunk });
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        if (chunk) tokens.push({ ...seg, text: chunk });
      }
    }
  }

  const lines: PdfSeg[][] = [];
  let line: PdfSeg[] = [];
  let lineW = 0;

  for (const tok of tokens) {
    const isSpace = /^\s+$/.test(tok.text);
    if (line.length === 0 && isSpace) continue;
    const w = measure(tok) + (tok.codeBg ? 4 : 0);
    if (line.length > 0 && lineW + w > maxWidth && !isSpace) {
      // Trim trailing whitespace on wrapped line
      while (line.length && /^\s+$/.test(line[line.length - 1].text)) line.pop();
      lines.push(line);
      line = [];
      lineW = 0;
    }
    line.push(tok);
    lineW += w;
  }
  while (line.length && /^\s+$/.test(line[line.length - 1].text)) line.pop();
  if (line.length) lines.push(line);
  return lines.length ? lines : [[]];
}

type Media = Awaited<ReturnType<typeof preloadMedia>>;

/** Where and how big blocks are drawn: the A4 document or one slide (#87) */
interface PdfFrame {
  pdf: jsPDF;
  media: Media;
  /** Left edge and width of the text column */
  x: number;
  width: number;
  /** Top margin and the lowest y text may reach on a page */
  top: number;
  limit: number;
  /** Factor for every font size and spacing (1 = the A4 document) */
  s: number;
  /** 'page': a full page continues on a new one (document); 'flag': `overflow` is set instead (a slide that must shrink) */
  mode: 'page' | 'flag';
  /** Colors of headings, bullets and quote bars */
  accent: [number, number, number];
  heading: [number, number, number];
  /** Images may grow beyond their size up to this factor (slides fill their space) */
  grow: number;
  /** Headings and paragraphs centered (title slides) */
  center?: boolean;
  y: number;
  overflow: boolean;
}

function ensureSpace(f: PdfFrame, needed: number) {
  if (f.y + needed <= f.limit) return;
  if (f.mode === 'page') {
    f.pdf.addPage();
    f.y = f.top;
  } else f.overflow = true;
}

/** A callout's box (#86): drawn line by line behind the text, so it continues on the next page */
interface PdfBox {
  x: number;
  w: number;
  bg: Rgb;
  bar: Rgb;
}

function drawBoxBand(f: PdfFrame, box: PdfBox, top: number, h: number) {
  f.pdf.setFillColor(box.bg[0], box.bg[1], box.bg[2]);
  // A little taller than the band, so no hairline shows between neighbours (the next band paints over the rest)
  f.pdf.rect(box.x, top, box.w, h + 0.75, 'F');
  f.pdf.setFillColor(box.bar[0], box.bar[1], box.bar[2]);
  f.pdf.rect(box.x, top, 3 * f.s, h + 0.75, 'F');
}

function drawWrappedLines(f: PdfFrame, lines: PdfSeg[][], x: number, fontSize: number, lineHeight: number, opts?: { quoteBar?: boolean; align?: TableAlign; maxW?: number; box?: PdfBox }) {
  const { pdf } = f;
  for (const line of lines) {
    ensureSpace(f, lineHeight);
    if (opts?.box) drawBoxBand(f, opts.box, f.y - fontSize * 0.85, lineHeight);
    if (opts?.quoteBar) {
      pdf.setFillColor(f.accent[0], f.accent[1], f.accent[2]);
      pdf.rect(x - 10 * f.s, f.y - fontSize * 0.85, 2.5 * f.s, lineHeight, 'F');
    }
    pdf.setFontSize(fontSize);
    const totalLineW = line.reduce((sum, seg) => {
      if (seg.math) return sum + mathSize(seg.math, fontSize).w;
      pdf.setFont(seg.font, seg.style);
      return sum + pdf.getTextWidth(seg.text) + (seg.codeBg ? 4 : 0);
    }, 0);
    let cx = x;
    if (opts?.maxW && opts.align === 'center') cx = x + Math.max(0, (opts.maxW - totalLineW) / 2);
    else if (opts?.maxW && opts.align === 'right') cx = x + Math.max(0, opts.maxW - totalLineW);

    for (const seg of line) {
      if (seg.math) {
        // Baseline of the formula on the text baseline
        const m = mathSize(seg.math, fontSize);
        pdf.addImage(seg.math.dataUrl, 'PNG', cx, f.y - m.base, m.w, m.h);
        cx += m.w;
        continue;
      }
      pdf.setFont(seg.font, seg.style);
      const w = pdf.getTextWidth(seg.text);
      if (seg.codeBg) {
        pdf.setFillColor(240, 238, 234);
        pdf.roundedRect(cx, f.y - fontSize * 0.82, w + 4, fontSize * 1.1, 2, 2, 'F');
        cx += 2;
      }
      pdf.setTextColor(seg.color[0], seg.color[1], seg.color[2]);
      pdf.text(seg.text, cx, f.y);
      if (seg.url) {
        pdf.setDrawColor(seg.color[0], seg.color[1], seg.color[2]);
        pdf.setLineWidth(0.5 * f.s);
        pdf.line(cx, f.y + 1.5 * f.s, cx + w, f.y + 1.5 * f.s);
        pdf.link(cx, f.y - fontSize, w, fontSize * 1.2, { url: seg.url });
      }
      if (seg.strike) {
        pdf.setDrawColor(120, 118, 130);
        pdf.setLineWidth(0.7 * f.s);
        pdf.line(cx, f.y - fontSize * 0.3, cx + w, f.y - fontSize * 0.3);
      }
      cx += w + (seg.codeBg ? 2 : 0);
    }
    f.y += lineHeight;
  }
}

/** A callout (#86): a box in its type's color, the head with icon and bold title, then the body lines */
function drawPdfCallout(f: PdfFrame, block: CalloutBlock, bodySize: number, bodyLh: number) {
  const { pdf, s } = f;
  const { bar, bg, on } = calloutColors(block.callout.kind);
  const box: PdfBox = { x: f.x, w: f.width, bg, bar };
  const pad = 6 * s;
  const textX = f.x + 14 * s;
  const textW = f.width - 26 * s;
  const icon = f.media.icons.get(block.callout.kind);
  const iconSize = bodySize * 1.15;
  const titleX = textX + (icon ? iconSize + 6 * s : 0);
  const title = wrapPdfSegs(
    pdf,
    inlinesToPdfSegs(calloutTitle(block.callout), 'normal', on).map((seg) => ({ ...seg, style: seg.style === 'italic' ? 'bolditalic' : 'bold' })),
    bodySize,
    textW - (titleX - textX)
  );
  f.y += 4 * s;
  // Keep the head with the padding above it and the first body line
  ensureSpace(f, pad + bodyLh * Math.min(2, title.length + block.lines.length));
  drawBoxBand(f, box, f.y - bodySize * 0.85, pad);
  f.y += pad;
  const headY = f.y;
  drawWrappedLines(f, title, titleX, bodySize, bodyLh, { box });
  if (icon) pdf.addImage(icon.dataUrl, icon.pdfFormat, textX, headY - bodySize * 0.92, iconSize, iconSize);
  for (const qLine of block.lines) {
    drawWrappedLines(f, wrapPdfSegs(pdf, inlinesToPdfSegs(calloutBullet(qLine, '\u00b7'), 'normal', on), bodySize, textW), textX, bodySize, bodyLh, { box });
  }
  drawBoxBand(f, box, f.y - bodySize * 0.85, pad);
  f.y += pad + 8 * s;
}

/** Draws Markdown blocks into the frame, starting at `f.y` */
function drawPdfBlocks(f: PdfFrame, blocks: ExportBlock[]) {
  const { pdf, s, media } = f;
  const { images, diagrams } = media;
  const marginX = f.x;
  const contentW = f.width;
  const bodySize = 10.5 * s;
  const bodyLh = 15.5 * s;
  /** Room for an image or diagram: on a slide what is left of it (at least half), in the document a page */
  const mediaRoom = (extra: number) => (f.mode === 'flag' ? Math.max(f.limit - f.y - extra, (f.limit - f.top) * 0.5) : f.limit - f.top - extra);
  const fitMedia = (w: number, h: number, maxW: number, maxH: number) => {
    const ratio = Math.min(f.grow, maxW / w, maxH / h);
    return { width: Math.max(1, Math.round(w * ratio)), height: Math.max(1, Math.round(h * ratio)) };
  };

  for (const block of blocks) {
    switch (block.type) {
      case 'heading': {
        const sizes = [21, 16, 13.5, 11.5, 11, 10.5];
        const sz = (sizes[block.level - 1] ?? 10.5) * s;
        const slide = f.mode === 'flag';
        const lh = sz * (slide ? 1.2 : 1.35);
        // On a slide the first heading starts at the top edge; there `y` is the baseline of body text, so a larger
        // heading moves down by its extra height
        if (!slide || f.y > f.top + bodySize) f.y += (block.level <= 2 ? 8 : 5) * s;
        ensureSpace(f, lh + 18 * s); // Keep headings with following content
        const lines = wrapPdfSegs(
          pdf,
          inlinesToPdfSegs(block.inlines, 'normal', f.heading).map((seg) => ({
            ...seg,
            style: seg.style === 'italic' ? 'bolditalic' : 'bold',
          })),
          sz,
          contentW
        );
        if (slide) f.y += (sz - bodySize) * 0.8;
        drawWrappedLines(f, lines, marginX, sz, lh, f.center ? { align: 'center', maxW: contentW } : undefined);
        f.y += 4 * s;
        break;
      }

      case 'paragraph': {
        const lines = wrapPdfSegs(pdf, inlinesToPdfSegs(block.inlines, 'normal', f.center ? [68, 71, 78] : undefined), bodySize, contentW);
        drawWrappedLines(f, lines, marginX, bodySize, bodyLh, f.center ? { align: 'center', maxW: contentW } : undefined);
        f.y += 6 * s;
        break;
      }

      case 'list': {
        let counter = 0;
        for (const item of block.items) {
          if (item.indent === 0) counter++;
          const indentX = marginX + Math.min(4, item.indent) * 16 * s;
          const textX = indentX + 16 * s;
          const availW = marginX + contentW - textX;
          const lines = wrapPdfSegs(
            pdf,
            inlinesToPdfSegs(item.inlines, 'normal', item.checked ? [130, 128, 140] : [28, 27, 34], item.checked === true),
            bodySize,
            availW
          );
          ensureSpace(f, bodyLh);

          if (item.checked !== undefined) {
            const box = 9 * s;
            const boxY = f.y - 8.5 * s;
            if (item.checked) {
              pdf.setFillColor(f.accent[0], f.accent[1], f.accent[2]);
              pdf.roundedRect(indentX + 2 * s, boxY, box, box, 1.5 * s, 1.5 * s, 'F');
              pdf.setDrawColor(255, 255, 255);
              pdf.setLineWidth(1.3 * s);
              pdf.line(indentX + 4 * s, boxY + 4.8 * s, indentX + 6 * s, boxY + 6.8 * s);
              pdf.line(indentX + 6 * s, boxY + 6.8 * s, indentX + 9.2 * s, boxY + 2.5 * s);
            } else {
              pdf.setDrawColor(130, 128, 140);
              pdf.setLineWidth(1 * s);
              pdf.roundedRect(indentX + 2 * s, boxY, box, box, 1.5 * s, 1.5 * s, 'S');
            }
          } else if (block.ordered) {
            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(bodySize);
            pdf.setTextColor(104, 102, 116);
            pdf.text(`${item.indent === 0 ? counter : '-'}.`, indentX + 1 * s, f.y);
          } else {
            pdf.setFillColor(f.accent[0], f.accent[1], f.accent[2]);
            pdf.circle(indentX + 6 * s, f.y - 3.2 * s, 2.1 * s, 'F');
          }

          drawWrappedLines(f, lines, textX, bodySize, bodyLh);
        }
        f.y += 6 * s;
        break;
      }

      case 'blockquote': {
        if (block.callout) {
          drawPdfCallout(f, block as CalloutBlock, bodySize, bodyLh);
          break;
        }
        for (const qLine of block.lines) {
          const lines = wrapPdfSegs(pdf, inlinesToPdfSegs(qLine, 'italic', [96, 94, 108]), bodySize, contentW - 18 * s);
          drawWrappedLines(f, lines, marginX + 14 * s, bodySize, bodyLh, { quoteBar: true });
        }
        f.y += 6 * s;
        break;
      }

      case 'code': {
        if (block.lang === 'mermaid' || block.lang === 'mindmap') {
          const img = diagrams.get(`${block.lang}\n${block.code}`);
          if (img) {
            const size = fitMedia(img.width * 0.72 * s, img.height * 0.72 * s, contentW, mediaRoom(20 * s));
            ensureSpace(f, size.height + 10 * s);
            pdf.addImage(img.dataUrl, img.pdfFormat, marginX + (f.mode === 'flag' ? (contentW - size.width) / 2 : 0), f.y, size.width, size.height);
            f.y += size.height + 10 * s;
            break;
          }
        }
        const codeSize = 9 * s;
        if (block.title) {
          // File name from `title="…"` (codeInfo.ts) as a caption above the block
          ensureSpace(f, 30 * s);
          pdf.setFont('courier', 'normal');
          pdf.setFontSize(8 * s);
          pdf.setTextColor(90, 87, 79);
          pdf.text(pdfSafeText(block.title), marginX + 2 * s, f.y + 8 * s);
          f.y += 12 * s;
        }
        pdf.setFont('courier', 'normal');
        pdf.setFontSize(codeSize);
        const codeLines: string[] = [];
        for (const rawLine of block.code.split('\n')) {
          const wrapped = pdf.splitTextToSize(pdfSafeText(rawLine) || ' ', contentW - 18 * s) as string[];
          codeLines.push(...wrapped);
        }
        const lh = 13 * s;
        let idx = 0;
        while (idx < codeLines.length) {
          let take = codeLines.length - idx;
          if (f.mode === 'page') {
            const avail = Math.floor((f.limit - f.y - 12) / lh);
            if (avail < 2 && f.y > f.top) {
              pdf.addPage();
              f.y = f.top;
              continue;
            }
            take = Math.min(take, Math.max(1, avail));
          } else if (f.y + take * lh + 10 * s > f.limit) f.overflow = true;
          const chunk = codeLines.slice(idx, idx + take);
          const boxH = chunk.length * lh + 10 * s;
          pdf.setFillColor(242, 240, 236);
          pdf.roundedRect(marginX, f.y, contentW, boxH, 4 * s, 4 * s, 'F');
          pdf.setTextColor(40, 39, 48);
          pdf.setFont('courier', 'normal');
          pdf.setFontSize(codeSize);
          let ty = f.y + 13 * s;
          for (const cl of chunk) {
            pdf.text(cl, marginX + 9 * s, ty);
            ty += lh;
          }
          f.y += boxH + 4 * s;
          idx += chunk.length;
        }
        f.y += 4 * s;
        break;
      }

      case 'table': {
        const colCount = Math.max(1, block.headers.length);
        const colW = contentW / colCount;
        const padX = 6 * s;
        const padY = 5 * s;
        const cellSize = 9.5 * s;
        const rowLh = 13 * s;

        const renderRow = (cells: ExportInline[][], isHeader: boolean) => {
          const wrappedCells = cells.map((cell) => {
            const segs = inlinesToPdfSegs(cell).map((seg) => (isHeader ? { ...seg, style: 'bold' as const } : seg));
            return wrapPdfSegs(pdf, segs, cellSize, colW - padX * 2);
          });
          const maxLines = Math.max(1, ...wrappedCells.map((l) => l.length));
          const rowH = maxLines * rowLh + padY * 2;
          ensureSpace(f, rowH);

          if (isHeader) {
            pdf.setFillColor(238, 236, 230);
            pdf.rect(marginX, f.y, contentW, rowH, 'F');
          }
          pdf.setDrawColor(216, 213, 206);
          pdf.setLineWidth(0.6 * s);

          const startY = f.y;
          for (let c = 0; c < colCount; c++) {
            const cellX = marginX + c * colW;
            pdf.rect(cellX, startY, colW, rowH, 'S');
            f.y = startY + padY + cellSize;
            drawWrappedLines(f, wrappedCells[c] ?? [[]], cellX + padX, cellSize, rowLh, {
              align: block.align[c] ?? null,
              maxW: colW - padX * 2,
            });
          }
          f.y = startY + rowH;
        };

        renderRow(block.headers, true);
        for (const r of block.rows) renderRow(r, false);
        f.y += 10 * s;
        break;
      }

      case 'image': {
        const img = images.get(block.url);
        if (img) {
          const caption = block.alt ? 18 * s : 8 * s;
          const size = fitMedia(img.width * 0.72, img.height * 0.72, contentW, mediaRoom(28 * s));
          ensureSpace(f, size.height + caption);
          pdf.addImage(img.dataUrl, img.pdfFormat, marginX + (f.mode === 'flag' ? (contentW - size.width) / 2 : 0), f.y, size.width, size.height);
          f.y += size.height + 6 * s;
          if (block.alt) {
            pdf.setFont('helvetica', 'italic');
            pdf.setFontSize(9 * s);
            pdf.setTextColor(104, 102, 116);
            pdf.text(pdfSafeText(block.alt), marginX, f.y + 6 * s);
            f.y += 16 * s;
          }
        } else {
          const label = pdfSafeText(block.alt ? `[${t('export.docAttachment')}: ${block.alt}]` : `[${t('export.docAttachment')}: ${block.url}]`);
          ensureSpace(f, 16 * s);
          pdf.setFont('helvetica', 'italic');
          pdf.setFontSize(9.5 * s);
          pdf.setTextColor(104, 102, 116);
          pdf.text(label, marginX, f.y);
          f.y += 16 * s;
        }
        break;
      }

      case 'math': {
        const img = pdfMath.get(mathKey(block.tex, true));
        if (img) {
          const m = mathSize(img, bodySize);
          const k = Math.min(1, contentW / m.w);
          const w = m.w * k;
          const h = m.h * k;
          ensureSpace(f, h + 10 * s);
          pdf.addImage(img.dataUrl, 'PNG', marginX + (contentW - w) / 2, f.y - bodySize * 0.8, w, h);
          f.y += h + 6 * s;
        } else {
          const lines = wrapPdfSegs(pdf, [{ text: pdfSafeText(block.tex), font: 'courier', style: 'normal', color: [28, 27, 34] }], bodySize, contentW);
          drawWrappedLines(f, lines, marginX, bodySize, bodySize * 1.4);
          f.y += 4 * s;
        }
        break;
      }

      case 'hr':
        ensureSpace(f, 16 * s);
        pdf.setDrawColor(216, 213, 206);
        pdf.setLineWidth(0.8 * s);
        pdf.line(marginX, f.y + 4 * s, marginX + contentW, f.y + 4 * s);
        f.y += 14 * s;
        break;

      case 'toc': {
        ensureSpace(f, 34 * s);
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(bodySize);
        pdf.setTextColor(f.heading[0], f.heading[1], f.heading[2]);
        pdf.text(pdfSafeText(t('export.docTocTitle')), marginX, f.y);
        f.y += 16 * s;
        if (!block.items.length) {
          ensureSpace(f, 15 * s);
          pdf.setFont('helvetica', 'italic');
          pdf.setFontSize(9.5 * s);
          pdf.setTextColor(104, 102, 116);
          pdf.text(pdfSafeText(t('export.docTocEmpty')), marginX, f.y);
          f.y += 16 * s;
        } else {
          for (const item of block.items) {
            const indent = marginX + Math.min(4, Math.max(0, item.level - 1)) * 12 * s;
            const segs: PdfSeg[] = [
              {
                text: pdfSafeText(item.text),
                font: 'helvetica',
                style: item.level === 1 ? 'bold' : 'normal',
                color: item.level <= 2 ? [28, 27, 34] : [85, 84, 98],
              },
            ];
            const lines = wrapPdfSegs(pdf, segs, 10 * s, marginX + contentW - indent);
            drawWrappedLines(f, lines, indent, 10 * s, 14 * s);
          }
          f.y += 6 * s;
        }
        break;
      }

      case 'footnote': {
        const segs: PdfSeg[] = [
          { text: `[${pdfSafeText(block.id)}] `, font: 'helvetica', style: 'bold', color: f.heading },
          ...inlinesToPdfSegs(block.inlines, 'normal', [104, 102, 116]),
        ];
        const lines = wrapPdfSegs(pdf, segs, 9 * s, contentW);
        drawWrappedLines(f, lines, marginX, 9 * s, 13 * s);
        f.y += 2 * s;
        break;
      }
    }
  }
}

/** Exports a note directly as a clean downloadable PDF without frontmatter */
export async function exportNoteAsPdf(title: string, content: string, variables?: VariableScope): Promise<void> {
  const parsed = parseMarkdownForExport(title, content, variables);
  const media = await preloadMedia(parsed.blocks);
  pdfMath = await rasterizeMath(collectMath(parsed.blocks));

  const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const marginX = 50;
  const marginTop = 52;
  const f: PdfFrame = {
    pdf,
    media,
    x: marginX,
    width: pageW - marginX * 2,
    top: marginTop,
    limit: pageH - 52,
    s: 1,
    mode: 'page',
    accent: [109, 93, 252],
    heading: [28, 27, 34],
    grow: 1,
    y: marginTop,
    overflow: false,
  };

  if (!parsed.hasLeadingH1 && title.trim()) {
    const titleSegs: PdfSeg[] = [{ text: pdfSafeText(title.trim()), font: 'helvetica', style: 'bold', color: [28, 27, 34] }];
    drawWrappedLines(f, wrapPdfSegs(pdf, titleSegs, 22, f.width), marginX, 22, 28);
    pdf.setDrawColor(226, 223, 217);
    pdf.setLineWidth(1);
    pdf.line(marginX, f.y - 4, marginX + f.width, f.y - 4);
    f.y += 12;
  }

  drawPdfBlocks(f, parsed.blocks);

  // Page footer on every page
  const totalPages = pdf.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    pdf.setPage(p);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8.5);
    pdf.setTextColor(150, 148, 158);
    const label = pdfSafeText(`${title || t('export.fallbackName')} - ${t('export.docPages', { current: p, total: totalPages })}`);
    pdf.text(label, pageW - marginX - pdf.getTextWidth(label), pageH - 24);
  }

  pdf.save(safeExportFilename(title, 'pdf', t('export.fallbackName')));
}

// ------------------------------------------------------------------ Presentation PDF (#87)

/** Slide height in pt; the width follows the note's format (16:9: 960 × 540, like a widescreen slide deck) */
const SLIDE_H = 540;
/** Text size factor of a slide against the A4 document: body text 24pt, `#` 48pt */
const SLIDE_SCALE = 2.3;
/** Smallest factor a full slide shrinks to before it continues on a second page */
const SLIDE_MIN_SCALE = 1;

/**
 * Exports a note as slides: one landscape (or square/portrait) page per slide in the format chosen on the note,
 * large text that shrinks only as far as a full slide needs, title slides centered, speaker notes left out.
 */
export async function exportNoteAsSlides(title: string, content: string, variables?: VariableScope): Promise<void> {
  const format = slideFormatOf(content);
  const slideW = Math.round(SLIDE_H * slideRatio(format));
  const slides = splitSlides(content, title).map((slide) => ({
    blocks: parseMarkdownForExport('', slide.markdown, variables).blocks,
    title: isTitleSlide(slide.markdown),
  }));
  const media = await preloadMedia(slides.flatMap((sl) => sl.blocks));
  pdfMath = await rasterizeMath(collectMath(slides.flatMap((sl) => sl.blocks)));

  const pdf = new jsPDF({ orientation: slideW >= SLIDE_H ? 'landscape' : 'portrait', unit: 'pt', format: [slideW, SLIDE_H] });
  const marginX = Math.round(Math.min(slideW, SLIDE_H) * 0.09);
  const marginY = Math.round(SLIDE_H * 0.08);
  const footer = 22;
  const frame = (s: number): PdfFrame => ({
    pdf,
    media,
    x: marginX,
    width: slideW - marginX * 2,
    top: marginY,
    limit: SLIDE_H - marginY - footer,
    s,
    mode: 'flag',
    // Material primary (#0B57D0) for headings, bullets and quote bars
    accent: [11, 87, 208],
    heading: [11, 87, 208],
    grow: 2.5,
    // `y` is a baseline: the first line of body text sits just under the top margin
    y: marginY + 10.5 * s * 0.8,
    overflow: false,
  });
  // A narrow (portrait) slide gets smaller text so lines do not break after every word
  const base = SLIDE_SCALE * Math.min(1, slideW / SLIDE_H);

  slides.forEach((slide, i) => {
    if (i > 0) pdf.addPage([slideW, SLIDE_H], slideW >= SLIDE_H ? 'landscape' : 'portrait');
    const page = pdf.getNumberOfPages();
    // Largest size at which the slide fits: draw, and on overflow wipe the page and draw again smaller
    let s = base;
    let f = frame(s);
    for (;;) {
      f = { ...frame(s), center: slide.title };
      drawPdfBlocks(f, slide.blocks);
      if (!f.overflow || s <= SLIDE_MIN_SCALE) break;
      pdf.deletePage(page);
      pdf.insertPage(page);
      s = Math.max(SLIDE_MIN_SCALE, s * 0.94);
    }
    if (f.overflow) {
      // Still too much at the smallest size: draw it once more letting it continue on further pages
      pdf.deletePage(page);
      pdf.insertPage(page);
      f = { ...frame(s), mode: 'page' };
      drawPdfBlocks(f, slide.blocks);
    } else if (slide.title) {
      // Cover and section slides sit in the middle
      const start = frame(s).y;
      const shift = Math.max(0, (f.limit - f.y) / 2);
      if (shift > 1) {
        pdf.deletePage(page);
        pdf.insertPage(page);
        f = { ...frame(s), center: true, y: start + shift };
        drawPdfBlocks(f, slide.blocks);
      }
    }
  });

  // Slide numbers bottom right
  const total = pdf.getNumberOfPages();
  for (let p = 1; p <= total; p++) {
    pdf.setPage(p);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(10);
    pdf.setTextColor(150, 148, 158);
    const label = `${p} / ${total}`;
    pdf.text(label, slideW - marginX - pdf.getTextWidth(label), SLIDE_H - marginY / 2 - 4);
  }

  pdf.save(safeExportFilename(title, 'pdf', t('export.fallbackName')));
}
