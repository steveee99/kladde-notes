import { useState } from 'react';
import { splitPath } from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import { ArrowLeft, ArrowRight, FileText, OpenInFull, SwapHoriz, X } from '../lib/icons';
import { t, useLang } from '../lib/i18n';
import { dragSource, draggedItem } from '../lib/dnd';
import { useFocusMode } from '../lib/focus';
import { navigate } from '../lib/router';
import { closeSide, openInSide, PaneContext, sideBack, sideForward, splitPaneWidth, swapPanes, useSideNote, useSplitAvailable, type Pane } from '../lib/panes';
import { useWidth } from '../lib/sidebarWidth';
import { RightPaneHostContext } from './WerkbankShell';
import { NoteView } from './NoteView';
import { ResizeHandle } from './SidebarResizeHandle';

/**
 * Two notes side by side (#88): the main pane follows the address, the side pane has its own history,
 * header (back, forward, swap, open as main note, close) and side panel. Phones and narrow windows show one note.
 */
export function SplitNoteView({ mainId, isNew }: { mainId: string; isNew: boolean }) {
  const side = useSideNote();
  const available = useSplitAvailable();
  const focus = useFocusMode() && vault.features().focus.enabled;
  const width = useWidth(splitPaneWidth);
  const main = <NoteView key={mainId} id={mainId} isNew={isNew} />;
  if (!side || !available || focus) return main;
  return (
    <div className="flex h-full min-h-0 min-w-0">
      <PaneFrame pane="main" className="min-w-0 flex-1">
        {main}
      </PaneFrame>
      <div className="relative flex shrink-0 border-l border-outline-variant/60" style={{ width, maxWidth: '62%', minWidth: 0 }}>
        <ResizeHandle store={splitPaneWidth} edge="left" label={t('split.resize')} className="!inset-y-0" />
        <PaneFrame pane="side" className="min-w-0 flex-1" header={<SideHeader id={side.id} mainId={mainId} canBack={side.canBack} canForward={side.canForward} />}>
          {/* The side note keeps its own copy of NoteView, keyed so its state starts fresh for each note */}
          <NoteView key={`side-${side.id}`} id={side.id} isNew={false} />
        </PaneFrame>
      </div>
    </div>
  );
}

/** One pane: its own scroll area and its own place for the note's side panel */
function PaneFrame({ pane, className = '', header, children }: { pane: Pane; className?: string; header?: React.ReactNode; children: React.ReactNode }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return (
    <PaneContext.Provider value={pane}>
      <section data-pane={pane} aria-label={pane === 'side' ? t('split.sideLabel') : t('split.mainLabel')} className={`flex min-h-0 ${className}`}>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {header}
          <RightPaneHostContext.Provider value={host}>
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">{children}</div>
          </RightPaneHostContext.Provider>
        </div>
        <div ref={setHost} className="no-print hidden shrink-0 py-2 pr-2 empty:hidden lg:flex" />
      </section>
    </PaneContext.Provider>
  );
}

function SideHeader({ id, mainId, canBack, canForward }: { id: string; mainId: string; canBack: boolean; canForward: boolean }) {
  useVault();
  useLang();
  const note = vault.get(id);
  const title = note ? (vault.links().notes.get(id)?.title ?? splitPath(note.path).name) : t('split.missing');
  const [over, setOver] = useState(false);
  const btn = 'btn-icon h-9 w-9 shrink-0';
  return (
    <div
      className={`no-print flex min-h-12 shrink-0 items-center gap-0.5 border-b border-outline-variant/60 px-1.5 transition-colors ${over ? 'bg-secondary-container' : ''}`}
      // A note dragged from the sidebar or the other pane opens here
      onDragOver={(e) => {
        if (draggedItem()?.kind !== 'note') return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const item = draggedItem();
        if (item?.kind !== 'note') return;
        e.preventDefault();
        openInSide(item.id);
      }}
    >
      <button type="button" className={btn} onClick={sideBack} disabled={!canBack} title={t('split.back')} aria-label={t('split.back')}>
        <ArrowLeft size={18} />
      </button>
      <button type="button" className={btn} onClick={sideForward} disabled={!canForward} title={t('split.forward')} aria-label={t('split.forward')}>
        <ArrowRight size={18} />
      </button>
      {/* Dragging the title into the other pane's text inserts a link to this note */}
      <div
        {...(note ? dragSource({ kind: 'note', id }) : {})}
        className="flex min-w-0 flex-1 cursor-grab items-center gap-2 px-1.5 text-title-s"
        title={t('split.dragHint')}
      >
        <FileText size={16} className="shrink-0 text-on-surface-variant" />
        <span className="truncate">{title}</span>
      </div>
      <button type="button" className={btn} onClick={() => swapPanes(mainId)} title={t('split.swap')} aria-label={t('split.swap')}>
        <SwapHoriz size={18} />
      </button>
      <button
        type="button"
        className={btn}
        onClick={() => {
          closeSide();
          navigate(`/n/${id}`);
        }}
        title={t('split.openMain')}
        aria-label={t('split.openMain')}
      >
        <OpenInFull size={16} />
      </button>
      <button type="button" className={btn} onClick={closeSide} title={t('split.close')} aria-label={t('split.close')}>
        <X size={18} />
      </button>
    </div>
  );
}
