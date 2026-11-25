import { useEffect, useId, useRef, useState } from 'react';
import { useModal } from '../lib/modal';
import { createPortal } from 'react-dom';
import { ArrowLeft, RotateCcw, X } from '../lib/icons';
import { NoteVersion, NoteVersionInfo, splitPath, type VariableScope } from '@kladde/shared';
import { api } from '../lib/api';
import { vault } from '../data/vault';
import { Editor } from '../editor/Editor';
import { locale, tl, useLang } from '../lib/i18n';
import { useVisualViewport } from '../lib/viewport';
import { DiffStats, DiffView, useDiff } from './DiffView';

type Mode = 'diff' | 'rendered';

/** Version history of one note: pick a version, see what changed (git-diff style) or the rendered text */
export function HistoryDialog({ noteId, variables, current, canRestore, onClose }: { noteId: string; variables: VariableScope; current: string; canRestore: boolean; onClose: () => void }) {
  const lang = useLang();
  const loc = locale(lang);
  const fmt = (t: number) => new Date(t).toLocaleString(loc, { dateStyle: 'medium', timeStyle: 'short' });

  const [versions, setVersions] = useState<NoteVersionInfo[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Record<string, NoteVersion>>({});
  const [mode, setMode] = useState<Mode>('diff');
  const [error, setError] = useState('');
  // On narrow screens the list and the detail view alternate
  const [detail, setDetail] = useState(false);

  useEffect(() => {
    api<NoteVersionInfo[]>(`/notes/${noteId}/versions`).then(
      (list) => {
        setVersions(list);
        if (list[0]) setSelected(list[0].id);
      },
      (e) => setError(e.message)
    );
  }, [noteId]);

  const index = versions?.findIndex((v) => v.id === selected) ?? -1;
  // Each version is compared with the one before it (the oldest with an empty note)
  const previousId = versions && index >= 0 ? versions[index + 1]?.id : undefined;

  useEffect(() => {
    for (const id of [selected, previousId]) {
      if (!id || loaded[id]) continue;
      api<NoteVersion>(`/notes/${noteId}/versions/${id}`).then(
        (v) => setLoaded((l) => ({ ...l, [id]: v })),
        (e) => setError(e.message)
      );
    }
  }, [noteId, selected, previousId]);

  const version = selected ? loaded[selected] : undefined;
  const previous = previousId ? loaded[previousId] : undefined;
  const ready = !!version && (!previousId || !!previous);
  const { lines, stats } = useDiff(ready ? (previous?.content ?? '') : null, ready ? version!.content : null);

  const restore = () => {
    if (!version || !confirm(tl(lang, 'history.restoreConfirm', { date: fmt(version.savedAt) }))) return;
    void vault.update(noteId, { content: version.content });
    onClose();
  };

  const vp = useVisualViewport();

  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useModal(panel, onClose);

  return createPortal(
    <div
      className="fixed inset-x-0 z-50 flex items-end justify-center sm:items-center"
      style={vp ? { top: `${vp.top}px`, height: `${vp.height}px` } : { top: 0, bottom: 0 }}
    >
      <div className="fixed inset-0 bg-scrim/[0.32] anim-fade-in" onClick={onClose} />
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="relative flex h-[min(90vh,100%)] w-full max-w-5xl flex-col overflow-hidden rounded-t-xl border border-line2 bg-panel shadow-elevation-3 outline-none anim-sheet sm:rounded-xl">
        <div className="flex items-center gap-2 border-b border-outline-variant px-4 py-3">
          {detail && (
            <button className="btn-icon shrink-0 sm:hidden" onClick={() => setDetail(false)} title={tl(lang, 'history.backToList')}>
              <ArrowLeft size={18} />
            </button>
          )}
          <h2 id={titleId} className="min-w-0 flex-1 truncate text-headline-s">{tl(lang, 'history.title')}</h2>
          <button className="btn-icon ml-auto shrink-0" onClick={onClose} title={tl(lang, 'common.close')}>
            <X size={18} />
          </button>
        </div>
        {error ? (
          <div className="p-6 text-center text-error">{error}</div>
        ) : !versions ? (
          <div className="p-6 text-center text-on-surface-variant">{tl(lang, 'common.loading')}</div>
        ) : !versions.length ? (
          <div className="p-6 text-center text-on-surface-variant">{tl(lang, 'history.empty')}</div>
        ) : (
          <div className="flex min-h-0 flex-1">
            <ul className={`w-full shrink-0 overflow-y-auto border-outline-variant safe-bottom sm:block sm:w-64 sm:border-r ${detail ? 'hidden' : ''}`}>
              {versions.map((v, i) => (
                <li key={v.id}>
                  <button
                    className={`w-full border-b border-outline-variant px-4 py-3 text-left text-sm transition hover:bg-surface-container-high ${
                      v.id === selected ? 'bg-secondary-container/60 text-on-surface' : ''
                    }`}
                    onClick={() => {
                      setSelected(v.id);
                      setDetail(true);
                    }}
                  >
                    <div className="font-medium">{fmt(v.savedAt)}</div>
                    <div className="truncate text-xs text-on-surface-variant">
                      {i === 0 && tl(lang, 'history.currentPrefix')}
                      {splitPath(v.path).name} · {v.size < 1024 ? `${v.size} B` : `${(v.size / 1024).toFixed(1)} KB`}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
            <div className={`min-w-0 flex-1 flex-col ${detail ? 'flex' : 'hidden sm:flex'}`}>
              <div className="flex flex-wrap items-center gap-2 border-b border-outline-variant px-4 py-2 text-sm">
                <div className="flex rounded-full border border-outline-variant bg-surface-container-high p-0.5">
                  {(['diff', 'rendered'] as const).map((m) => (
                    <button
                      key={m}
                      className={`rounded-full px-3.5 py-1 text-xs font-medium transition-colors ${
                        mode === m ? 'bg-secondary-container text-on-secondary-container' : 'text-on-surface-variant hover:text-on-surface'
                      }`}
                      onClick={() => setMode(m)}
                    >
                      {m === 'diff' ? tl(lang, 'history.tabDiff') : tl(lang, 'history.tabRendered')}
                    </button>
                  ))}
                </div>
                {ready && mode === 'diff' && <DiffStats stats={stats} />}
                {canRestore && ready && version!.content !== current && (
                  <button className="btn-outlined ml-auto" onClick={restore}>
                    <RotateCcw size={13} /> {tl(lang, 'common.restore')}
                  </button>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-auto safe-bottom">
                {!ready ? (
                  <div className="p-6 text-center text-on-surface-variant">{tl(lang, 'common.loading')}</div>
                ) : mode === 'rendered' ? (
                  <div className="px-4 py-3 sm:px-8">
                    <Editor docKey={`history:${version!.id}`} value={version!.content} readOnly variables={variables} />
                  </div>
                ) : (
                  <DiffView lines={lines} />
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
