import { useMemo } from 'react';
import { diffLines, diffStats, type DiffLine } from '@kladde/shared';
import { tl, useLang } from '../lib/i18n';

/** Unchanged lines kept around each change; longer unchanged runs fold into one row */
const CONTEXT = 3;

type Row = DiffLine | { kind: 'gap'; count: number };

/** The changed lines with a few lines around them (`context` null shows every line) */
function withContext(lines: DiffLine[], context: number | null): Row[] {
  if (context === null) return lines;
  const keep = new Uint8Array(lines.length);
  lines.forEach((l, i) => {
    if (l.kind === 'same') return;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep[j] = 1;
  });
  const out: Row[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipped) out.push({ kind: 'gap', count: skipped });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped) out.push({ kind: 'gap', count: skipped });
  return out;
}

export function useDiff(before: string | null | undefined, after: string | null | undefined) {
  const lines = useMemo(() => (after == null ? [] : diffLines(before ?? '', after)), [before, after]);
  return { lines, stats: diffStats(lines), changed: lines.some((l) => l.kind !== 'same') };
}

/** `+3 −1` in the colors of the diff */
export function DiffStats({ stats }: { stats: { added: number; removed: number } }) {
  return (
    <span className="font-mono text-caption tabular-nums" data-diff-stats>
      <span className="text-ok">+{stats.added}</span> <span className="text-error">−{stats.removed}</span>
    </span>
  );
}

/** Line diff like `git diff`: old and new line numbers, added lines green, removed ones red */
export function DiffView({ lines, context = null }: { lines: DiffLine[]; context?: number | null }) {
  const lang = useLang();
  const rows = useMemo(() => withContext(lines, context === null ? null : (context ?? CONTEXT)), [lines, context]);
  if (!lines.some((l) => l.kind !== 'same')) return <div className="p-6 text-center text-on-surface-variant">{tl(lang, 'history.noChanges')}</div>;
  return (
    <pre className="min-w-full w-max font-mono text-[13px] leading-6" data-diff>
      {rows.map((l, i) =>
        l.kind === 'gap' ? (
          <div key={i} className="select-none bg-raised px-3 text-caption leading-6 text-muted">
            ⋯ {tl(lang, 'history.unchangedLines', { count: l.count })}
          </div>
        ) : (
          <div key={i} className={`flex ${l.kind === 'add' ? 'bg-ok/15' : l.kind === 'del' ? 'bg-error/15' : ''}`} data-diff-line={l.kind}>
            <span className="w-10 shrink-0 select-none pr-2 text-right text-on-surface-variant">{l.oldLine ?? ''}</span>
            <span className="w-10 shrink-0 select-none pr-2 text-right text-on-surface-variant">{l.newLine ?? ''}</span>
            <span className={`w-5 shrink-0 select-none text-center ${l.kind === 'add' ? 'text-ok' : l.kind === 'del' ? 'text-error' : 'text-on-surface-variant'}`}>
              {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
            </span>
            <span className="whitespace-pre-wrap break-words pr-4">{l.text || ' '}</span>
          </div>
        )
      )}
    </pre>
  );
}
