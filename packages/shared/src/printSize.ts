/**
 * Sizes of images and diagrams on paper (PDF, Word, browser print), see `client/lib/noteExport.ts`. Natural sizes are
 * CSS pixels; the page and the result share one unit, `unit` says how many of it one pixel is (0.75 for points).
 */

export interface Size {
  width: number;
  height: number;
}

/** CSS pixels → points (96 and 72 per inch) */
export const PX_TO_PT = 0.75;
/** Share of the page height an image may take: a portrait photo leaves room for text */
const IMAGE_HEIGHT = 0.55;
/** Share of the page height a diagram may take */
const DIAGRAM_HEIGHT = 0.75;
/** Small diagrams grow up to this factor, but not beyond this share of the page width */
const DIAGRAM_GROW = 1.25;
const DIAGRAM_WIDTH = 0.6;

/** Scales a size by `grow` at most so that it fits the box; the aspect ratio stays */
export function fitInto(size: Size, box: Size, grow = 1): Size {
  const w = Math.max(1, size.width);
  const h = Math.max(1, size.height);
  const ratio = Math.min(grow, box.width / w, box.height / h);
  return { width: Math.max(1, w * ratio), height: Math.max(1, h * ratio) };
}

/** An image on a page: its own size, never enlarged, at most the page width and a part of its height */
export function fitPrintImage(natural: Size, page: Size, unit = 1): Size {
  return fitInto({ width: natural.width * unit, height: natural.height * unit }, { width: page.width, height: page.height * IMAGE_HEIGHT });
}

/** A diagram on a page: a little larger than on screen when it is small, at most the page width and most of its height */
export function fitPrintDiagram(natural: Size, page: Size, unit = 1): Size {
  const width = Math.max(1, natural.width * unit);
  const grow = Math.max(1, Math.min(DIAGRAM_GROW, (page.width * DIAGRAM_WIDTH) / width));
  return fitInto({ width, height: natural.height * unit }, { width: page.width, height: page.height * DIAGRAM_HEIGHT }, grow);
}

const pixels = (v: string | null | undefined): number => {
  const text = (v ?? '').trim().replace(/px$/, '');
  const n = text ? Number(text) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Size of an SVG in CSS pixels. Mermaid writes `width="100%"` and no height, so an `<img>` of it gets the browser's
 * 300 × 150 default; the `viewBox` has the real size. null: the SVG names neither.
 */
export function svgNaturalSize(attrs: { width?: string | null; height?: string | null; viewBox?: string | null }): Size | null {
  const box = (attrs.viewBox ?? '').trim().split(/[\s,]+/).map(Number);
  const view = box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0 ? { width: box[2], height: box[3] } : null;
  const w = pixels(attrs.width);
  const h = pixels(attrs.height);
  if (w && h) return { width: w, height: h };
  if (!view) return null;
  if (w) return { width: w, height: (w * view.height) / view.width };
  if (h) return { width: (h * view.width) / view.height, height: h };
  return view;
}

/**
 * EXIF orientation (1–8) of a JPEG, 1 without one. Browsers turn phone photos by it and report the turned size, but PDF
 * viewers draw the stored pixels.
 */
export function jpegOrientation(bytes: Uint8Array): number {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = v.byteLength;
  if (len < 4 || v.getUint16(0) !== 0xffd8) return 1;
  let p = 2;
  while (p + 4 <= len) {
    const marker = v.getUint16(p);
    // 0xffda: the image data starts, no metadata after it
    if (marker >> 8 !== 0xff || marker === 0xffda) return 1;
    // "Exif\0\0", then a TIFF header
    if (marker === 0xffe1 && p + 18 <= len && v.getUint32(p + 4) === 0x45786966) {
      const tiff = p + 10;
      const little = v.getUint16(tiff) === 0x4949;
      const ifd = tiff + v.getUint32(tiff + 4, little);
      if (ifd + 2 > len) return 1;
      const count = v.getUint16(ifd, little);
      for (let i = 0; i < count; i++) {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > len) return 1;
        if (v.getUint16(entry, little) === 0x0112) {
          const o = v.getUint16(entry + 8, little);
          return o >= 1 && o <= 8 ? o : 1;
        }
      }
    }
    p += 2 + Math.max(2, v.getUint16(p + 2));
  }
  return 1;
}
