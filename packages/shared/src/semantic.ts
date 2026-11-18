import { LinkIndex, type LinkNote } from './links.js';
import { extractMeta, parseFrontmatter } from './markdown.js';
import { NoteMemo } from './noteMemo.js';
import { PARA } from './para.js';

export interface SemanticSearchOptions {
  folder?: string;
  limit?: number;
  minScore?: number;
  /**
   * Whose notes these are (e.g. the user id). The corpus statistics are kept per key between searches and only
   * updated for changed notes (#64); without a key one shared corpus is used.
   */
  corpusKey?: string;
}

export interface SemanticSearchHit {
  note: LinkNote;
  score: number;
  reasons: string[];
  snippet: string;
  links: string[];
  backlinks: string[];
}

const STOPWORDS = new Set([
  // German
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines',
  'und', 'oder', 'aber', 'doch', 'denn', 'sondern', 'weil', 'dass', 'da', 'wenn', 'als', 'wie',
  'wo', 'wer', 'was', 'welcher', 'welche', 'welches', 'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr',
  'mein', 'meine', 'dein', 'deine', 'sein', 'seine', 'unser', 'unsere', 'euer', 'nicht', 'kein',
  'keine', 'keinen', 'keinem', 'auch', 'noch', 'nur', 'schon', 'sehr', 'mehr', 'viel', 'viele',
  'alle', 'alles', 'man', 'sich', 'mit', 'ohne', 'fuer', 'von', 'vom', 'zu', 'zum', 'zur', 'im',
  'in', 'an', 'am', 'auf', 'aus', 'bei', 'beim', 'nach', 'ueber', 'unter', 'vor', 'hinter',
  'zwischen', 'durch', 'gegen', 'um', 'ist', 'sind', 'war', 'waren', 'bin', 'bist', 'seid',
  'haben', 'habe', 'hast', 'hat', 'hatte', 'hatten', 'werden', 'wird', 'wurde', 'wurden',
  'kann', 'koennen', 'muss', 'muessen', 'soll', 'sollen', 'will', 'wollen', 'mag', 'moegen',
  'hier', 'dort', 'dann', 'so', 'mal', 'etwas', 'nichts', 'wieder', 'immer', 'oft', 'nie',
  // English
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'of', 'to', 'on', 'at', 'for', 'from', 'by',
  'with', 'about', 'as', 'into', 'like', 'through', 'after', 'over', 'between', 'out',
  'against', 'during', 'without', 'before', 'under', 'around', 'among', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'shall', 'should', 'may', 'might', 'must', 'can', 'could', 'this', 'that', 'these', 'those',
  'it', 'its', 'they', 'them', 'their', 'we', 'our', 'you', 'your', 'he', 'she', 'his', 'her',
  'not', 'no', 'yes', 'all', 'some', 'any', 'how', 'what', 'when', 'where', 'who', 'why', 'which',
]);

