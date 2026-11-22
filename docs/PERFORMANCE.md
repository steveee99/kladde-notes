# Performance with large vaults

Kladde should stay quick with vaults of thousands of notes, as an import from Obsidian brings them. This page describes
the benchmarks from issue #64 and records their numbers, so later changes can be compared against them.

## Benchmarks

Both use the same generated vault (`e2e/fixtures/largeVault.mjs`): by default **5,000 notes, 20,000 `[[links]]` and
10,000 tasks** in a PARA-like folder tree, with frontmatter, tags and some plain-text mentions. It is deterministic, so
runs are comparable.

```bash
npm run build
npm run bench        # shared logic in Node: link index, mentions, graph, tasks, search, queries
npm run bench:e2e    # in the browser (Playwright, Chromium): sync, start, typing, search, task page, graph
```

`npm run bench -- --notes 10000 --links 40000 --tasks 20000 --runs 9 --json` changes the size; `BENCH_NOTES=1000 npm run
bench:e2e` does the same for the browser benchmark, which writes its results to `test-results/perf-large-vault.json`.
Bundle contents: `ANALYZE=1 npm run build --workspace=packages/client` writes `packages/client/dist/stats.html`.

## Numbers (2.11.0)

Measured on a Linux container (Node 24, headless Chromium); absolute values depend on the machine, the ratios do not.

### Shared logic (`npm run bench`, 5,000 notes, median of 7 runs)

| Step | Before | After |
| --- | ---: | ---: |
| Link index after one keystroke | 66 ms | 1.6 ms |
| Link index, cold | 63 ms | 69 ms |
| Unlinked mentions of one note | 20.5 ms | 2.5 ms |
| Collect all tasks after one keystroke | 34.6 ms | 5.4 ms |
| Semantic search (MCP `semantic_search`, CLI `search`) | 2,509 ms | 136 ms |
| Semantic search after one note changed | – | 337 ms |
| Query block: open tasks due by tomorrow | 225 ms | 17 ms |
| Query block: table of a folder by tag | 12.7 ms | 3.4 ms |
| Graph (all nodes and edges) / local graph | 1.3 / 2 ms | 1.8 / 2.6 ms |

### In the browser (`npm run bench:e2e`)

| Step | 1,000 notes before | 1,000 notes after | 5,000 notes before | 5,000 notes after |
| --- | ---: | ---: | ---: | ---: |
| First sync until the notes are stored and home is shown | 256,698 ms | 937 ms | not finished after 9 min | 1,733 ms |
| Start from IndexedDB (reload until home) | 598 ms | 679 ms | – | 301 ms |
| Typing: median keystroke, key press to paint | 40 ms | 40 ms | – | 40 ms |
| Search overlay: results for two words | 349 ms | 86 ms | – | 109 ms |
| Task page until the first task | 3,549 ms | 577 ms | – | 862 ms |
| Graph page until the canvas | 996 ms | 787 ms | – | 2,186 ms |

"Before" is 2.10.0 plus the AI memory (the state of `main` before this work). With 5,000 notes it never finished the
first sync, so the later steps could not be measured.

### Bundle

Excalidraw, Mermaid (with its diagram types and cytoscape/elk), KaTeX and the PDF/Word export were already loaded only
when a note needs them. Pages that are opened now and then (settings and its sub pages, administration, files, trash,
tags, search page, share target, web clipper, OAuth consent) now load on first use as well: the entry chunk went from
1,631 KB to 1,515 KB (minified; 476 KB gzip). The service worker still precaches every chunk, so they work offline.
What remains in the entry chunk is mostly CodeMirror with the Markdown/HTML/JavaScript grammars, React, the two UI
languages and the icons.

## What changed

- **First sync** wrote and re-rendered once per note: every pulled note was its own IndexedDB transaction and woke up
  every view, which then recomputed tasks and links over the whole vault. Pulled notes now go into memory at once, to
  IndexedDB in one transaction, with one update of the UI.
- **Per-note memo** (`NoteMemo` in `shared/noteMemo.ts`): work that depends only on a note's path and text is kept
  until the note changes. Used for the link index, the task rows (navigation badge, home, task page), query blocks
  (`TaskCache`, parsed metadata) and the semantic search (indexed notes).
- **Link index from the previous index**: only changed notes are parsed again; when a change touches no title, path
  or link (the usual keystroke), the lookup tables and link lists are kept as they are.
- **Unlinked mentions** skip notes whose raw text does not contain the name before the exact check.
- **Semantic search** keeps its corpus statistics per user and updates them note by note, keeps the n-gram norms
  until something changes, caches word stems and builds snippets only for the returned hits.
- **Sorting** uses one cached `Intl.Collator` (`compareText` in `client/lib/i18n.ts`, and in query blocks) instead of
  `localeCompare` with a locale, which built a new collator per comparison; the folder list is computed once per
  change.
- **Long lists** (task buckets on home and the task page, Kanban columns) show 100 rows and more on request.
- **Graph** with more than 1,500 notes settles in fewer steps and labels only the notes in focus.

## 100,000 notes (Unreleased)

`BENCH_NOTES=100000 npm run bench:e2e` (400,000 links, 200,000 tasks, 92 MB of sync JSON), one run each:

| Step | Before | After |
| --- | ---: | ---: |
| First sync until the notes are stored and home is shown | 20,916 ms | 13,411 ms |
| Start from IndexedDB until home | 193 ms | 254 ms |
| Start from IndexedDB until the folder tree is filled | 12,641 ms | 9,596 ms |
| Typing: median keystroke, key press to paint | 32 ms | 24 ms |
| Typing: 30 keystrokes with 30 ms pauses | 881 ms | 881 ms |
| Search overlay: results for two words | 4,993 ms | 3,031 ms |
| Task page until the first task | 12,860 ms | 7,069 ms |
| Graph page until the canvas | 49,849 ms | 33,903 ms |

The per-note memos (`NoteMemo`) held at most 20,000 notes (the semantic search 10,000). A pass over more notes than
that evicts every entry before it is needed again, so above that size every pass parsed every note again. The limit is
now 250,000 (`MEMO_MAX_NOTES`), and a hit no longer moves its entry to the end of the map. The navigation badge counts
urgent tasks per note instead of building and sorting the list of all tasks on every change.

The benchmark runs without Playwright's trace: its DOM snapshots after every action made typing look like 114 s for
30 keystrokes, while key press to paint stayed below 40 ms. `BENCH_PROFILE=1` writes a CPU profile of the typing to
`test-results/perf-typing.cpuprofile` (open it in the Performance panel of Chrome DevTools).

What stays slow at this size is the work over every note on the device: storing and reading 100,000 notes, the folder
tree, the task page and the graph.

## Not done

- No Web Worker: with the incremental indexes the remaining work per keystroke is a few milliseconds, which does not
  justify moving the vault to a worker and syncing state across.
- The note list and folder tree are not virtualized; they stay usable at 5,000 notes but render every row.
- The graph of all notes still simulates every node on the main thread (about 2 s until the canvas at 5,000 notes).
