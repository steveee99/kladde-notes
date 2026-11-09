/** Line based diff (like `git diff`): common prefix/suffix are trimmed, the middle uses an LCS table */
export type DiffKind = 'same' | 'add' | 'del';

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** 1-based line number in the old text (not for added lines) */
  oldLine?: number;
  /** 1-based line number in the new text (not for removed lines) */
  newLine?: number;
}

/** Above this many table cells the middle part is shown as fully replaced instead of computing an LCS */
const MAX_CELLS = 4_000_000;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ kind: 'same', text: a[i], oldLine: i + 1, newLine: i + 1 });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if (n * m > MAX_CELLS) {
    midA.forEach((text, i) => out.push({ kind: 'del', text, oldLine: start + i + 1 }));
    midB.forEach((text, i) => out.push({ kind: 'add', text, newLine: start + i + 1 }));
  } else {
    // lcs[i][j] = length of the LCS of midA[i..] and midB[j..]
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = midA[i] === midB[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        out.push({ kind: 'same', text: midA[i], oldLine: start + i + 1, newLine: start + j + 1 });
        i++;
        j++;
      } else if (j < m && (i === n || lcs[i * w + j + 1] > lcs[(i + 1) * w + j])) {
        out.push({ kind: 'add', text: midB[j], newLine: start + j + 1 });
        j++;
      } else {
        out.push({ kind: 'del', text: midA[i], oldLine: start + i + 1 });
        i++;
      }
    }
  }
  const tail = a.length - endA;
  for (let k = 0; k < tail; k++) out.push({ kind: 'same', text: a[endA + k], oldLine: endA + k + 1, newLine: endB + k + 1 });
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === 'add') added++;
    else if (l.kind === 'del') removed++;
  }
  return { added, removed };
}
