import { describe, expect, it } from 'vitest';
import { extractWebClip, parseHtml, webClipTitle, webClipToMarkdown } from '../src/index';

const PAGE = `<!doctype html>
<html><head>
  <title>Fallback title | Example</title>
  <meta property="og:title" content="How to grow tomatoes &amp; peppers">
  <meta name="author" content="Jane Doe">
  <meta property="article:published_time" content="2026-03-14T08:00:00Z">
  <meta property="og:site_name" content="Garden Blog">
  <meta name="description" content="A short guide.">
  <script>var x = "<p>not content</p>";</script>
  <style>p { color: red }</style>
</head><body>
  <header><nav><a href="/">Home</a> <a href="/about">About</a></nav></header>
  <div class="layout">
    <aside class="sidebar"><p>Sidebar text that is long enough to be a paragraph but should never show up anywhere.</p></aside>
    <article>
      <h1>How to grow tomatoes &amp; peppers</h1>
      <p>Tomatoes need <strong>sun</strong>, <em>water</em> and a <a href="/soil">good soil</a>. This guide covers the basics, step by step.</p>
      <h2>Steps</h2>
      <ol><li>Sow in March<li>Plant out in May<ul><li>after the frost</ul></li></ol>
      <figure><img data-src="/img/tomato.jpg" src="data:image/gif;base64,R0lG" alt="A [ripe] tomato"><figcaption>Ripe tomato</figcaption></figure>
      <blockquote><p>Patience is the best fertilizer.</p></blockquote>
      <pre><code class="language-sh">water --daily
echo "&lt;done&gt;"</code></pre>
      <p>Use a_b and *stars* literally. Line<br>break.</p>
      <table><tr><th>Plant</th><th>Month</th></tr><tr><td>Tomato</td><td>May</td></tr></table>
      <p><a href="javascript:alert(1)">bad link</a></p>
      <div class="share-buttons"><p>Share this on all the social networks right now, please, thank you!</p></div>
    </article>
    <section class="comments"><p>First comment, which is long enough to look like a paragraph of content.</p></section>
  </div>
  <footer><p>© 2026 Garden Blog. All rights reserved. Imprint and privacy policy.</p></footer>
</body></html>`;

describe('web clipper', () => {
  const clip = extractWebClip(PAGE, 'https://garden.example/blog/tomatoes');

  it('reads the metadata', () => {
    expect(clip.title).toBe('How to grow tomatoes & peppers');
    expect(clip.author).toBe('Jane Doe');
    expect(clip.published).toBe('2026-03-14');
    expect(clip.siteName).toBe('Garden Blog');
    expect(webClipTitle(clip)).toBe('How to grow tomatoes & peppers');
  });

  it('turns the article into Markdown without navigation, sidebars, comments or scripts', () => {
    expect(clip.markdown).toBe(
      [
        'Tomatoes need **sun**, *water* and a [good soil](https://garden.example/soil). This guide covers the basics, step by step.',
        '## Steps',
        '1. Sow in March\n2. Plant out in May\n   - after the frost',
        '![A ripe tomato](https://garden.example/img/tomato.jpg)\n\n*Ripe tomato*',
        '> Patience is the best fertilizer.',
        '```sh\nwater --daily\necho "<done>"\n```',
        'Use a\\_b and \\*stars\\* literally. Line  \nbreak.',
        '| Plant | Month |\n| --- | --- |\n| Tomato | May |',
        'bad link',
      ].join('\n\n')
    );
    expect(clip.images).toEqual(['https://garden.example/img/tomato.jpg']);
    for (const noise of ['Sidebar', 'comment', 'Share this', 'rights reserved', 'not content', 'About']) expect(clip.markdown).not.toContain(noise);
  });

  it('falls back to the block with the most paragraph text', () => {
    const html = `<body><div id="menu"><a href="/a">A</a><a href="/b">B</a></div><div class="content"><p>${'Lorem ipsum dolor sit amet, consectetur. '.repeat(5)}</p><p>${'Second paragraph with words, and more. '.repeat(4)}</p></div><div><p>Short.</p></div></body>`;
    const c = extractWebClip(html, 'https://x.example/');
    expect(c.markdown.startsWith('Lorem ipsum')).toBe(true);
    expect(c.markdown).toContain('Second paragraph');
    expect(c.markdown).not.toContain('Short.');
    expect(c.title).toBe('x.example');
  });

  it('builds the note with source, author and clip date, or with the selection only', () => {
    const md = webClipToMarkdown(clip, '2026-11-15');
    expect(md.startsWith('---\nsource: https://garden.example/blog/tomatoes\nauthor: Jane Doe\npublished: 2026-03-14\nsite: Garden Blog\nclipped: 2026-11-15\n---\nTomatoes need')).toBe(true);
    expect(webClipToMarkdown(clip, '2026-11-15', 'Just this\n\nand that')).toContain('---\n> Just this\n>\n> and that\n');
  });

  it('parses broken HTML without hanging', () => {
    const start = performance.now();
    parseHtml(`${'<div><p>'.repeat(20_000)}${'<a href="'.repeat(5_000)}${'</span>'.repeat(20_000)}<!--`);
    extractWebClip(`<p>${'x '.repeat(200_000)}</p>${'<li>'.repeat(10_000)}`, 'https://x.example/');
    expect(performance.now() - start).toBeLessThan(3000);
  });
});
