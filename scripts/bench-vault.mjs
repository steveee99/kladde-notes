// Benchmark of the vault-wide work on a large vault (#64): `npm run bench` (after `npm run build`).
// Measures the shared logic the client runs over all notes: the link index (cold, and after one note changed, as
// on every keystroke), backlinks, unlinked mentions, the graph, collecting tasks, search and a query.
// Options: --notes 5000 --links 20000 --tasks 10000 --runs 7 --json
import { performance } from 'perf_hooks';
import { parseArgs } from 'util';
import { generateVault } from '../e2e/fixtures/largeVault.mjs';
import { LinkIndex, NoteMemo, PARA, parseTasks, projectTitleOf, runQuery, semanticSearch, splitPath, roleOfPath } from '../packages/shared/dist/index.js';

const { values } = parseArgs({
  options: {
    notes: { type: 'string', default: '5000' },
    links: { type: 'string', default: '20000' },
    tasks: { type: 'string', default: '10000' },
    runs: { type: 'string', default: '7' },
    json: { type: 'boolean', default: false },
  },
});
const runs = Number(values.runs);
const vault = generateVault({ notes: Number(values.notes), links: Number(values.links), tasks: Number(values.tasks) });

/** Median time of `runs` runs (after one warm-up) in ms */
function measure(fn) {
  fn();
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

/** One keystroke in note 0: a new object with a little more text, like vault.update */
let typed = 0;
const typeOne = (notes) => {
  typed++;
  const copy = notes.slice();
  copy[0] = { ...copy[0], content: `${copy[0].content}x${typed}` };
  return copy;
};

/** Like collectTasks in the client (TaskParts.tsx): with `memo` the rows of unchanged notes are reused */
const collectTasks = (notes, memo) => {
  const rowsOf = (n) => {
    if (roleOfPath(n.path, PARA) === 'archive') return [];
    const tasks = parseTasks(n.content);
    if (!tasks.length) return [];
    const noteTitle = projectTitleOf(n.path, n.content, PARA);
    const folder = splitPath(n.path).folder;
    return tasks.map((tk) => ({ ...tk, noteId: n.id, noteTitle, folder }));
  };
  const out = [];
  for (const n of notes) for (const row of memo ? memo.get(n, '', rowsOf) : rowsOf(n)) out.push(row);
  return out.sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'));
};

const results = [];
const row = (name, ms, note = '') => results.push({ name, ms: Math.round(ms * 10) / 10, note });

let notes = vault;
const index = new LinkIndex(notes, PARA);
row('link index, cold', measure(() => new LinkIndex(notes, PARA)));
const warm = new LinkIndex(notes, PARA);
let previous = warm;
row(
  'link index after one keystroke',
  measure(() => {
    notes = typeOne(notes);
    previous = new LinkIndex(notes, PARA, previous);
  }),
  'reuses the parsed notes of the previous index'
);
const busiest = [...index.notes.keys()].sort((a, b) => index.backlinks(b).length - index.backlinks(a).length)[0];
row('backlinks of one note', measure(() => index.backlinks(busiest)));
row('unlinked mentions of one note', measure(() => index.unlinkedMentions(busiest)));
row('graph (all nodes and edges)', measure(() => index.graph()));
row('local graph, depth 2', measure(() => index.localGraph(busiest, 2)));
row('collect tasks, cold', measure(() => collectTasks(notes)));
const rowMemo = new NoteMemo();
collectTasks(notes, rowMemo);
row(
  'collect tasks after one keystroke',
  measure(() => {
    notes = typeOne(notes);
    collectTasks(notes, rowMemo);
  }),
  'rows of unchanged notes reused'
);
row('search "Garten Budget"', measure(() => semanticSearch('Garten Budget', notes, { limit: 20 })), 'MCP semantic_search, CLI search');
row(
  'search after one note changed',
  measure(() => {
    notes = typeOne(notes);
    semanticSearch('Garten Budget', notes, { limit: 20 });
  })
);
row('query (open tasks due by tomorrow)', measure(() => runQuery('TASKS WHERE done = false AND due <= tomorrow SORT due', notes)));
row('query (table of a folder by tag)', measure(() => runQuery('TABLE title, status, updated FROM "1 Projects" WHERE tags contains "garten" SORT updated DESC', notes)));

const taskCount = collectTasks(vault).length;
const linkCount = [...index.notes.keys()].reduce((s, id) => s + index.outgoing(id).length, 0);
if (values.json) {
  console.log(JSON.stringify({ notes: vault.length, links: linkCount, tasks: taskCount, runs, results }, null, 2));
} else {
  console.log(`Vault: ${vault.length} notes, ${linkCount} resolved links, ${taskCount} tasks · median of ${runs} runs · Node ${process.version}\n`);
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) console.log(`${r.name.padEnd(width)}  ${String(r.ms).padStart(8)} ms  ${r.note}`);
}
