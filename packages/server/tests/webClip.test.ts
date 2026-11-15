import { describe, expect, it, vi } from 'vitest';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

vi.mock('../src/RecipeImport', async (orig) => {
  const real = await orig<typeof import('../src/RecipeImport')>();
  return {
    ...real,
    fetchPage: vi.fn(async (raw: string) => {
      real.checkUrl(raw);
      return {
        url: raw,
        html: `<html><head><meta property="og:title" content="Article"></head><body><article><p>${'Some long article text, with words. '.repeat(12)}</p><p><img src="/a (1).png" alt="A"> <img src="https://cdn.example/missing.png"></p></article></body></html>`,
      };
    }),
    fetchImage: vi.fn(async (src: string) => {
      if (src.includes('missing')) throw new real.ImportError('Kein Bild.');
      return { mime: 'image/png', data: PNG };
    }),
  };
});

const { clipPage } = await import('../src/WebClip');

describe('web clipper on the server', () => {
  it('stores reachable images as attachments and keeps the others', async () => {
    const saved: string[] = [];
    const clip = await clipPage('https://blog.example/post', {
      images: true,
      save: (name) => {
        saved.push(name);
        return `/api/files/f${saved.length}`;
      },
    });
    expect(clip.title).toBe('Article');
    expect(saved).toEqual(['a (1).png']);
    expect(clip.savedImages).toBe(1);
    expect(clip.markdown).toContain('![A](/api/files/f1)');
    expect(clip.markdown).toContain('![](https://cdn.example/missing.png)');
  });

  it('leaves images alone without the option and refuses private addresses', async () => {
    const clip = await clipPage('https://blog.example/post', { images: false, save: () => 'never' });
    expect(clip.markdown).toContain('![A](https://blog.example/a%20%281%29.png)');
    await expect(clipPage('http://192.168.1.10/', { images: false, save: () => '' })).rejects.toThrow();
  });
});
