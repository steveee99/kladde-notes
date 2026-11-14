/**
 * The "Outline" tab of the note's side panel (#30): the headings of the open note, indented by level,
 * with the section in view highlighted. A click jumps to the heading, the chevron folds its section in
 * the editor, and (when the note can be edited) dragging a heading moves the whole section as one edit.
 */
import { useEffect, useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import { sectionLastIndex } from '@kladde/shared';
import { ChevronDown, ChevronRight, UnfoldLess, UnfoldMore } from '../lib/icons';
import { canFold, moveSection, setAllSectionsFolded, toggleSectionFold, type Outline } from '../editor/outline';
import { t, useLang } from '../lib/i18n';

export function OutlinePanel({
  outline,
  view,
  canEdit,
  onJump,
}: {
  outline: Outline;
  view: EditorView | null;
  canEdit: boolean;
  onJump: (pos: number) => void;
}) {
  useLang();
  const { headings, active, folded } = outline;
  const [dragging, setDragging] = useState<number | null>(null);
  /** Drop target: index of the heading the section goes in front of, or `headings.length` for the end */
  const [over, setOver] = useState<number | null>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  // Keeps the current section visible in a long outline
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (headings.length === 0) return <p className="py-8 text-center text-sm text-on-surface-variant">{t('note.tocEmpty')}</p>;

  const canDrag = canEdit && !!view;
  // A section may not go into itself or stay where it is
  const allowed = (target: number) => {
    if (dragging === null) return false;
    const last = sectionLastIndex(headings, dragging);
    if (target >= dragging && target <= last) return false;
    return true;
  };
  const drop = (target: number) => {
    if (dragging !== null && view && allowed(target)) moveSection(view, dragging, target >= headings.length ? null : target);
    setDragging(null);
    setOver(null);
  };
  const dropProps = (target: number) =>
    canDrag
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (!allowed(target)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (over !== target) setOver(target);
          },
          onDragLeave: () => setOver((o) => (o === target ? null : o)),
          onDrop: (e: React.DragEvent) => {
            e.preventDefault();
            drop(target);
          },
        }
      : {};
  const anyFolded = folded.size > 0;

  return (
    <div>
      {view && (
        <div className="mb-2 flex justify-end">
          <button
            type="button"
            className="btn-text h-8 !px-2.5 text-xs"
            onClick={() => setAllSectionsFolded(view, headings, !anyFolded)}
            title={anyFolded ? t('note.outlineExpandAll') : t('note.outlineCollapseAll')}
          >
            {anyFolded ? <UnfoldMore size={16} /> : <UnfoldLess size={16} />}
            {anyFolded ? t('note.outlineExpandAll') : t('note.outlineCollapseAll')}
          </button>
        </div>
      )}
      <ul className="space-y-0.5" role="list" aria-label={t('note.tabToc')}>
        {headings.map((h, i) => {
          const isActive = i === active;
          const isFolded = folded.has(h.from);
          const foldable = !!view && canFold(view, h.from);
          return (
            <li key={`${h.from}-${i}`} {...dropProps(i)} className="relative">
              {over === i && <div aria-hidden className="pointer-events-none absolute inset-x-2 -top-px h-0.5 rounded-full bg-primary" />}
              <div
                className={`group flex items-center rounded-full transition-colors ${dragging === i ? 'opacity-40' : ''} ${
                  isActive ? 'bg-secondary-container text-on-secondary-container' : 'hover:bg-surface-container-high'
                }`}
                style={{ paddingLeft: `${(h.level - 1) * 12}px` }}
              >
                <button
                  type="button"
                  disabled={!foldable}
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-on-surface-variant transition-opacity hover:bg-on-surface/10 disabled:opacity-0 ${
                    isFolded ? '' : 'opacity-60 group-hover:opacity-100'
                  }`}
                  aria-label={isFolded ? t('note.outlineExpand', { text: h.text }) : t('note.outlineCollapse', { text: h.text })}
                  aria-expanded={!isFolded}
                  title={isFolded ? t('note.outlineExpand', { text: h.text }) : t('note.outlineCollapse', { text: h.text })}
                  onClick={() => view && toggleSectionFold(view, h.from)}
                >
                  {isFolded ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                </button>
                <button
                  ref={isActive ? activeRef : undefined}
                  type="button"
                  draggable={canDrag}
                  aria-current={isActive ? 'location' : undefined}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', h.text);
                    setDragging(i);
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                    setOver(null);
                  }}
                  onClick={() => onJump(h.from)}
                  title={canDrag ? t('note.outlineItemHint', { text: h.text }) : t('note.tocJumpHint', { text: h.text })}
                  className={`min-w-0 flex-1 truncate py-1.5 pr-3 text-left ${
                    h.level === 1 ? 'text-sm font-medium' : h.level === 2 ? 'text-sm' : 'text-xs'
                  } ${isActive ? '' : h.level <= 2 ? 'text-on-surface' : 'text-on-surface-variant'} ${canDrag ? 'cursor-grab active:cursor-grabbing' : ''}`}
                >
                  {h.text}
                </button>
              </div>
            </li>
          );
        })}
        {dragging !== null && (
          <li {...dropProps(headings.length)} className="relative h-6">
            {over === headings.length && <div aria-hidden className="pointer-events-none absolute inset-x-2 top-1 h-0.5 rounded-full bg-primary" />}
          </li>
        )}
      </ul>
    </div>
  );
}
