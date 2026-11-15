/**
 * Text extraction for the attachment search (#37). PDFs are read with pdf.js (bundled, no CDN, no
 * worker thread: the worker module runs in-process); scanned pages and images go through OCR when
 * the admin turned it on (see ocr.ts).
 */

/** Reads the text of one image (PNG/JPEG/WebP) */
export type Ocr = (image: Buffer) => Promise<string>;

export interface ExtractedText {
  pages: string[];
  /** At least one page was read by OCR */
  ocrUsed: boolean;
}

export const MAX_PDF_PAGES = 500;
/** OCR is slow: only this many scanned pages per PDF */
export const MAX_OCR_PAGES = 50;
/** Text kept per attachment (characters) */
export const MAX_TEXT_CHARS = 2_000_000;
/** A page with less text than this counts as scanned */
const SCANNED_PAGE_CHARS = 16;

// Minimal shapes of the pdf.js API used here (the bundled typings pull in DOM types)
interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}
interface PdfViewport {
  width: number;
  height: number;
}
interface PdfPage {
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
  getViewport(opts: { scale: number }): PdfViewport;
  render(opts: Record<string, unknown>): { promise: Promise<void> };
  cleanup(): void;
}
interface PdfCanvas {
  toBuffer(mime: string): Buffer;
}
interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  canvasFactory?: { create(w: number, h: number): { canvas: PdfCanvas; context: unknown } };
}
interface PdfJs {
  getDocument(opts: Record<string, unknown>): { promise: Promise<PdfDocument>; destroy(): Promise<void> };
}

let pdfjsPromise: Promise<PdfJs> | null = null;

/** Loads pdf.js once; the worker module is registered on globalThis so pdf.js parses in this thread */
function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= (async () => {
    const worker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
    return (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfJs;
  })();
  return pdfjsPromise;
}

export function cleanText(text: string): string {
  return text
    .replace(/\u0000/g, '')
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Text of every page of a PDF; scanned pages are rendered and read by OCR when `ocr` is given */
export async function extractPdfText(data: Buffer, ocr: Ocr | null = null): Promise<ExtractedText> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(data),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  const pages: string[] = [];
  let ocrUsed = false;
  let ocrPages = 0;
  let total = 0;
  try {
    const count = Math.min(doc.numPages, MAX_PDF_PAGES);
    for (let n = 1; n <= count; n++) {
      const page = await doc.getPage(n);
      try {
        const content = await page.getTextContent();
        let text = cleanText(content.items.map((i) => `${i.str ?? ''}${i.hasEOL ? '\n' : ' '}`).join(''));
        if (text.length < SCANNED_PAGE_CHARS && ocr && ocrPages < MAX_OCR_PAGES) {
          const image = await renderPage(doc, page);
          if (image) {
            ocrPages++;
            const read = cleanText(await ocr(image));
            if (read.length > text.length) {
              text = read;
              ocrUsed = true;
            }
          }
        }
        total += text.length;
        pages.push(total > MAX_TEXT_CHARS ? text.slice(0, Math.max(0, text.length - (total - MAX_TEXT_CHARS))) : text);
        if (total >= MAX_TEXT_CHARS) break;
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await task.destroy().catch(() => undefined);
  }
  return { pages, ocrUsed };
}

/** PNG of a page for OCR; null where pdf.js cannot render (no canvas module on this platform) */
async function renderPage(doc: PdfDocument, page: PdfPage): Promise<Buffer | null> {
  try {
    if (!doc.canvasFactory) return null;
    const viewport = page.getViewport({ scale: 2 });
    // Very large pages would need a lot of memory
    if (viewport.width * viewport.height > 25_000_000) return null;
    const { canvas, context } = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvasContext: context, canvas, viewport }).promise;
    return canvas.toBuffer('image/png');
  } catch {
    return null;
  }
}

/** Text of an image attachment (one page) */
export async function extractImageText(data: Buffer, ocr: Ocr): Promise<ExtractedText> {
  const text = cleanText(await ocr(data)).slice(0, MAX_TEXT_CHARS);
  return { pages: [text], ocrUsed: true };
}
