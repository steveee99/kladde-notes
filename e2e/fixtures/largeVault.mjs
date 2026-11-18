// A large, deterministic vault for the performance benchmarks (#64): by default 5,000 notes with 20,000 [[links]]
// and 10,000 tasks in a PARA-like folder tree, with frontmatter, tags, headings and some plain-text mentions.

/** Small seeded PRNG (mulberry32), so every run builds the same vault */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  'Projekt Planung Garten Reise Rezept Budget Umzug Meeting Kunde Angebot Rechnung Server Backup Notiz Idee Buch ' +
  'Lesen Training Laufen Arzt Termin Schule Auto Werkstatt Steuer Versicherung Wohnung Küche Einkauf Geschenk ' +
  'release deploy review sprint backlog roadmap design research interview draft summary migration database cache'
).split(' ');
const FOLDERS = ['0 Inbox', '1 Projects/Website', '1 Projects/Umzug', '1 Projects/Garten', '2 Areas/Finanzen', '2 Areas/Gesundheit', '3 Resources/Rezepte', '3 Resources/Bücher', '3 Resources/Tech', '4 Archive/2024', 'Journal', 'Zettelkasten'];

/**
 * @param {{ notes?: number, links?: number, tasks?: number, seed?: number, now?: number }} [opts]
 * @returns {{ id: string, path: string, content: string, createdAt: number, updatedAt: number }[]}
 */
export function generateVault({ notes = 5000, links = 20000, tasks = 10000, seed = 64, now = Date.UTC(2026, 10, 18) } = {}) {
  const r = rng(seed);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const words = (n) => Array.from({ length: n }, () => pick(WORDS)).join(' ');
  const titles = [];
  const used = new Set();
  for (let i = 0; i < notes; i++) {
    let title = `${pick(WORDS)} ${pick(WORDS)} ${i}`;
    if (used.has(title.toLowerCase())) title = `${title} b`;
    used.add(title.toLowerCase());
    titles.push(title);
  }
  const linksPer = Math.floor(links / notes);
  const tasksPer = Math.floor(tasks / notes);
  const day = (offset) => new Date(now + offset * 86400000).toISOString().slice(0, 10);
  return titles.map((title, i) => {
    const folder = FOLDERS[i % FOLDERS.length];
    const lines = ['---', `tags: [${pick(WORDS).toLowerCase()}, ${pick(WORDS).toLowerCase()}]`, `status: ${pick(['aktiv', 'idee', 'erledigt'])}`, '---', `# ${title}`, ''];
    for (let p = 0; p < 4; p++) {
      const sentence = [words(8 + Math.floor(r() * 10))];
      if (p < linksPer + (i % notes < links % notes ? 1 : 0)) sentence.push(`siehe [[${titles[Math.floor(r() * notes)]}]]`);
      // A plain mention of another title now and then (unlinked mentions)
      if (r() < 0.1) sentence.push(titles[Math.floor(r() * notes)]);
      lines.push(`${sentence.join(' ')}. #${pick(WORDS).toLowerCase()}`, '');
    }
    for (let l = 4; l < linksPer; l++) lines.push(`- [[${titles[Math.floor(r() * notes)]}]]`);
    lines.push('## Aufgaben', '');
    for (let t = 0; t < tasksPer; t++) {
      const status = pick([' ', ' ', ' ', 'x', 'o', 'h']);
      const due = r() < 0.6 ? ` due:${day(Math.floor(r() * 40) - 10)}` : '';
      lines.push(`- [${status}] ${words(4)}${due}${r() < 0.1 ? ' every:week' : ''}`);
    }
    const updatedAt = now - Math.floor(r() * 365) * 86400000;
    return { id: `bench${String(i).padStart(6, '0')}`, path: `${folder}/${title}.md`, content: lines.join('\n') + '\n', createdAt: updatedAt, updatedAt };
  });
}
