import { setFrontmatter } from './markdown.js';
import { PARA } from './para.js';

/**
 * Recipe import: reads the structured data most recipe sites publish (schema.org/Recipe as JSON-LD,
 * microdata as a fallback) and turns it into one standard note: ingredients as a table, steps as a
 * numbered list, the source link at the very bottom. Pure string work, so it runs on the server and in tests.
 */

export const RECIPE_FOLDER = `${PARA.resources}/Rezepte`;

export interface Recipe {
  title: string;
  description?: string;
  image?: string;
  author?: string;
  /** Servings as the site says it ("4 Portionen") */
  yield?: string;
  prepTime?: string;
  cookTime?: string;
  totalTime?: string;
  /** Lines; a line starting with "## " is a group heading ("## Für den Teig") */
  ingredients: string[];
  /** Same: plain steps, "## " lines are section headings */
  steps: string[];
  sourceUrl: string;
}

export interface Ingredient {
  amount: string;
  unit: string;
  name: string;
}

// ------------------------------------------------------------------ text helpers

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö',
  Uuml: 'Ü', szlig: 'ß', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', deg: '°', frac12: '½', frac14: '¼',
  frac34: '¾', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', bdquo: '„', ldquo: '“', rdquo: '”',
  lsquo: '‘', rsquo: '’', times: '×',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
    }
    return NAMED_ENTITIES[e] ?? all;
  });
}

/** Strips tags, decodes entities (sites often double-encode) and collapses whitespace */
export function cleanText(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  let s = String(value).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ');
  for (let i = 0; i < 2 && /&[#a-z0-9]+;/i.test(s); i++) s = decodeEntities(s).replace(/<[^>]+>/g, ' ');
  return s.replace(/[ \t ]+/g, ' ').replace(/ ([.,;:!?)])/g, '$1').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
}

const asArray = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

const typesOf = (node: Record<string, unknown>) => asArray(node['@type'] as string | string[]).map((t) => String(t).toLowerCase());

/** "PT1H30M" → "1 Std. 30 Min."; other strings are kept */
export function formatDuration(value: unknown): string | undefined {
  const s = cleanText(value);
  if (!s) return undefined;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:\d+(?:\.\d+)?S)?)?$/i.exec(s);
  if (!m) return s;
  let minutes = Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  minutes = Math.round(minutes);
  if (!minutes) return undefined;
  const h = Math.floor(minutes / 60);
  const min = minutes % 60;
  return [h ? `${h} Std.` : '', min ? `${min} Min.` : ''].filter(Boolean).join(' ');
}

// ------------------------------------------------------------------ JSON-LD

