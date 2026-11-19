import { describe, expect, it } from 'vitest';
import { isPresentationNote, isTitleSlide, parseSlideFormat, slideFormatOf, slideRatio, splitSlides } from '../src/index.js';

describe('slide format', () => {
  it('defaults to 16:9 and reads the frontmatter key presentation', () => {
    expect(slideFormatOf('# Talk')).toBe('16:9');
    expect(slideFormatOf('---\npresentation: 4:3\n---\n# Talk')).toBe('4:3');
    expect(slideFormatOf('---\npresentation: "16/10"\n---\n')).toBe('16:10');
    expect(slideFormatOf('---\npresentation: 7:3\n---\n')).toBe('16:9');
    expect(parseSlideFormat('9 x 16')).toBe('9:16');
    expect(parseSlideFormat('wide')).toBeNull();
    expect(slideRatio('4:3')).toBeCloseTo(4 / 3);
  });

  it('knows presentation notes by the frontmatter key', () => {
    expect(isPresentationNote('---\npresentation: 16:9\n---\nx')).toBe(true);
    expect(isPresentationNote('---\ntags: a\n---\nx')).toBe(false);
  });
});

describe('splitSlides', () => {
  it('starts a new slide at every --- after an empty line', () => {
    const slides = splitSlides('---\npresentation: 4:3\n---\n# Title\n\n---\n\n## Two\n- a\n\n---\n\nThree');
    expect(slides.map((s) => s.markdown)).toEqual(['# Title', '## Two\n- a', 'Three']);
  });

  it('keeps setext underlines and --- inside code', () => {
    const slides = splitSlides('Heading\n---\ntext\n\n```\n---\n```\n\n***\n\nNext');
    expect(slides).toHaveLength(2);
    expect(slides[0].markdown).toContain('Heading\n---');
    expect(slides[0].markdown).toContain('```\n---\n```');
    expect(slides[1].markdown).toBe('Next');
  });

  it('splits at # and ## headings when there are no breaks', () => {
    const slides = splitSlides('Intro\n# A\ntext\n## B\n### B.1\nmore\n## C');
    expect(slides.map((s) => s.markdown)).toEqual(['Intro', '# A\ntext', '## B\n### B.1\nmore', '## C']);
  });

  it('separates speaker notes after Note:', () => {
    const [slide] = splitSlides('## Point\n- one\n\nNote: say hello\nand smile');
    expect(slide).toEqual({ markdown: '## Point\n- one', notes: 'say hello\nand smile' });
  });

  it('puts the title on a first slide without a heading and handles empty notes', () => {
    expect(splitSlides('Just text', 'My talk')[0].markdown).toBe('# My talk\n\nJust text');
    expect(splitSlides('', 'Empty')).toEqual([{ markdown: '# Empty', notes: '' }]);
    expect(splitSlides('# Own', 'Other')[0].markdown).toBe('# Own');
  });
});

describe('isTitleSlide', () => {
  it('centers cover and section slides only', () => {
    expect(isTitleSlide('# Talk\n\nAnna, 2026')).toBe(true);
    expect(isTitleSlide('## Section')).toBe(true);
    expect(isTitleSlide('## Points\n- a\n- b')).toBe(false);
    expect(isTitleSlide('just text')).toBe(false);
  });
});
