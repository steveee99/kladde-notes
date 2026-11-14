import { useMemo } from 'react';
import type { EditorView } from '@codemirror/view';
import { countWords, writingStats } from '@kladde/shared';
import { t, type Lang } from '../lib/i18n';

/**
 * Status line under a note: words, characters and reading time (frontmatter and code blocks are not
 * counted); with a selection also its word count. `tick` changes whenever the editor's text or
 * selection changed, so the numbers follow typing before the note is saved.
 */
export function NoteStats({ content, view, tick, lang }: { content: string; view: EditorView | null; tick: number; lang: Lang }) {
  const { stats, selected } = useMemo(() => {
    const text = view ? view.state.doc.toString() : content;
    const sel = view ? view.state.selection.ranges.filter((r) => !r.empty).map((r) => view.state.sliceDoc(r.from, r.to)) : [];
    return { stats: writingStats(text), selected: sel.length ? countWords(sel.join('\n')) : null };
    // `tick` stands for changes inside `view`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, view, tick]);
  const fmt = (n: number) => n.toLocaleString(lang === 'en' ? 'en-US' : 'de-DE');
  const parts = [
    t(stats.words === 1 ? 'stats.word' : 'stats.words', { n: fmt(stats.words) }),
    t(stats.chars === 1 ? 'stats.char' : 'stats.chars', { n: fmt(stats.chars) }),
  ];
  if (stats.minutes) parts.push(t('stats.readingTime', { n: fmt(stats.minutes) }));
  return (
    <div role="status" aria-live="off" className="note-stats flex min-w-0 items-center justify-end gap-2 px-4 py-1 text-label-s tabular-nums text-on-surface-variant sm:px-8">
      {selected !== null && (
        <span className="shrink-0 rounded-full bg-secondary-container px-2 py-0.5 text-on-secondary-container">
          {t(selected === 1 ? 'stats.selectedOne' : 'stats.selected', { n: fmt(selected) })}
        </span>
      )}
      <span className="truncate">{parts.join(' · ')}</span>
    </div>
  );
}