function findRecipeNode(data: unknown, depth = 0): Record<string, unknown> | null {
  if (!data || typeof data !== 'object' || depth > 6) return null;
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findRecipeNode(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const node = data as Record<string, unknown>;
  if (typesOf(node).includes('recipe')) return node;
  for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'item']) {
    const found = findRecipeNode(node[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function parseJsonLd(html: string): Record<string, unknown> | null {
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  for (let m; (m = re.exec(html)); ) {
    const raw = m[1].trim().replace(/^<!\[CDATA\[|\]\]>$/g, '');
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      // Some sites put raw line breaks into strings
      try {
        data = JSON.parse(raw.replace(/[\r\n\t]+/g, ' '));
      } catch {
        continue;
      }
    }
    const found = findRecipeNode(data);
    if (found) return found;
  }
  return null;
}

/** End of the balanced {...} starting at `start` (string-aware), or -1 */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length && i < start + 500_000; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

/**
 * Sites built with Next.js, Nuxt and the like often ship the JSON-LD only inside their hydration data
 * (the <script> tag is added in the browser). Next's App Router streams it as escaped string chunks
 * (self.__next_f.push), so those are decoded first; then the object around "@type":"Recipe" is cut out.
 */
function parseEmbeddedJson(html: string): Record<string, unknown> | null {
  let text = html;
  const flight = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  for (let m; (m = flight.exec(html)); ) {
    try {
      text += JSON.parse(m[1]) as string;
    } catch {
      /* skip a broken chunk */
    }
  }
  const marker = /"@type"\s*:\s*\[?\s*"Recipe"/g;
  for (let m; (m = marker.exec(text)); ) {
    // Walk back to the "{" whose object contains the marker: the recipe itself
    for (let start = text.lastIndexOf('{', m.index), tries = 0; start >= 0 && tries < 200; start = text.lastIndexOf('{', start - 1), tries++) {
      const end = objectEnd(text, start);
      if (end < m.index) continue;
      try {
        const found = findRecipeNode(JSON.parse(text.slice(start, end + 1)));
        if (found) return found;
      } catch {
        /* not JSON (e.g. escaped inside a script string): keep walking */
      }
    }
  }
  return null;
}

function textOf(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return cleanText(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    return cleanText(v.text ?? v.name ?? v.description ?? '');
  }
  return '';
}

/** Instructions come as a string, a list of strings, HowToSteps or HowToSections (with nested steps) */
function instructionLines(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 5) return out;
  if (typeof value === 'string') {
    const text = cleanText(value);
    // A single block of text: one step per line, or per numbered item
    const parts = text.includes('\n') ? text.split('\n') : text.split(/\s+(?=\d{1,2}[.)]\s)/);
    for (const p of parts) {
      const line = p.replace(/^\s*(?:\d{1,2}[.)]|[-•*])\s*/, '').trim();
      if (line) out.push(line);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) instructionLines(item, out, depth + 1);
    return out;
  }
  if (value && typeof value === 'object') {
    const node = value as Record<string, unknown>;
    const types = typesOf(node);
    if (types.includes('howtosection') || (node.itemListElement && !node.text)) {
      const name = cleanText(node.name);
      if (name) out.push(`## ${name}`);
      return instructionLines(node.itemListElement ?? node.steps, out, depth + 1);
    }
    const text = textOf(node);
    if (text) instructionLines(text, out, depth + 1);
  }
  return out;
}

