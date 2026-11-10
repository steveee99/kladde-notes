import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, RotateCcw, X } from 'lucide-react';
import { diffLines, diffStats, NoteVersion, NoteVersionInfo, splitPath } from '@kladde/shared';
import { api } from '../lib/api';
import { vault } from '../data/vault';
import { Editor } from '../editor/Editor';
import { locale, tl, useLang } from '../lib/i18n';
import { useVisualViewport } from '../lib/viewport';

type Mode = 'diff' | 'rendered';

/** Version history of one note: pick a version, see what changed (git-diff style) or the rendered text */
export function HistoryDialog({ noteId, current, canRestore, onClose }: { noteId: string; current: string; canRestore: boolean; onClose: () => void }) {
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
  const lines = useMemo(() => (ready ? diffLines(previous?.content ?? '', version!.content) : []), [ready, previous, version]);
  const stats = diffStats(lines);

  const restore = () => {
    if (!version || !confirm(tl(lang, 'history.restoreConfirm', { date: fmt(version.savedAt) }))) return;
    void vault.update(noteId, { content: version.content });
    onClose();
  };

  const vp = useVisualViewport();

  return (
    <div
      className="fixed inset-x-0 z-50 flex items-end justify-center sm:items-center"
      style={vp ? { top: `${vp.top}px`, height: `${vp.height}px` } : { top: 0, bottom: 0 }}
    >
      <div className="fixed inset-0 bg-black/40 anim-fade-in" onClick={onClose} />
      <div className="relative flex h-[min(90vh,100%)] w-full max-w-5xl flex-col overflow-hidden rounded-t-3xl bg-surface shadow-soft anim-sheet sm:rounded-3xl">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          {detail && (
            <button className="btn-icon sm:hidden" onClick={() => setDetail(false)} title={tl(lang, 'history.backToList')}>
              <ArrowLeft size={18} />
            </button>
          )}
          <h2 className="text-lg font-semibold">{tl(lang, 'history.title')}</h2>
          <button className="btn-icon ml-auto" onClick={onClose} title={tl(lang, 'common.close')}>
            <X size={18} />
          </button>
        </div>
        {error ? (
          <div className="p-6 text-center text-danger">{error}</div>
        ) : !versions ? (
          <div className="p-6 text-center text-faint">{tl(lang, 'common.loading')}</div>
        ) : !versions.length ? (
          <div className="p-6 text-center text-muted">{tl(lang, 'history.empty')}</div>
        ) : (
          <div className="flex min-h-0 flex-1">
            <ul className={`w-full shrink-0 overflow-y-auto border-line sm:block sm:w-64 sm:border-r ${detail ? 'hidden' : ''}`}>
              {versions.map((v, i) => (
                <li key={v.id}>
                  <button
                    className={`w-full border-b border-line px-4 py-3 text-left text-sm transition hover:bg-raised ${
                      v.id === selected ? 'bg-accent-container/25 text-ink' : ''
                    }`}
                    onClick={() => {
                      setSelected(v.id);
                      setDetail(true);
                    }}
                  >
                    <div className="font-medium">{fmt(v.savedAt)}</div>
                    <div className="truncate text-xs text-faint">
                      {i === 0 && tl(lang, 'history.currentPrefix')}
                      {splitPath(v.path).name} · {v.size < 1024 ? `${v.size} B` : `${(v.size / 1024).toFixed(1)} KB`}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
            <div className={`min-w-0 flex-1 flex-col ${detail ? 'flex' : 'hidden sm:flex'}`}>
              <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2 text-sm">
                <div className="flex rounded-full border border-line bg-raised p-0.5">
                  {(['diff', 'rendered'] as const).map((m) => (
                    <button
                      key={m}
                      className={`rounded-full px-3.5 py-1 text-xs font-medium transition-colors ${
                        mode === m ? 'bg-accent-container text-on-accent-container' : 'text-muted hover:text-ink'
                      }`}
                      onClick={() => setMode(m)}
                    >
                      {m === 'diff' ? tl(lang, 'history.tabDiff') : tl(lang, 'history.tabRendered')}
                    </button>
                  ))}
                </div>
                {ready && mode === 'diff' && (
                  <span className="text-xs tabular-nums">
                    <span className="text-ok">+{stats.added}</span> <span className="text-danger">−{stats.removed}</span>
                  </span>
                )}
                {canRestore && ready && version!.content !== current && (
                  <button className="btn-ghost ml-auto rounded-full border border-line px-3.5 py-1 text-xs hover:border-accent/40 hover:text-accent" onClick={restore}>
                    <RotateCcw size={13} /> {tl(lang, 'common.restore')}
                  </button>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {!ready ? (
                  <div className="p-6 text-center text-faint">{tl(lang, 'common.loading')}</div>
                ) : mode === 'rendered' ? (
                  <div className="px-4 py-3 sm:px-8">
                    <Editor docKey={`history:${version!.id}`} value={version!.content} readOnly />
                  </div>
                ) : !lines.some((l) => l.kind !== 'same') ? (
                  <div className="p-6 text-center text-muted">{tl(lang, 'history.noChanges')}</div>
                ) : (
                  <pre className="min-w-full w-max font-mono text-[13px] leading-6">
                    {lines.map((l, i) => (
                      <div key={i} className={`flex ${l.kind === 'add' ? 'bg-ok/15' : l.kind === 'del' ? 'bg-danger/15' : ''}`}>
                        <span className="w-10 shrink-0 select-none pr-2 text-right text-faint">{l.oldLine ?? ''}</span>
                        <span className="w-10 shrink-0 select-none pr-2 text-right text-faint">{l.newLine ?? ''}</span>
                        <span className={`w-5 shrink-0 select-none text-center ${l.kind === 'add' ? 'text-ok' : l.kind === 'del' ? 'text-danger' : 'text-faint'}`}>
                          {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
                        </span>
                        <span className="whitespace-pre-wrap break-words pr-4">{l.text || ' '}</span>
                      </div>
                    ))}
                  </pre>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
