import { describe, expect, it } from 'vitest';
import { noFocusZoomContent } from '../src/lib/viewport';

// iOS: maximum-scale=1 keeps fields with small text from zooming the page in on focus

describe('viewport without focus zoom', () => {
  it('adds maximum-scale once and keeps the rest', () => {
    const base = 'width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content';
    expect(noFocusZoomContent(base)).toBe(`${base}, maximum-scale=1`);
    expect(noFocusZoomContent(noFocusZoomContent(base))).toBe(`${base}, maximum-scale=1`);
    expect(noFocusZoomContent('width=device-width,maximum-scale=5')).toBe('width=device-width, maximum-scale=1');
  });
});