function imageOf(value: unknown): string | undefined {
  for (const item of asArray(value as unknown[])) {
    const url = typeof item === 'string' ? item : item && typeof item === 'object' ? ((item as Record<string, unknown>).url ?? (item as Record<string, unknown>).contentUrl) : undefined;
    if (typeof url === 'string' && /^https?:\/\//.test(url.trim())) return url.trim();
  }
  return undefined;
}

function yieldOf(value: unknown): string | undefined {
  const items = asArray(value as unknown[]).map((v) => cleanText(v)).filter(Boolean);
  if (!items.length) return undefined;
  // ["4", "4 Portionen"] → the longer, more telling one
  const best = items.sort((a, b) => b.length - a.length)[0];
  if (/^\d+$/.test(best)) return best === '1' ? '1 Portion' : `${best} Portionen`;
  return best.replace(/^1 Portionen\b/, '1 Portion');
}

function fromJsonLd(node: Record<string, unknown>, url: string): Recipe {
  const author = asArray(node.author as unknown[]).map(textOf).filter(Boolean).join(', ');
  const ingredients = asArray((node.recipeIngredient ?? node.ingredients) as unknown[])
    .map(textOf)
    .filter(Boolean);
  return {
    title: cleanText(node.name ?? node.headline) || 'Rezept',
    description: cleanText(node.description) || undefined,
    image: imageOf(node.image),
    author: author || undefined,
    yield: yieldOf(node.recipeYield ?? node.yield),
    prepTime: formatDuration(node.prepTime),
    cookTime: formatDuration(node.cookTime),
    totalTime: formatDuration(node.totalTime),
    ingredients,
    steps: instructionLines(node.recipeInstructions),
    sourceUrl: url,
  };
}

// ------------------------------------------------------------------ microdata / meta fallback

function metaContent(html: string, key: string): string | undefined {
  const re = new RegExp(`<meta\\b[^>]*(?:property|name)\\s*=\\s*["']${key}["'][^>]*>`, 'i');
  const tag = re.exec(html)?.[0];
  const content = tag && /content\s*=\s*(["'])([\s\S]*?)\1/i.exec(tag)?.[2];
  return content ? cleanText(content) || undefined : undefined;
}

/** Text of every element with itemprop="<prop>" (content attribute wins, as in the microdata spec) */
function itemprops(html: string, prop: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<([a-z0-9]+)\\b[^>]*itemprop\\s*=\\s*["'][^"']*\\b${prop}\\b[^"']*["'][^>]*>`, 'gi');
  for (let m; (m = re.exec(html)); ) {
    const content = /\bcontent\s*=\s*(["'])([\s\S]*?)\1/i.exec(m[0])?.[2];
    if (content) {
      out.push(cleanText(content));
      continue;
    }
    if (/^(meta|link|img)$/i.test(m[1])) continue;
    const end = html.indexOf(`</${m[1]}`, re.lastIndex);
    if (end < 0) continue;
    out.push(cleanText(html.slice(re.lastIndex, Math.min(end, re.lastIndex + 20_000))));
  }
  return out.filter(Boolean);
}

function fromMicrodata(html: string, url: string): Recipe | null {
  if (!/itemtype\s*=\s*["'][^"']*schema\.org\/Recipe/i.test(html)) return null;
  const ingredients = itemprops(html, 'recipeIngredient');
  if (!ingredients.length) ingredients.push(...itemprops(html, 'ingredients'));
  return {
    title: itemprops(html, 'name')[0] || metaContent(html, 'og:title') || 'Rezept',
    description: itemprops(html, 'description')[0] || metaContent(html, 'og:description'),
    image: metaContent(html, 'og:image'),
    yield: yieldOf(itemprops(html, 'recipeYield')),
    prepTime: formatDuration(itemprops(html, 'prepTime')[0]),
    cookTime: formatDuration(itemprops(html, 'cookTime')[0]),
    totalTime: formatDuration(itemprops(html, 'totalTime')[0]),
    ingredients,
    steps: itemprops(html, 'recipeInstructions').flatMap((s) => instructionLines(s)),
    sourceUrl: url,
  };
}

/** Finds the recipe in a page; null when the page has no recipe data */
export function extractRecipe(html: string, url: string): Recipe | null {
  const node = parseJsonLd(html) ?? parseEmbeddedJson(html);
  let recipe = node ? fromJsonLd(node, url) : null;
  if (!recipe || (!recipe.ingredients.length && !recipe.steps.length)) recipe = fromMicrodata(html, url) ?? recipe;
  if (!recipe || (!recipe.ingredients.length && !recipe.steps.length)) return null;
  recipe.image ??= metaContent(html, 'og:image');
  recipe.steps = tidySteps(recipe.steps);
  return recipe;
}

const GENERIC_SECTION = /^## (zubereitung|anleitung|instructions?|directions?|method|steps?|schritte)$/i;

/** Drops repeats and a lone generic section heading; a step ending in ":" belongs to the next one */
function tidySteps(steps: string[]): string[] {
  let lines = steps.filter((l, i) => l !== steps[i - 1]);
  const headings = lines.filter((l) => l.startsWith('## '));
  if (headings.length === 1 && GENERIC_SECTION.test(headings[0])) lines = lines.filter((l) => l !== headings[0]);
  const out: string[] = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    if (prev && !prev.startsWith('## ') && !line.startsWith('## ') && prev.endsWith(':')) out[out.length - 1] = `${prev} ${line}`;
    else out.push(line);
  }
  return out;
}

// ------------------------------------------------------------------ ingredients

const UNITS = [
  'kg', 'g', 'mg', 'l', 'ml', 'cl', 'dl', 'EL', 'TL', 'Msp', 'Msp.', 'Pck', 'Pck.', 'Pkt', 'Pkt.', 'Packung', 'Packungen', 'Päckchen',
  'Prise', 'Prisen', 'Stück', 'Stk', 'Stk.', 'Dose', 'Dosen', 'Bund', 'Zehe', 'Zehen', 'Becher', 'Tasse', 'Tassen', 'Scheibe',
  'Scheiben', 'Zweig', 'Zweige', 'Handvoll', 'Glas', 'Gläser', 'Schuss', 'Spritzer', 'Würfel', 'Blatt', 'Blätter', 'Tropfen',
  'Stange', 'Stangen', 'Knolle', 'Knollen', 'Kopf', 'Köpfe', 'Liter', 'Gramm', 'Kilogramm', 'Milliliter', 'Esslöffel', 'Teelöffel',
  'cup', 'cups', 'tbsp', 'tbsp.', 'tsp', 'tsp.', 'tablespoon', 'tablespoons', 'teaspoon', 'teaspoons', 'oz', 'lb', 'lbs', 'pinch',
  'clove', 'cloves', 'can', 'cans', 'slice', 'slices', 'bunch', 'piece', 'pieces', 'pound', 'pounds', 'ounce', 'ounces',
];
const UNIT_RE = UNITS.map((u) => u.replace('.', '\\.')).sort((a, b) => b.length - a.length).join('|');
const NUM = String.raw`(?:\d+(?:[.,]\d+)?(?:\s*\/\s*\d+)?|[½⅓⅔¼¾⅕⅛])(?:\s*[½⅓⅔¼¾⅕⅛])?`;
const AMOUNT = String.raw`(?:ca\.\s*|etwa\s*)?${NUM}(?:\s*(?:-|–|bis)\s*${NUM})?`;
// "Prise(n)", "Zehe(n)": Chefkoch writes the plural ending in brackets
const INGREDIENT_RE = new RegExp(String.raw`^(${AMOUNT})?\s*(?:((?:${UNIT_RE})(?:\([a-zäöü]{1,3}\))?)(?=[\s,]|$))?\s*(.*)$`, 'i');

/** "200 g Mehl" → { amount: "200", unit: "g", name: "Mehl" }; no amount → only the name */
export function parseIngredient(line: string): Ingredient {
  const text = line.trim();
  const m = INGREDIENT_RE.exec(text);
  if (!m || (!m[1] && !m[2])) return { amount: '', unit: '', name: text };
  // "200g Mehl" has no space between amount and unit
  // "0.5" → "0,5": the notes are German
  return { amount: (m[1] ?? '').replace(/\s+/g, ' ').replace(/(\d)\.(\d)/g, '$1,$2').trim(), unit: m[2] ?? '', name: m[3].replace(/^[,\s]+/, '').trim() || text };
}

// ------------------------------------------------------------------ Markdown

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function recipeToMarkdown(recipe: Recipe): string {
  const fm: Record<string, string> = { typ: 'rezept', quelle: recipe.sourceUrl };
  if (recipe.yield) fm.portionen = recipe.yield;
  if (recipe.totalTime) fm.zeit = recipe.totalTime;
  const lines: string[] = [`# ${recipe.title}`, ''];
  if (recipe.image) lines.push(`![${recipe.title.replace(/[[\]]/g, '')}](${recipe.image})`, '');
  if (recipe.description) lines.push(`> ${recipe.description.replace(/\n/g, ' ')}`, '');

  const facts = [
    recipe.yield && `**Portionen:** ${recipe.yield}`,
    recipe.prepTime && `**Vorbereitung:** ${recipe.prepTime}`,
    recipe.cookTime && `**Kochzeit:** ${recipe.cookTime}`,
    recipe.totalTime && `**Gesamt:** ${recipe.totalTime}`,
  ].filter(Boolean);
  if (facts.length) lines.push(facts.join(' · '), '');

  if (recipe.ingredients.length) {
    lines.push('## Zutaten', '', '| Menge | Einheit | Zutat |', '| ---: | --- | --- |');
    for (const line of recipe.ingredients) {
      if (line.startsWith('## ')) {
        lines.push(`|  |  | **${cell(line.slice(3))}** |`);
        continue;
      }
      const i = parseIngredient(line);
      lines.push(`| ${cell(i.amount)} | ${cell(i.unit)} | ${cell(i.name)} |`);
    }
    lines.push('');
  }

  if (recipe.steps.length) {
    lines.push('## Zubereitung', '');
    let n = 0;
    for (const step of recipe.steps) {
      if (step.startsWith('## ')) {
        lines.push('', `### ${step.slice(3)}`, '');
        n = 0;
        continue;
      }
      lines.push(`${++n}. ${step.replace(/\n/g, ' ')}`);
    }
    lines.push('');
  }

  let host = recipe.sourceUrl;
  try {
    host = new URL(recipe.sourceUrl).hostname.replace(/^www\./, '');
  } catch {
    /* keep the raw link */
  }
  lines.push('---', '', `Quelle: [${host}](${recipe.sourceUrl})${recipe.author ? ` · ${recipe.author}` : ''}`, '');
  return setFrontmatter('', fm) + lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** A file name from the recipe title, without characters paths do not allow */
export const recipeNoteTitle = (recipe: Recipe) => recipe.title.replace(/[\\/:#[\]|^]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Rezept';
