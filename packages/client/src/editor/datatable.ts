/** Interactive table (sort by header click, filter field) used for Markdown tables and query results */

export interface DataRow {
  cells: (string | Node)[];
  /** Plain values for sorting and filtering */
  keys: string[];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Very small inline Markdown → HTML for table cells (escaped first, so it is safe) */
export function renderInline(text: string): string {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code class="cm-inline-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, t, a) => `<span class="cm-wikilink" data-wiki="${t}">${a ?? t}</span>`)
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a class="cm-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

export function stripInline(text: string): string {
  return text.replace(/[*_`~]|\[\[|\]\]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
}

export function dataTable(headers: string[], rows: DataRow[], opts: { align?: ('left' | 'center' | 'right' | null)[]; caption?: string; onWiki?: (t: string) => void } = {}): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'cm-block-widget wz-table';
  let sortCol = -1;
  let desc = false;
  let filter = '';

  const bar = document.createElement('div');
  bar.className = 'wz-table-bar';
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = 'Filtern …';
  input.className = 'wz-table-filter';
  const count = document.createElement('span');
  count.className = 'wz-table-count';
  if (opts.caption) {
    const cap = document.createElement('span');
    cap.className = 'wz-table-caption';
    cap.textContent = opts.caption;
    bar.append(cap);
  }
  bar.append(input, count);

  const scroller = document.createElement('div');
  scroller.className = 'wz-table-scroll scrollbar-thin';
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headers.forEach((h, i) => {
    const th = document.createElement('th');
    th.innerHTML = `<span>${renderInline(h)}</span><i class="wz-sort"></i>`;
    if (opts.align?.[i]) th.style.textAlign = opts.align[i]!;
    th.addEventListener('click', () => {
      if (sortCol === i) desc = !desc;
      else {
        sortCol = i;
        desc = false;
      }
      draw();
    });
    headRow.append(th);
  });
  thead.append(headRow);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);
  scroller.append(table);
  wrap.append(bar, scroller);

  input.addEventListener('input', () => {
    filter = input.value.toLowerCase();
    draw();
  });
  wrap.addEventListener('click', (e) => {
    const wiki = (e.target as HTMLElement).closest('[data-wiki]') as HTMLElement | null;
    if (wiki && opts.onWiki) {
      e.preventDefault();
      opts.onWiki(wiki.dataset.wiki!);
    }
  });

  function draw() {
    let list = filter ? rows.filter((r) => r.keys.some((k) => k.toLowerCase().includes(filter))) : rows.slice();
    if (sortCol >= 0) {
      list = list.sort((a, b) => {
        const c = (a.keys[sortCol] ?? '').localeCompare(b.keys[sortCol] ?? '', 'de', { numeric: true, sensitivity: 'base' });
        return desc ? -c : c;
      });
    }
    headRow.querySelectorAll('th').forEach((th, i) => {
      th.classList.toggle('sorted', i === sortCol);
      th.classList.toggle('desc', i === sortCol && desc);
    });
    tbody.replaceChildren(
      ...list.map((r) => {
        const tr = document.createElement('tr');
        r.cells.forEach((c, i) => {
          const td = document.createElement('td');
          if (opts.align?.[i]) td.style.textAlign = opts.align[i]!;
          if (typeof c === 'string') td.innerHTML = renderInline(c);
          else td.append(c);
          tr.append(td);
        });
        return tr;
      })
    );
    count.textContent = filter ? `${list.length} von ${rows.length}` : `${rows.length} Zeilen`;
  }
  draw();
  return wrap;
}

/** Parses a GFM table; null if it is not one */
export function parseMarkdownTable(src: string): { headers: string[]; align: ('left' | 'center' | 'right' | null)[]; rows: string[][] } | null {
  const lines = src.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return null;
  const split = (l: string) => {
    let s = l.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  };
  const headers = split(lines[0]);
  const align = split(lines[1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : /^:-+$/.test(c) ? 'left' : null));
  const rows = lines.slice(2).map((l) => {
    const cells = split(l);
    return headers.map((_, i) => cells[i] ?? '');
  });
  return { headers, align, rows };
}
