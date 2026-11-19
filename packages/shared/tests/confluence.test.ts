import { describe, expect, it } from 'vitest';
import { cdata, confluenceLabel, markdownToConfluence, parseConfluenceLink, runQuery, trimChar, xmlEscape } from '../src';

describe('markdownToConfluence (#48)', () => {
  it('converts headings, paragraphs, inline formatting and links, and drops the frontmatter and a repeated H1', () => {
    const page = markdownToConfluence(
      'Projekte/Umzug.md',
      '---\ntags: [projekt, Haus/Garten]\nstatus: aktiv\n---\n# Umzug\n\nText mit **fett**, *kursiv*, ~~weg~~ und `code` & <tag>.\n\n## Links\n\n[Kladde](https://example.org/a?b=1&c=2) und [böse](javascript:alert(1))\n'
    );
    expect(page.title).toBe('Umzug');
    expect(page.body).not.toContain('<h1>');
    expect(page.body).not.toContain('status: aktiv');
    expect(page.body).toContain('<p>Text mit <strong>fett</strong>, <em>kursiv</em>, <s>weg</s> und <code>code</code> &amp; &lt;tag&gt;.</p>');
    expect(page.body).toContain('<h2>Links</h2>');
    expect(page.body).toContain('<a href="https://example.org/a?b=1&amp;c=2">Kladde</a>');
    expect(page.body).not.toContain('javascript:');
    expect(page.labels).toEqual(['projekt', 'haus-garten']);
  });

  it('turns tasks into a Confluence task list with their done state, and nests lists', () => {
    const { body } = markdownToConfluence('A.md', '- [ ] offen\n- [x] erledigt\n\n- eins\n  - unter\n- zwei\n\n1. erster\n2. zweiter');
    expect(body).toContain('<ac:task-list><ac:task><ac:task-status>incomplete</ac:task-status><ac:task-body>offen</ac:task-body></ac:task><ac:task><ac:task-status>complete</ac:task-status><ac:task-body>erledigt</ac:task-body></ac:task></ac:task-list>');
    expect(body).toContain('<ul><li>eins<ul><li>unter</li></ul></li><li>zwei</li></ul>');
    expect(body).toContain('<ol><li>erster</li><li>zweiter</li></ol>');
  });

  it('turns code blocks into the code macro and keeps CDATA intact', () => {
    const { body } = markdownToConfluence('A.md', '```ts\nconst a = "]]>";\n```\n\n```foo\nx\n```');
    expect(body).toContain('<ac:parameter ac:name="language">typescript</ac:parameter>');
    expect(body).toContain('<![CDATA[const a = "]]]]><![CDATA[>";]]>');
    expect(body).toContain('<ac:parameter ac:name="language">text</ac:parameter>');
  });

  it('turns callouts into info/tip/note/warning panels', () => {
    const { body } = markdownToConfluence('A.md', '> [!warning] Achtung\n> Strom abschalten\n\n> [!danger]\n> Gefahr\n\n> Nur ein Zitat');
    expect(body).toContain('<ac:structured-macro ac:name="note"><ac:parameter ac:name="title">Achtung</ac:parameter><ac:rich-text-body><p>Strom abschalten</p></ac:rich-text-body></ac:structured-macro>');
    expect(body).toContain('<ac:structured-macro ac:name="warning"><ac:rich-text-body><p>Gefahr</p></ac:rich-text-body></ac:structured-macro>');
    expect(body).toContain('<blockquote><p>Nur ein Zitat</p></blockquote>');
  });

  it('turns tables into XHTML tables', () => {
    const { body } = markdownToConfluence('A.md', '| A | B |\n| --- | --: |\n| 1 | **2** |');
    expect(body).toContain('<table><tbody><tr><th>A</th><th>B</th></tr><tr><td>1</td><td><strong>2</strong></td></tr></tbody></table>');
  });

  it('uploads attachments: images, PDFs and file links', () => {
    const files: Record<string, { fileId: string; filename: string; mime: string }> = {
      '/api/files/AAAAAAAAAAAAAAAAAAAAAA': { fileId: 'AAAAAAAAAAAAAAAAAAAAAA', filename: 'foto.png', mime: 'image/png' },
      '/api/files/BBBBBBBBBBBBBBBBBBBBBB': { fileId: 'BBBBBBBBBBBBBBBBBBBBBB', filename: 'vertrag.pdf', mime: 'application/pdf' },
    };
    const page = markdownToConfluence('A.md', '![Foto](/api/files/AAAAAAAAAAAAAAAAAAAAAA)\n\n![](/api/files/BBBBBBBBBBBBBBBBBBBBBB)\n\nSiehe [Vertrag](/api/files/BBBBBBBBBBBBBBBBBBBBBB) und ![x](https://example.org/x.png)', {
      attachment: (url) => files[url] ?? null,
    });
    expect(page.body).toContain('<ac:image ac:alt="Foto"><ri:attachment ri:filename="foto.png" /></ac:image>');
    expect(page.body).toContain('<ac:structured-macro ac:name="view-file"><ac:parameter ac:name="name"><ri:attachment ri:filename="vertrag.pdf" />');
    expect(page.body).toContain('<ac:link><ri:attachment ri:filename="vertrag.pdf" /><ac:plain-text-link-body><![CDATA[Vertrag]]></ac:plain-text-link-body></ac:link>');
    expect(page.attachments.map((a) => a.filename).sort()).toEqual(['foto.png', 'vertrag.pdf']);
  });

  it('links [[notes]] that are synced too, and leaves others as plain text', () => {
    const { body } = markdownToConfluence('A.md', 'Siehe [[Umzug]] und [[Geheim|das hier]].\n\n![[Umzug]]\n\n![[Geheim]]', {
      spaceKey: 'DOC',
      linkTitle: (t) => (t === 'Umzug' ? 'Umzug' : null),
    });
    expect(body).toContain('<ac:link><ri:page ri:content-title="Umzug" ri:space-key="DOC" /><ac:plain-text-link-body><![CDATA[Umzug]]></ac:plain-text-link-body></ac:link>');
    expect(body).toContain('und das hier.');
    expect(body).toContain('Eingebettete Kladde-Notiz „Geheim“');
    expect(body).not.toContain('KLADDEEMBED');
  });

  it('renders queries as their current result and Kladde-only blocks with a hint', () => {
    const notes = [
      { id: 'n1', path: 'Rezepte/Suppe.md', content: '#rezept', createdAt: 1, updatedAt: 1 },
      { id: 'n2', path: 'Rezepte/Kuchen.md', content: '#rezept', createdAt: 1, updatedAt: 2 },
    ];
    const { body } = markdownToConfluence('A.md', '```query\nLIST FROM "Rezepte" SORT title\n```\n\n```mermaid\ngraph TD; A-->B\n```\n\n```query\nkaputt (\n```', {
      query: (src) => runQuery(src, notes),
    });
    expect(body).toContain('<ul><li>Kuchen</li><li>Suppe</li></ul>');
    expect(body).toContain('Mermaid-Diagramm aus Kladde');
    expect(body).toContain('Kladde-Abfrage – in Confluence nicht verfügbar');
  });

  it('renders query aggregates and groups (#77)', () => {
    const notes = [
      { id: 'n1', path: 'P/A.md', content: '---\nstatus: offen\nh: 2\n---\n', createdAt: 1, updatedAt: 1 },
      { id: 'n2', path: 'P/B.md', content: '---\nstatus: offen\nh: 3\n---\n', createdAt: 1, updatedAt: 2 },
      { id: 'n3', path: 'P/C.md', content: '---\nstatus: fertig\nh: 1\n---\n', createdAt: 1, updatedAt: 3 },
    ];
    const render = (q: string) => markdownToConfluence('X.md', `\`\`\`query\n${q}\n\`\`\``, { query: (src) => runQuery(src, notes) }).body;
    expect(render('TABLE status, COUNT, SUM(h) GROUP BY status')).toContain('<tr><td>fertig</td><td>1</td><td>1</td></tr><tr><td>offen</td><td>2</td><td>5</td></tr><tr><td><strong>Gesamt</strong></td><td><strong>3</strong></td><td><strong>6</strong></td></tr>');
    expect(render('LIST GROUP BY status')).toContain('<h4>fertig (1)</h4><ul><li>C</li></ul><h4>offen (2)</h4>');
    expect(render('TABLE title, SUM(h)')).toContain('<td><strong>Gesamt</strong></td><td><strong>6</strong></td>');
  });

  it('escapes XML and labels', () => {
    expect(xmlEscape('a & "b" <c>')).toBe('a &amp; &quot;b&quot; &lt;c&gt;');
    expect(cdata('x]]>y')).toBe('<![CDATA[x]]]]><![CDATA[>y]]>');
    expect(confluenceLabel('#Bereich/Gesundheit')).toBe('bereich-gesundheit');
  });
});

