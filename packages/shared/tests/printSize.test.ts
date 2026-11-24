import { describe, expect, it } from 'vitest';
import { PX_TO_PT, fitPrintDiagram, fitPrintImage, jpegOrientation, svgNaturalSize } from '../src/printSize.js';

const PAGE = { width: 495, height: 738 };
const ratio = (s: { width: number; height: number }) => s.width / s.height;

describe('fitPrintImage', () => {
  it('never enlarges', () => expect(fitPrintImage({ width: 120, height: 80 }, PAGE, PX_TO_PT)).toEqual({ width: 90, height: 60 }));
  it('caps landscape images at the page width', () => {
    const s = fitPrintImage({ width: 2400, height: 1200 }, PAGE, PX_TO_PT);
    expect(s.width).toBeCloseTo(495);
    expect(ratio(s)).toBeCloseTo(2);
  });
  it('caps portrait images by height, well below the page width', () => {
    const s = fitPrintImage({ width: 3000, height: 4000 }, PAGE, PX_TO_PT);
    expect(s.height).toBeCloseTo(738 * 0.55);
    expect(s.width).toBeLessThan(495 * 0.65);
    expect(ratio(s)).toBeCloseTo(0.75);
  });
});

describe('fitPrintDiagram', () => {
  it('lets a tiny chart grow only a little', () => {
    expect(fitPrintDiagram({ width: 200, height: 50 }, PAGE, PX_TO_PT).width).toBeCloseTo(200 * 0.75 * 1.25);
  });
  it('keeps a chart that is already wider than the share it may grow to', () => {
    expect(fitPrintDiagram({ width: 600, height: 300 }, PAGE, PX_TO_PT).width).toBeCloseTo(450);
  });
  it('caps wide and tall charts', () => {
    expect(fitPrintDiagram({ width: 2400, height: 80 }, PAGE, PX_TO_PT).width).toBeCloseTo(495);
    const tall = fitPrintDiagram({ width: 130, height: 3000 }, PAGE, PX_TO_PT);
    expect(tall.height).toBeCloseTo(738 * 0.75);
    expect(ratio(tall)).toBeCloseTo(130 / 3000);
  });
});

describe('svgNaturalSize', () => {
  it('takes the viewBox of a Mermaid SVG', () => expect(svgNaturalSize({ width: '100%', viewBox: '0 0 412.5 96' })).toEqual({ width: 412.5, height: 96 }));
  it('takes width and height', () => expect(svgNaturalSize({ width: '40', height: '20px', viewBox: '0 0 8 4' })).toEqual({ width: 40, height: 20 }));
  it('completes one side from the viewBox', () => expect(svgNaturalSize({ width: '40', viewBox: '-5 -5 8 4' })).toEqual({ width: 40, height: 20 }));
  it('is null without a size', () => expect(svgNaturalSize({ width: '100%', viewBox: '0 0 0 x' })).toBeNull());
});

describe('jpegOrientation', () => {
  const jpeg = (o: number) =>
    new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 34, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0, 0xff, 0xda]);
  it('reads the tag', () => expect(jpegOrientation(jpeg(6))).toBe(6));
  it('is 1 for nonsense and other files, and reads cut-off ones without failing', () => {
    expect(jpegOrientation(jpeg(9))).toBe(1);
    expect(jpegOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(1);
    for (let n = 0; n < 40; n++) expect(() => jpegOrientation(jpeg(6).slice(0, n))).not.toThrow();
  });
});