/** Bilingual conceptual clusters: terms in the same cluster reinforce each other semantically */
const CONCEPT_CLUSTERS: string[][] = [
  ['urlaub', 'ferien', 'reise', 'reisen', 'trip', 'vacation', 'holiday', 'hotel', 'flug', 'unterkunft', 'strand', 'camping', 'koffer'],
  ['wohnung', 'haus', 'miete', 'mieten', 'umzug', 'umziehen', 'immobilie', 'zimmer', 'apartment', 'rent', 'home', 'moebel', 'einzug'],
  ['geld', 'finanzen', 'kosten', 'preis', 'budget', 'steuer', 'steuern', 'rechnung', 'rechnungen', 'bank', 'konto', 'ausgaben', 'einnahmen', 'gehalt', 'finance', 'money', 'tax', 'invoice'],
  ['arbeit', 'job', 'beruf', 'karriere', 'projekt', 'projekte', 'meeting', 'besprechung', 'termin', 'kollegen', 'chef', 'buero', 'work', 'office', 'career', 'team'],
  ['gesundheit', 'arzt', 'aerztin', 'medizin', 'krank', 'krankheit', 'sport', 'fitness', 'training', 'bewegung', 'schlaf', 'ernaehrung', 'health', 'doctor', 'workout'],
  ['essen', 'kochen', 'rezept', 'rezepte', 'zutat', 'zutaten', 'kueche', 'einkauf', 'einkaufen', 'supermarkt', 'lebensmittel', 'backen', 'food', 'recipe', 'cooking', 'grocery'],
  ['lernen', 'studium', 'schule', 'uni', 'universitaet', 'buch', 'buecher', 'lesen', 'wissen', 'kurs', 'notiz', 'zettel', 'learn', 'study', 'book', 'read', 'knowledge'],
  ['aufgabe', 'aufgaben', 'todo', 'todos', 'erledigen', 'planung', 'planen', 'ziel', 'ziele', 'meilenstein', 'deadline', 'fristen', 'task', 'tasks', 'plan', 'goal'],
  ['technik', 'computer', 'laptop', 'software', 'programm', 'code', 'programmieren', 'server', 'netzwerk', 'linux', 'docker', 'app', 'datenbank', 'backup', 'tech', 'deploy'],
  ['ki', 'ai', 'llm', 'modell', 'prompt', 'assistent', 'automatisierung', 'mcp', 'suche', 'search', 'agent'],
  ['auto', 'fahrzeug', 'bahn', 'zug', 'fahrrad', 'rad', 'verkehr', 'mobilitaet', 'werkstatt', 'tuev', 'versicherung', 'car', 'bike', 'train', 'transit'],
  ['familie', 'freund', 'freunde', 'kind', 'kinder', 'geburtstag', 'geschenk', 'geschenke', 'feier', 'party', 'hochzeit', 'family', 'friend', 'gift', 'birthday'],
  ['garten', 'pflanze', 'pflanzen', 'blumen', 'giessen', 'balkon', 'erde', 'saat', 'ernte', 'garden', 'plant', 'water'],
  ['musik', 'film', 'filme', 'serie', 'serien', 'kino', 'konzert', 'spiel', 'spiele', 'hobby', 'kreativ', 'foto', 'fotografie', 'music', 'movie', 'game'],
  ['vertrag', 'vertraege', 'versicherung', 'kuendigung', 'kuendigen', 'amt', 'behoerde', 'dokument', 'dokumente', 'pass', 'ausweis', 'contract', 'insurance', 'cancel'],
  ['kauf', 'kaufen', 'bestellung', 'bestellen', 'paket', 'lieferung', 'wunschliste', 'shop', 'buy', 'order', 'delivery'],
  ['idee', 'ideen', 'gedanke', 'gedanken', 'kreativ', 'brainstorming', 'konzept', 'entwurf', 'skizze', 'idea', 'thought', 'draft'],
  ['rueckblick', 'review', 'tagebuch', 'journal', 'reflexion', 'woche', 'monat', 'jahr', 'fazit', 'summary'],
];

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

const GER_MULTI = ['lichkeiten', 'igkeiten', 'schaften', 'ungen', 'heiten', 'keiten', 'schaft', 'ischen', 'lichen', 'ende', 'endes', 'enden', 'ung', 'heit', 'keit', 'lich', 'isch', 'ern', 'end', 'est', 'ten', 'tet', 'ens', 'en', 'er', 'es', 'em', 'st', 'te', 'et'];
const ENG_MULTI = ['ations', 'ments', 'nesses', 'ation', 'ment', 'ness', 'ities', 'ings', 'ing', 'ers', 'ies', 'ied', 'ity', 'ed', 'er', 'ly', 'es'];

/** Stems of tokens seen before: the vocabulary is small compared to how often its words are stemmed (#64) */
const stemCache = new Map<string, string>();

export function stemToken(raw: string): string {
  const hit = stemCache.get(raw);
  if (hit !== undefined) return hit;
  const stem = computeStem(raw);
  if (stemCache.size >= 200_000) stemCache.clear();
  stemCache.set(raw, stem);
  return stem;
}

