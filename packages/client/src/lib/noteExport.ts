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
} from 'docx';
import { jsPDF } from 'jspdf';
import {
  parseMarkdownForExport,
  safeExportFilename,
  stripFrontmatter,
  type ExportBlock,
  type ExportInline,
  type TableAlign,
} from '@kladde/shared';
import { renderDiagram, type DiagramKind } from '../editor/diagram';

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
  downloadBlob(new Blob([finalText], { type: 'text/markdown;charset=utf-8' }), safeExportFilename(title, 'md'));
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

async function rasterizeToPng(src: string, maxDim = 1600, background?: string): Promise<LoadedImage> {
  const img = await loadHtmlImage(src);
  const w0 = Math.max(1, img.naturalWidth || img.width || 800);
  const h0 = Math.max(1, img.naturalHeight || img.height || 400);
  const scale = Math.min(1, maxDim / Math.max(w0, h0));
  const width = Math.max(1, Math.round(w0 * scale));
  const height = Math.max(1, Math.round(h0 * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Kein Canvas-Kontext');
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
  } else {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(img, 0, 0, width, height);

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
    const rawBg = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim().split(/[\s/]+/).slice(0, 3).map(Number);
    const bg = rawBg.length >= 3 && !rawBg.some(Number.isNaN) ? `rgb(${rawBg[0]}, ${rawBg[1]}, ${rawBg[2]})` : '#ffffff';

    const serialized = new XMLSerializer().serializeToString(svgEl);
    const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`;
    return await rasterizeToPng(svgUrl, 1600, bg);
  } catch {
    return null;
  }
}

async function preloadMedia(blocks: ExportBlock[]) {
  const images = new Map<string, LoadedImage | null>();
  const diagrams = new Map<string, LoadedImage | null>();
  const jobs: Promise<void>[] = [];

  for (const b of blocks) {
    if (b.type === 'image' && !images.has(b.url)) {
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
  return { images, diagrams };
}

function fitSize(w: number, h: number, maxW: number, maxH: number) {
  const ratio = Math.min(1, maxW / w, maxH / h);
  return { width: Math.max(1, Math.round(w * ratio)), height: Math.max(1, Math.round(h * ratio)) };
}

// ------------------------------------------------------------------ Word (.docx) Export

function docxRuns(
  inlines: ExportInline[],
  opts: { muted?: boolean; strike?: boolean; bold?: boolean; color?: string; font?: string; italics?: boolean; size?: number } = {}
): (TextRun | ExternalHyperlink)[] {
  const runs: (TextRun | ExternalHyperlink)[] = [];
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
export async function exportNoteAsWord(title: string, content: string): Promise<void> {
  const parsed = parseMarkdownForExport(title, content);
  const { images, diagrams } = await preloadMedia(parsed.blocks);

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
        for (let idx = 0; idx < codeLines.length; idx++) {
          children.push(
            new Paragraph({
              shading: { type: ShadingType.SOLID, color: 'F3F2EE', fill: 'F3F2EE' },
              indent: { left: 160, right: 160 },
              spacing: { before: idx === 0 ? 80 : 0, after: idx === codeLines.length - 1 ? 160 : 20 },
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
          const label = block.alt ? `Anhang: ${block.alt}` : `Anhang: ${block.url}`;
          children.push(
            new Paragraph({
              spacing: { after: 120 },
              children: [new TextRun({ text: `[${label}]`, italics: true, color: '686674' })],
            })
          );
        }
        break;
      }

      case 'hr':
        children.push(
          new Paragraph({
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D4D1C8', space: 4 } },
            spacing: { before: 100, after: 180 },
            children: [],
          })
        );
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
    title: title || 'Notiz',
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
  downloadBlob(blob, safeExportFilename(title, 'docx'));
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
}

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
    }
  }
  return segs;
}

/** Wraps styled inline segments into lines matching maxWidth without splitting words unnecessarily */
function wrapPdfSegs(pdf: jsPDF, segs: PdfSeg[], fontSize: number, maxWidth: number): PdfSeg[][] {
  pdf.setFontSize(fontSize);
  const measure = (s: PdfSeg) => {
    pdf.setFont(s.font, s.style);
    return pdf.getTextWidth(s.text);
  };

  // Split segments into whitespace-preserving tokens for clean wrapping
  const tokens: PdfSeg[] = [];
  for (const seg of segs) {
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

/** Exports a note directly as a clean downloadable PDF without frontmatter */
export async function exportNoteAsPdf(title: string, content: string): Promise<void> {
  const parsed = parseMarkdownForExport(title, content);
  const { images, diagrams } = await preloadMedia(parsed.blocks);

  const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const marginX = 50;
  const marginTop = 52;
  const marginBottom = 52;
  const contentW = pageW - marginX * 2;
  let y = marginTop;

  const ensureSpace = (needed: number) => {
    if (y + needed > pageH - marginBottom) {
      pdf.addPage();
      y = marginTop;
    }
  };

  const drawWrappedLines = (
    lines: PdfSeg[][],
    x: number,
    fontSize: number,
    lineHeight: number,
    opts?: { quoteBar?: boolean; align?: TableAlign; maxW?: number }
  ) => {
    for (const line of lines) {
      ensureSpace(lineHeight);
      if (opts?.quoteBar) {
        pdf.setFillColor(109, 93, 252);
        pdf.rect(x - 10, y - fontSize * 0.85, 2.5, lineHeight, 'F');
      }
      pdf.setFontSize(fontSize);
      const totalLineW = line.reduce((sum, s) => {
        pdf.setFont(s.font, s.style);
        return sum + pdf.getTextWidth(s.text) + (s.codeBg ? 4 : 0);
      }, 0);
      let cx = x;
      if (opts?.maxW && opts.align === 'center') cx = x + Math.max(0, (opts.maxW - totalLineW) / 2);
      else if (opts?.maxW && opts.align === 'right') cx = x + Math.max(0, opts.maxW - totalLineW);

      for (const s of line) {
        pdf.setFont(s.font, s.style);
        const w = pdf.getTextWidth(s.text);
        if (s.codeBg) {
          pdf.setFillColor(240, 238, 234);
          pdf.roundedRect(cx, y - fontSize * 0.82, w + 4, fontSize * 1.1, 2, 2, 'F');
          cx += 2;
        }
        pdf.setTextColor(s.color[0], s.color[1], s.color[2]);
        pdf.text(s.text, cx, y);
        if (s.url) {
          pdf.setDrawColor(s.color[0], s.color[1], s.color[2]);
          pdf.setLineWidth(0.5);
          pdf.line(cx, y + 1.5, cx + w, y + 1.5);
          pdf.link(cx, y - fontSize, w, fontSize * 1.2, { url: s.url });
        }
        if (s.strike) {
          pdf.setDrawColor(120, 118, 130);
          pdf.setLineWidth(0.7);
          pdf.line(cx, y - fontSize * 0.3, cx + w, y - fontSize * 0.3);
        }
        cx += w + (s.codeBg ? 2 : 0);
      }
      y += lineHeight;
    }
  };

  if (!parsed.hasLeadingH1 && title.trim()) {
    const titleSegs: PdfSeg[] = [{ text: pdfSafeText(title.trim()), font: 'helvetica', style: 'bold', color: [28, 27, 34] }];
    drawWrappedLines(wrapPdfSegs(pdf, titleSegs, 22, contentW), marginX, 22, 28);
    pdf.setDrawColor(226, 223, 217);
    pdf.setLineWidth(1);
    pdf.line(marginX, y - 4, marginX + contentW, y - 4);
    y += 12;
  }

  for (const block of parsed.blocks) {
    switch (block.type) {
      case 'heading': {
        const sizes = [21, 16, 13.5, 11.5, 11, 10.5];
        const sz = sizes[block.level - 1] ?? 10.5;
        const lh = sz * 1.35;
        y += block.level <= 2 ? 8 : 5;
        ensureSpace(lh + 18); // Keep headings with following content
        const lines = wrapPdfSegs(
          pdf,
          inlinesToPdfSegs(block.inlines, 'normal', [28, 27, 34]).map((s) => ({
            ...s,
            style: s.style === 'italic' ? 'bolditalic' : 'bold',
          })),
          sz,
          contentW
        );
        drawWrappedLines(lines, marginX, sz, lh);
        y += 4;
        break;
      }

      case 'paragraph': {
        const lines = wrapPdfSegs(pdf, inlinesToPdfSegs(block.inlines), 10.5, contentW);
        drawWrappedLines(lines, marginX, 10.5, 15.5);
        y += 6;
        break;
      }

      case 'list': {
        let counter = 0;
        for (const item of block.items) {
          if (item.indent === 0) counter++;
          const indentX = marginX + Math.min(4, item.indent) * 16;
          const textX = indentX + 16;
          const availW = pageW - marginX - textX;
          const lines = wrapPdfSegs(
            pdf,
            inlinesToPdfSegs(item.inlines, 'normal', item.checked ? [130, 128, 140] : [28, 27, 34], item.checked === true),
            10.5,
            availW
          );
          ensureSpace(15.5);

          if (item.checked !== undefined) {
            const boxY = y - 8.5;
            if (item.checked) {
              pdf.setFillColor(109, 93, 252);
              pdf.roundedRect(indentX + 2, boxY, 9, 9, 1.5, 1.5, 'F');
              pdf.setDrawColor(255, 255, 255);
              pdf.setLineWidth(1.3);
              pdf.line(indentX + 4, boxY + 4.8, indentX + 6, boxY + 6.8);
              pdf.line(indentX + 6, boxY + 6.8, indentX + 9.2, boxY + 2.5);
            } else {
              pdf.setDrawColor(130, 128, 140);
              pdf.setLineWidth(1);
              pdf.roundedRect(indentX + 2, boxY, 9, 9, 1.5, 1.5, 'S');
            }
          } else if (block.ordered) {
            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(10.5);
            pdf.setTextColor(104, 102, 116);
            pdf.text(`${item.indent === 0 ? counter : '-'}.`, indentX + 1, y);
          } else {
            pdf.setFillColor(109, 93, 252);
            pdf.circle(indentX + 6, y - 3.2, 2.1, 'F');
          }

          drawWrappedLines(lines, textX, 10.5, 15.5);
        }
        y += 6;
        break;
      }

      case 'blockquote': {
        for (const qLine of block.lines) {
          const lines = wrapPdfSegs(pdf, inlinesToPdfSegs(qLine, 'italic', [96, 94, 108]), 10.5, contentW - 18);
          drawWrappedLines(lines, marginX + 14, 10.5, 15.5, { quoteBar: true });
        }
        y += 6;
        break;
      }

      case 'code': {
        if (block.lang === 'mermaid' || block.lang === 'mindmap') {
          const img = diagrams.get(`${block.lang}\n${block.code}`);
          if (img) {
            const size = fitSize(img.width * 0.72, img.height * 0.72, contentW, pageH - marginTop - marginBottom - 20);
            ensureSpace(size.height + 10);
            pdf.addImage(img.dataUrl, img.pdfFormat, marginX, y, size.width, size.height);
            y += size.height + 10;
            break;
          }
        }
        pdf.setFont('courier', 'normal');
        pdf.setFontSize(9);
        const codeLines: string[] = [];
        for (const rawLine of block.code.split('\n')) {
          const wrapped = pdf.splitTextToSize(pdfSafeText(rawLine) || ' ', contentW - 18) as string[];
          codeLines.push(...wrapped);
        }
        const lh = 13;
        let idx = 0;
        while (idx < codeLines.length) {
          const avail = Math.max(1, Math.floor((pageH - marginBottom - y - 12) / lh));
          if (avail < 2 && y > marginTop) {
            pdf.addPage();
            y = marginTop;
            continue;
          }
          const chunk = codeLines.slice(idx, idx + Math.max(1, Math.floor((pageH - marginBottom - y - 12) / lh)));
          const boxH = chunk.length * lh + 10;
          pdf.setFillColor(242, 240, 236);
          pdf.roundedRect(marginX, y, contentW, boxH, 4, 4, 'F');
          pdf.setTextColor(40, 39, 48);
          pdf.setFont('courier', 'normal');
          pdf.setFontSize(9);
          let ty = y + 13;
          for (const cl of chunk) {
            pdf.text(cl, marginX + 9, ty);
            ty += lh;
          }
          y += boxH + 4;
          idx += chunk.length;
        }
        y += 4;
        break;
      }

      case 'table': {
        const colCount = Math.max(1, block.headers.length);
        const colW = contentW / colCount;
        const padX = 6;
        const padY = 5;
        const rowLh = 13;

        const renderRow = (cells: ExportInline[][], isHeader: boolean) => {
          const wrappedCells = cells.map((cell) => {
            const segs = inlinesToPdfSegs(cell).map((s) => (isHeader ? { ...s, style: 'bold' as const } : s));
            return wrapPdfSegs(pdf, segs, 9.5, colW - padX * 2);
          });
          const maxLines = Math.max(1, ...wrappedCells.map((l) => l.length));
          const rowH = maxLines * rowLh + padY * 2;
          ensureSpace(rowH);

          if (isHeader) {
            pdf.setFillColor(238, 236, 230);
            pdf.rect(marginX, y, contentW, rowH, 'F');
          }
          pdf.setDrawColor(216, 213, 206);
          pdf.setLineWidth(0.6);

          const startY = y;
          for (let c = 0; c < colCount; c++) {
            const cellX = marginX + c * colW;
            pdf.rect(cellX, startY, colW, rowH, 'S');
            y = startY + padY + 9.5;
            drawWrappedLines(wrappedCells[c] ?? [[]], cellX + padX, 9.5, rowLh, {
              align: block.align[c] ?? null,
              maxW: colW - padX * 2,
            });
          }
          y = startY + rowH;
        };

        renderRow(block.headers, true);
        for (const r of block.rows) renderRow(r, false);
        y += 10;
        break;
      }

      case 'image': {
        const img = images.get(block.url);
        if (img) {
          const size = fitSize(img.width * 0.72, img.height * 0.72, contentW, pageH - marginTop - marginBottom - 28);
          ensureSpace(size.height + (block.alt ? 18 : 8));
          pdf.addImage(img.dataUrl, img.pdfFormat, marginX, y, size.width, size.height);
          y += size.height + 6;
          if (block.alt) {
            pdf.setFont('helvetica', 'italic');
            pdf.setFontSize(9);
            pdf.setTextColor(104, 102, 116);
            pdf.text(pdfSafeText(block.alt), marginX, y + 6);
            y += 16;
          }
        } else {
          const label = pdfSafeText(block.alt ? `[Anhang: ${block.alt}]` : `[Anhang: ${block.url}]`);
          ensureSpace(16);
          pdf.setFont('helvetica', 'italic');
          pdf.setFontSize(9.5);
          pdf.setTextColor(104, 102, 116);
          pdf.text(label, marginX, y);
          y += 16;
        }
        break;
      }

      case 'hr':
        ensureSpace(16);
        pdf.setDrawColor(216, 213, 206);
        pdf.setLineWidth(0.8);
        pdf.line(marginX, y + 4, marginX + contentW, y + 4);
        y += 14;
        break;

      case 'footnote': {
        const segs: PdfSeg[] = [
          { text: `[${pdfSafeText(block.id)}] `, font: 'helvetica', style: 'bold', color: [79, 70, 229] },
          ...inlinesToPdfSegs(block.inlines, 'normal', [104, 102, 116]),
        ];
        const lines = wrapPdfSegs(pdf, segs, 9, contentW);
        drawWrappedLines(lines, marginX, 9, 13);
        y += 2;
        break;
      }
    }
  }

  // Page footer on every page
  const totalPages = pdf.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    pdf.setPage(p);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8.5);
    pdf.setTextColor(150, 148, 158);
    const label = pdfSafeText(`${title || 'Notiz'} - Seite ${p} / ${totalPages}`);
    pdf.text(label, pageW - marginX - pdf.getTextWidth(label), pageH - 24);
  }

  pdf.save(safeExportFilename(title, 'pdf'));
}