describe('Confluence helpers on long input', () => {
  it('handle long runs of separators quickly', () => {
    const started = Date.now();
    expect(confluenceLabel(`${'-'.repeat(100_000)}a`)).toBe('a');
    expect(trimChar('//a/b//', '/')).toBe('a/b');
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('parseConfluenceLink', () => {
  it('reads page ids and space keys from Cloud and Data Center addresses', () => {
    expect(parseConfluenceLink('https://firma.atlassian.net/wiki/spaces/DOC/pages/123456/Mein+Titel')).toEqual({ host: 'firma.atlassian.net', spaceKey: 'DOC', pageId: '123456' });
    expect(parseConfluenceLink('https://firma.atlassian.net/wiki/spaces/DOC/pages/edit-v2/77')).toEqual({ host: 'firma.atlassian.net', spaceKey: 'DOC', pageId: '77' });
    expect(parseConfluenceLink('https://firma.atlassian.net/wiki/spaces/~5b12ab/overview')).toEqual({ host: 'firma.atlassian.net', spaceKey: '~5b12ab' });
    expect(parseConfluenceLink('https://wiki.firma.de/pages/viewpage.action?pageId=4711')).toEqual({ host: 'wiki.firma.de', pageId: '4711' });
    expect(parseConfluenceLink('https://wiki.firma.de/confluence/display/TEAM/Release+Plan%20%C3%BCbersicht')).toEqual({ host: 'wiki.firma.de', spaceKey: 'TEAM', title: 'Release Plan übersicht' });
    expect(parseConfluenceLink('https://wiki.firma.de/display/TEAM')).toEqual({ host: 'wiki.firma.de', spaceKey: 'TEAM' });
    expect(parseConfluenceLink('https://wiki.firma.de/spaces/viewspace.action?key=OPS')).toEqual({ host: 'wiki.firma.de', spaceKey: 'OPS' });
    // Short link: page id 123 as little-endian bytes
    expect(parseConfluenceLink('https://wiki.firma.de/x/ew')).toEqual({ host: 'wiki.firma.de', pageId: '123' });
  });

  it('ignores what is no Confluence address', () => {
    expect(parseConfluenceLink('Dokumentation')).toBeNull();
    expect(parseConfluenceLink('javascript:alert(1)')).toBeNull();
    expect(parseConfluenceLink('https://example.org/blog/post')).toBeNull();
  });
});