function computeStem(raw: string): string {
  let w = normalizeText(raw).replace(/[^a-z0-9]/g, '');
  if (w.length <= 3) return w;
  for (let pass = 0; pass < 2; pass++) {
    let changed = false;
    for (const suf of GER_MULTI) {
      if (w.length - suf.length >= 3 && w.endsWith(suf)) {
        w = w.slice(0, -suf.length);
        changed = true;
        break;
      }
    }
    if (!changed) {
      for (const suf of ENG_MULTI) {
        if (w.length - suf.length >= 3 && w.endsWith(suf)) {
          if (suf === 'ies' || suf === 'ied') w = `${w.slice(0, -3)}y`;
          else {
            w = w.slice(0, -suf.length);
            if ((suf === 'ing' || suf === 'ed' || suf === 'er' || suf === 'ers') && /([bcdfghjklmnpqrstvwxz])\1$/.test(w) && w.length >= 4) {
              w = w.slice(0, -1);
            }
          }
          changed = true;
          break;
        }
      }
    }
    if (!changed && pass === 0) {
      if (w.endsWith('e') && w.length - 1 >= 4) {
        w = w.slice(0, -1);
        changed = true;
      } else if (w.endsWith('s') && w.length >= 4 && !/[aious]s$/.test(w)) {
        w = w.slice(0, -1);
        changed = true;
      } else if (w.endsWith('n') && w.length >= 6 && /[lr]n$/.test(w)) {
        w = w.slice(0, -1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return w;
}

function tokenize(text: string, keepStopwords = false): string[] {
  const norm = normalizeText(text);
  const raw = norm.match(/[a-z0-9]{2,}/g) ?? [];
  const filtered = keepStopwords ? raw : raw.filter((t) => !STOPWORDS.has(t));
  return filtered.length ? filtered : raw;
}

function charNgrams(tokens: string[]): Map<string, number> {
  const grams = new Map<string, number>();
  for (const tok of tokens) {
    if (tok.length < 3) continue;
    const padded = `_${tok}_`;
    for (let i = 0; i <= padded.length - 3; i++) {
      const g3 = padded.slice(i, i + 3);
      grams.set(g3, (grams.get(g3) ?? 0) + 1);
      if (i <= padded.length - 4) {
        const g4 = padded.slice(i, i + 4);
        grams.set(g4, (grams.get(g4) ?? 0) + 0.7);
      }
    }
  }
  return grams;
}

function cleanMarkdownForSearch(body: string): { headings: string; plain: string } {
  const headings: string[] = [];
  const plainLines: string[] = [];
  for (const rawLine of body.split('\n')) {
    const h = /^\s{0,3}#{1,6}\s+(.+)$/.exec(rawLine);
    if (h) headings.push(h[1]);
    const cleaned = rawLine
      .replace(/```[^\n]*$/g, ' ')
      .replace(/\[\[([^\]|#\n]+)(?:#([^\]|\n]*))?(?:\|([^\]\n]*))?\]\]/g, (_, target, heading, alias) =>
        [target, heading, alias].filter(Boolean).join(' ')
      )
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/^\s*[-*+]\s+\[[ xXoOhH]\]\s+/, ' ')
      .replace(/(?:📅\s*|\bdue:)\d{4}-\d{2}-\d{2}|(?:🔁\s*|\bevery:)\S+|✅\s*\d{4}-\d{2}-\d{2}/g, ' ')
      .replace(/[*_`~>#]/g, ' ');
    plainLines.push(cleaned);
  }
  return { headings: headings.join(' '), plain: plainLines.join('\n') };
}

/** Build concept lookup map: stem -> Set<relatedStems> */
const CONCEPT_MAP = (() => {
  const map = new Map<string, Set<string>>();
  for (const cluster of CONCEPT_CLUSTERS) {
    const stems = new Set(cluster.map(stemToken).filter((s) => s.length >= 2));
    for (const s of stems) {
      let entry = map.get(s);
      if (!entry) map.set(s, (entry = new Set()));
      for (const peer of stems) if (peer !== s) entry.add(peer);
    }
  }
  return map;
})();

interface IndexedDoc {
  note: LinkNote;
  title: string;
  folder: string;
  tags: string[];
  plainBody: string;
  /** Raw normalized tokens across fields (for compound splitting) */
  rawTokens: Set<string>;
  titleRaw: string[];
  /** Weighted term frequencies per stem */
  stemWeights: Map<string, number>;
  /** Field membership for explanations */
  titleStems: Set<string>;
  headingTagStems: Set<string>;
  /** Length proxy for BM25 length normalization */
  docLen: number;
  grams: Map<string, number>;
}

function indexNote(note: LinkNote): IndexedDoc {
  const meta = extractMeta(note.path, note.content);
  const { body } = parseFrontmatter(note.content);
  const { headings, plain } = cleanMarkdownForSearch(body);

  const titleToks = tokenize(meta.title);
  const folderToks = tokenize(meta.folder.replace(/\//g, ' '));
  const headingToks = tokenize(headings);
  const tagToks = tokenize(meta.tags.join(' '));
  const fmVals = Object.entries(meta.frontmatter)
    .filter(([k]) => k !== 'id')
    .map(([, v]) => v)
    .join(' ');
  const fmToks = tokenize(fmVals);
  const bodyToks = tokenize(plain);

  const rawTokens = new Set<string>([...titleToks, ...folderToks, ...headingToks, ...tagToks, ...fmToks, ...bodyToks]);
  const stemWeights = new Map<string, number>();
  const add = (toks: string[], weight: number, bucket?: Set<string>) => {
    for (const t of toks) {
      const s = stemToken(t);
      if (!s) continue;
      stemWeights.set(s, (stemWeights.get(s) ?? 0) + weight);
      bucket?.add(s);
    }
  };

  const titleStems = new Set<string>();
  const headingTagStems = new Set<string>();
  add(titleToks, 3.0, titleStems);
  add(headingToks, 2.0, headingTagStems);
  add(tagToks, 2.2, headingTagStems);
  add(folderToks, 1.3, headingTagStems);
  add(fmToks, 1.2, headingTagStems);
  add(bodyToks, 1.0);

  const allGramsTokens = [...titleToks, ...titleToks, ...headingToks, ...tagToks, ...bodyToks];
  const grams = charNgrams(allGramsTokens);

  return {
    note,
    title: meta.title,
    folder: meta.folder,
    tags: meta.tags,
    plainBody: plain,
    rawTokens,
    titleRaw: titleToks,
    stemWeights,
    titleStems,
    headingTagStems,
    docLen: Math.max(1, bodyToks.length + titleToks.length * 2 + headingToks.length),
    grams,
  };
}

function cosineSimilarity(
  a: Map<string, number>,
  b: Map<string, number>,
  idf?: { get(key: string): number | undefined },
  /** The squared norm of `b`, when the caller keeps it */
  normOfB?: () => number
): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [k, va] of a) {
    const w = va * (idf ? (idf.get(k) ?? 1) : 1);
    normA += w * w;
    const vb = b.get(k);
    if (vb) dot += w * (vb * (idf ? (idf.get(k) ?? 1) : 1));
  }
  if (dot === 0 || normA === 0) return 0;
  if (normOfB) normB = normOfB();
  else {
    for (const [k, vb] of b) {
      const w = vb * (idf ? (idf.get(k) ?? 1) : 1);
      normB += w * w;
    }
  }
  return normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function bestSnippet(plainBody: string, title: string, queryStems: Map<string, number>, queryRaw: string[]): string {
  const cleaned = plainBody.replace(/\s+/g, ' ').trim();
  if (!cleaned) return title;
  if (cleaned.length <= 220) return cleaned;

  const lines = plainBody
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  let bestLineIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < lines.length; i++) {
    const toks = tokenize(lines[i], true);
    let score = 0;
    for (const t of toks) {
      const s = stemToken(t);
      score += queryStems.get(s) ?? 0;
      for (const q of queryRaw) {
        if (q.length >= 4 && t.length >= 4 && (t.includes(q) || q.includes(t))) score += 0.6;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestLineIdx = i;
    }
  }

  // Build a ~220 char excerpt centered on the best line
  let startLine = bestLineIdx;
  let acc = lines[bestLineIdx];
  while (acc.length < 180 && startLine + 1 < lines.length) {
    startLine++;
    acc += ` ${lines[startLine]}`;
  }
  if (acc.length > 220) acc = `${acc.slice(0, 217).trimEnd()}…`;
  return bestLineIdx > 0 ? `… ${acc}` : acc;
}

/** Indexed notes of earlier searches (bounded), and the last link index, so a search only indexes changed notes */
const docMemo = new NoteMemo<IndexedDoc, LinkNote>(indexNote, 10_000);
let lastIndex: LinkIndex | null = null;

/** Document frequencies over a set of notes, updated note by note instead of recounted for every search */
interface Corpus {
  docs: Map<string, IndexedDoc>;
  dfStem: Map<string, number>;
  dfGram: Map<string, number>;
  /** How many notes contain each raw token (for compound splitting) */
  rawTokens: Map<string, number>;
  totalLen: number;
  /** Changes whenever a note is added, changed or removed: the idf weights (and the norms below) depend on it */
  generation: number;
  /** idf-weighted n-gram norm per doc, valid for one generation */
  gramNorms: WeakMap<IndexedDoc, { generation: number; norm: number }>;
}

const corpora = new Map<string, Corpus>();
const MAX_CORPORA = 8;

const bump = (map: Map<string, number>, key: string, by: number) => {
  const n = (map.get(key) ?? 0) + by;
  if (n > 0) map.set(key, n);
  else map.delete(key);
};

function countDoc(c: Corpus, d: IndexedDoc, by: 1 | -1) {
  for (const s of d.stemWeights.keys()) bump(c.dfStem, s, by);
  for (const g of d.grams.keys()) bump(c.dfGram, g, by);
  for (const r of d.rawTokens) bump(c.rawTokens, r, by);
  c.totalLen += by * d.docLen;
}

/** The corpus for `key` brought up to date with `docs` (the same doc object means an unchanged note) */
function corpusFor(key: string, docs: IndexedDoc[]): Corpus {
  let c = corpora.get(key);
  if (c) corpora.delete(key);
  else c = { docs: new Map(), dfStem: new Map(), dfGram: new Map(), rawTokens: new Map(), totalLen: 0, generation: 0, gramNorms: new WeakMap() };
  corpora.set(key, c);
  if (corpora.size > MAX_CORPORA) corpora.delete(corpora.keys().next().value!);
  const seen = new Set<string>();
  for (const d of docs) {
    const id = d.note.id;
    seen.add(id);
    const old = c.docs.get(id);
    if (old === d) continue;
    if (old) countDoc(c, old, -1);
    countDoc(c, d, 1);
    c.docs.set(id, d);
    c.generation++;
  }
  if (c.docs.size !== seen.size) {
    for (const [id, d] of c.docs) {
      if (seen.has(id)) continue;
      countDoc(c, d, -1);
      c.docs.delete(id);
    }
    c.generation++;
  }
  return c;
}

/**
 * Local conceptual + lexical + graph-aware semantic search over notes.
 * Combines BM25 over stemmed fields, German compound/subword matching,
 * character n-gram TF-IDF similarity, bilingual concept clusters, and WikiLink context.
 */
export function semanticSearch(query: string, notes: LinkNote[], options: SemanticSearchOptions = {}): SemanticSearchHit[] {
  const trimmed = query.trim();
  if (!trimmed || !notes.length) return [];

  const folder = options.folder?.replace(/^\/+|\/+$/g, '');
  const limit = Math.max(1, Math.min(options.limit ?? 10, 100));
  const minScore = options.minScore ?? 0.05;

  const rawQueryTokens = tokenize(trimmed);
  if (!rawQueryTokens.length) return [];

  // Indexing is the expensive part: kept per note between searches and redone only for changed notes (#64).
  // The indexed doc may hold an older object of the same note; results use the note passed in.
  const current = new Map(notes.map((n) => [n.id, n]));
  const docs = notes.map((n) => docMemo.get(n));
  const N = docs.length;

  // Document frequencies for stems & n-grams across the entire space, kept up to date per note
  const corpus = corpusFor(options.corpusKey ?? '', docs);
  const { dfStem, dfGram } = corpus;
  const avgLen = corpus.totalLen / N;
  const corpusRawTokens = corpus.rawTokens.keys();
  const idfStem = (s: string) => Math.max(0.35, Math.log(1 + (N - (dfStem.get(s) ?? 0) + 0.5) / ((dfStem.get(s) ?? 0) + 0.5)));
  const idfGram = new IdfMap(dfGram, N);

  // Build weighted query stems: direct stems (1.0), compound parts from corpus (0.7), concept siblings (0.38)
  const directStems = new Set<string>();
  const compoundStems = new Set<string>();
  const conceptStems = new Set<string>();
  const queryStemWeights = new Map<string, number>();

  for (const qt of rawQueryTokens) {
    const s = stemToken(qt);
    if (!s) continue;
    directStems.add(s);
    queryStemWeights.set(s, Math.max(queryStemWeights.get(s) ?? 0, 1.0));

    // Compound splitting against corpus tokens & stems (e.g., query "Mietvertrag" matches "Miete" & "Vertrag")
    if (qt.length >= 7) {
      for (const candidate of corpusRawTokens) {
        const cs = stemToken(candidate);
        if (!cs || directStems.has(cs)) continue;
        const matchesRaw = candidate.length >= 4 && candidate.length <= qt.length - 3 && qt.includes(candidate);
        const matchesStem = cs.length >= 4 && cs.length <= qt.length - 3 && qt.includes(cs);
        if (matchesRaw || matchesStem) {
          compoundStems.add(cs);
          queryStemWeights.set(cs, Math.max(queryStemWeights.get(cs) ?? 0, 0.7));
        }
      }
    }

    // Concept cluster expansion
    const related = CONCEPT_MAP.get(s);
    if (related) {
      for (const peer of related) {
        if (!directStems.has(peer)) {
          conceptStems.add(peer);
          queryStemWeights.set(peer, Math.max(queryStemWeights.get(peer) ?? 0, 0.38));
        }
      }
    }
  }

  const queryGrams = charNgrams(rawQueryTokens);
  const k1 = 1.4;
  const b = 0.6;

  const baseScores = new Map<string, { score: number; reasons: Set<string>; doc: IndexedDoc }>();
  for (const d of docs) {
    const reasons = new Set<string>();
    let bm25 = 0;
    let directHits = 0;
    let compoundHits = 0;
    let conceptHits = 0;

    for (const [qs, qw] of queryStemWeights) {
      let tf = d.stemWeights.get(qs) ?? 0;
      const compoundTitle = !d.titleStems.has(qs) && qs.length >= 4 && d.titleRaw.some((dt) => dt.length >= qs.length + 2 && dt.includes(qs));
      if (compoundTitle) {
        tf += 1.5;
        compoundHits++;
      } else if (tf === 0 && qs.length >= 4) {
        // Also match compound document words containing the query stem (e.g. query "wohnung" matches "wohnungssuche")
        for (const dt of d.rawTokens) {
          if (dt.length >= qs.length + 2 && dt.includes(qs)) {
            tf += 0.75;
            compoundHits++;
          }
        }
      }

      if (tf <= 0) continue;
      const denom = tf + k1 * (1 - b + (b * d.docLen) / avgLen);
      const termBm25 = idfStem(qs) * ((tf * (k1 + 1)) / denom) * qw;
      bm25 += termBm25;

      if (directStems.has(qs)) {
        directHits++;
        if (d.titleStems.has(qs) || compoundTitle) reasons.add('Titel');
        else if (d.headingTagStems.has(qs)) reasons.add('Überschrift/Tags');
        else reasons.add('Text');
      } else if (compoundStems.has(qs)) {
        compoundHits++;
        reasons.add('Wortteil');
      } else if (conceptStems.has(qs)) {
        conceptHits++;
        reasons.add('Themenverwandt');
      }
    }

    if (compoundHits > 0 && !reasons.has('Wortteil')) reasons.add('Kompositum');

    // Cosine similarity on character n-grams & stemmed terms
    const gramCos = cosineSimilarity(queryGrams, d.grams, idfGram, () => {
      const cached = corpus.gramNorms.get(d);
      if (cached?.generation === corpus.generation) return cached.norm;
      let sum = 0;
      for (const [k, vb] of d.grams) {
        const w = vb * (idfGram.get(k) ?? 1);
        sum += w * w;
      }
      corpus.gramNorms.set(d, { generation: corpus.generation, norm: sum });
      return sum;
    });
    const stemCos = cosineSimilarity(queryStemWeights, d.stemWeights);
    if (gramCos >= 0.14 && directHits === 0 && conceptHits === 0) reasons.add('Ähnliche Begriffe');

    // Saturating normalization of BM25: ~4.0 BM25 -> ~0.75
    const normBm25 = bm25 > 0 ? bm25 / (bm25 + 1.8) : 0;
    const coverage = directStems.size ? directHits / directStems.size : 0;

    // Combined base score
    let combined = normBm25 * 0.62 + stemCos * 0.22 + gramCos * 0.24 + coverage * 0.12;
    if (directHits === 0 && conceptHits === 0 && compoundHits === 0 && gramCos < 0.12) {
      combined = 0;
    }

    baseScores.set(d.note.id, { score: Math.min(1, combined), reasons, doc: d });
  }

  // Link-graph semantic context propagation (1 hop along outgoing/backlinks)
  const index = new LinkIndex(notes, PARA, lastIndex);
  lastIndex = index;
  const titleOf = (id: string) => index.notes.get(id)?.title ?? id;

  const finalHits: (SemanticSearchHit & { doc: IndexedDoc })[] = [];
  for (const d of docs) {
    if (folder && !d.note.path.startsWith(`${folder}/`)) continue;
    const entry = baseScores.get(d.note.id)!;
    const outIds = index.outgoing(d.note.id);
    const backIds = index.backlinks(d.note.id);
    const neighbors = [...new Set([...outIds, ...backIds])];
    let bestNeighbor = 0;
    for (const nid of neighbors) {
      const ns = baseScores.get(nid)?.score ?? 0;
      if (ns > bestNeighbor) bestNeighbor = ns;
    }

    // Connected notes reinforce existing matches and softly surface strong graph neighbors
    let score = entry.score;
    const reasons = new Set(entry.reasons);
    if (bestNeighbor >= 0.35) {
      const boost = entry.score > 0 ? bestNeighbor * 0.18 : bestNeighbor * 0.28;
      score = Math.min(1, score + boost);
      reasons.add('Verknüpfte Notizen');
    }

    if (score < minScore || reasons.size === 0) continue;

    finalHits.push({
      note: current.get(d.note.id) ?? d.note,
      score: Math.round(score * 1000) / 1000,
      reasons: [...reasons],
      snippet: '',
      links: outIds.map(titleOf),
      backlinks: backIds.map(titleOf),
      doc: d,
    });
  }

  finalHits.sort((a, b) => b.score - a.score || (b.note.updatedAt ?? 0) - (a.note.updatedAt ?? 0));
  // Snippets only for the hits that are returned
  return finalHits.slice(0, limit).map(({ doc, ...hit }) => ({ ...hit, snippet: bestSnippet(doc.plainBody, doc.title, queryStemWeights, rawQueryTokens) }));
}

/** idf of character n-grams, computed when asked instead of for every n-gram of the corpus */
class IdfMap {
  private cache = new Map<string, number>();
  constructor(
    private readonly df: Map<string, number>,
    private readonly n: number
  ) {}

  /** undefined for n-grams no note contains (the caller weighs them with 1) */
  get(gram: string): number | undefined {
    let v = this.cache.get(gram);
    if (v === undefined) {
      const df = this.df.get(gram);
      if (df === undefined) return undefined;
      v = Math.log(1 + this.n / (df + 0.5));
      this.cache.set(gram, v);
    }
    return v;
  }
}
