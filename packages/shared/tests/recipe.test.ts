import { describe, expect, it } from 'vitest';
import { extractRecipe, formatDuration, parseIngredient, recipeToMarkdown } from '../src/recipe';

const page = (ld: unknown) => `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body></body></html>`;

describe('extractRecipe', () => {
  it('reads a JSON-LD recipe inside @graph with HowToSections', () => {
    const html = page({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebPage', name: 'Seite' },
        {
          '@type': ['Recipe', 'NewsArticle'],
          name: 'Apfelkuchen &amp; Streusel',
          image: [{ '@type': 'ImageObject', url: 'https://example.com/kuchen.jpg' }],
          author: { '@type': 'Person', name: 'Oma Erna' },
          recipeYield: ['12', '12 Stücke'],
          totalTime: 'PT1H15M',
          recipeIngredient: ['200 g Mehl', '1 Prise Salz', '3 Äpfel'],
          recipeInstructions: [
            { '@type': 'HowToSection', name: 'Teig', itemListElement: [{ '@type': 'HowToStep', text: 'Mehl und Salz <b>mischen</b>.' }] },
            { '@type': 'HowToStep', text: 'Äpfel schälen.' },
          ],
        },
      ],
    });
    const r = extractRecipe(html, 'https://www.example.com/kuchen')!;
    expect(r.title).toBe('Apfelkuchen & Streusel');
    expect(r.image).toBe('https://example.com/kuchen.jpg');
    expect(r.author).toBe('Oma Erna');
    expect(r.yield).toBe('12 Stücke');
    expect(r.totalTime).toBe('1 Std. 15 Min.');
    expect(r.ingredients).toEqual(['200 g Mehl', '1 Prise Salz', '3 Äpfel']);
    expect(r.steps).toEqual(['## Teig', 'Mehl und Salz mischen.', 'Äpfel schälen.']);
  });

  it('splits a single instruction string into steps', () => {
    const r = extractRecipe(page({ '@type': 'Recipe', name: 'X', recipeIngredient: ['Wasser'], recipeInstructions: '1. Kochen. 2. Salzen.\n' }), 'https://a.de')!;
    expect(r.steps).toEqual(['Kochen.', 'Salzen.']);
  });

  it('drops a lone generic section and joins a step ending in a colon', () => {
    const r = extractRecipe(
      page({ '@type': 'Recipe', name: 'X', recipeIngredient: ['Wasser'], recipeInstructions: [{ '@type': 'HowToSection', name: 'Zubereitung', itemListElement: [{ text: 'Hinweis:' }, { text: 'Heiß servieren.' }, { text: 'Fertig.' }] }] }),
      'https://a.de'
    )!;
    expect(r.steps).toEqual(['Hinweis: Heiß servieren.', 'Fertig.']);
  });

  it('finds JSON-LD that Next.js only streams in its hydration data', () => {
    const ld = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Recipe', name: 'Pasta', image: { url: 'https://p.de/a.webp' }, recipeIngredient: ['500 g Nudeln'], recipeInstructions: [{ '@type': 'HowToStep', text: 'Kochen.', name: 'Schritt 1' }] });
    const chunk = `1e:T${ld.length.toString(16)},${ld}\n5:["$","script",null,{"type":"application/ld+json","dangerouslySetInnerHTML":{"__html":"$1e"}}]`;
    const html = `<html><body><script>self.__next_f.push([1,${JSON.stringify(chunk)}])</script></body></html>`;
    const r = extractRecipe(html, 'https://picnic.app/de/rezepte/1')!;
    expect(r.title).toBe('Pasta');
    expect(r.ingredients).toEqual(['500 g Nudeln']);
    expect(r.steps).toEqual(['Kochen.']);
  });

  it('falls back to microdata', () => {
    const html = `<div itemscope itemtype="https://schema.org/Recipe"><h1 itemprop="name">Suppe</h1>
      <li itemprop="recipeIngredient">1 l Brühe</li><li itemprop="recipeIngredient">2 Karotten</li>
      <div itemprop="recipeInstructions"><p>Alles kochen.</p></div></div>`;
    const r = extractRecipe(html, 'https://b.de')!;
    expect(r.title).toBe('Suppe');
    expect(r.ingredients).toEqual(['1 l Brühe', '2 Karotten']);
    expect(r.steps).toEqual(['Alles kochen.']);
  });

  it('returns null without recipe data', () => {
    expect(extractRecipe('<html><title>Blog</title></html>', 'https://c.de')).toBeNull();
  });
});

describe('parseIngredient', () => {
  it.each([
    ['200 g Mehl', { amount: '200', unit: 'g', name: 'Mehl' }],
    ['200g Mehl', { amount: '200', unit: 'g', name: 'Mehl' }],
    ['1 ½ TL Zucker', { amount: '1 ½', unit: 'TL', name: 'Zucker' }],
    ['2-3 Zehen Knoblauch', { amount: '2-3', unit: 'Zehen', name: 'Knoblauch' }],
    ['3 Eier', { amount: '3', unit: '', name: 'Eier' }],
    ['Salz und Pfeffer', { amount: '', unit: '', name: 'Salz und Pfeffer' }],
    ['1/2 cup milk', { amount: '1/2', unit: 'cup', name: 'milk' }],
    ['0.5 TL Muskat', { amount: '0,5', unit: 'TL', name: 'Muskat' }],
    ['1 Stk. Zwiebeln', { amount: '1', unit: 'Stk.', name: 'Zwiebeln' }],
    ['1 Glas Gurken', { amount: '1', unit: 'Glas', name: 'Gurken' }],
    ['1 große Zwiebel', { amount: '1', unit: '', name: 'große Zwiebel' }],
    ['Gemüsebrühe', { amount: '', unit: '', name: 'Gemüsebrühe' }],
    ['1 Prise(n) Salz', { amount: '1', unit: 'Prise(n)', name: 'Salz' }],
    ['1 Ei(er)', { amount: '1', unit: '', name: 'Ei(er)' }],
  ])('%s', (line, expected) => expect(parseIngredient(line)).toEqual(expected));
});

describe('recipeToMarkdown', () => {
  it('writes a table, numbered steps and the source at the bottom', () => {
    const md = recipeToMarkdown({
      title: 'Suppe',
      ingredients: ['## Basis', '1 l Brühe'],
      steps: ['Kochen.', 'Servieren.'],
      sourceUrl: 'https://www.chefkoch.de/rezepte/1',
      yield: '4 Portionen',
    });
    expect(md).toContain('typ: rezept\nquelle: https://www.chefkoch.de/rezepte/1\nportionen: 4 Portionen');
    expect(md).toContain('| Menge | Einheit | Zutat |\n| ---: | --- | --- |\n|  |  | **Basis** |\n| 1 | l | Brühe |');
    expect(md).toContain('## Zubereitung\n\n1. Kochen.\n2. Servieren.');
    expect(md.trimEnd().endsWith('Quelle: [chefkoch.de](https://www.chefkoch.de/rezepte/1)')).toBe(true);
  });

  it('formats durations', () => {
    expect(formatDuration('PT45M')).toBe('45 Min.');
    expect(formatDuration('P0DT2H')).toBe('2 Std.');
    expect(formatDuration('20 Minuten')).toBe('20 Minuten');
  });
});
