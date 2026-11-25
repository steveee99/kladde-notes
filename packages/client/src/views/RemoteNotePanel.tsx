/**
 * The document of a remote note: where it comes from, when it was read, and the text itself in a read-only editor that
 * has no way back to the note (no `onChange`) and looks nothing up in the vault.
 */
import type { EditorView } from '@codemirror/view';
import { clearRemoteSource, remoteOwnText, safeUrl } from '@kladde/shared';
import { remoteProblemText, type RemoteNoteView } from '../data/remoteNotes';
import type { LocalNote } from '../data/db';
import { vault } from '../data/vault';
import { Editor } from '../editor/Editor';
import { ExternalLink, GitBranch, Info, Loader2, Pencil, RefreshCw, RemoteDoc } from '../lib/icons';
import { locale, t, useLang } from '../lib/i18n';
import { openDialog } from '../lib/dialogs';

/** `host/group/project/path` without the parts of the address that only the host needs */
function shortSource(view: RemoteNoteView): string {
  const r = view.result;
  if (r.state === 'ok') return `${r.base.host.replace(/^https?:\/\//, '')}/${r.base.project} · ${r.base.path}`;
  return (view.resolved.complete ? view.resolved.url : view.source.source).replace(/^https?:\/\//, '');
}

export function RemoteNotePanel({
  note,
  view,
  canEdit,
  stamp,
  callouts,
  onView,
}: {
  note: LocalNote;
  view: RemoteNoteView;
  /** May change the source */
  canEdit: boolean;
  stamp: number;
  callouts: boolean;
  onView: (view: EditorView | null) => void;
}) {
  const lang = useLang();
  const { result, resolved, loading } = view;
  const href = result.state === 'ok' ? safeUrl(result.url) : resolved.complete && /^https?:/i.test(resolved.url) ? safeUrl(resolved.url) : null;
  const ref = result.state === 'ok' ? (result.base.ref === 'HEAD' ? t('remote.defaultBranch') : result.base.ref) : resolved.ref;
  const short = shortSource(view);
  const ownText = remoteOwnText(note.content);
  const clock = (ms: number) => new Date(ms).toLocaleTimeString(locale(lang), { timeStyle: 'short' });
  const day = (ms: number) => new Date(ms).toLocaleDateString(locale(lang), { dateStyle: 'medium' });
  const stampOf = (ms: number) => new Date(ms).toLocaleString(locale(lang), { dateStyle: 'medium', timeStyle: 'short' });
  const synced = view.sync;
  const reloadLabel = synced || view.source.sync ? t('remote.syncNow') : t('remote.reload');

  return (
    <div data-remote-note data-remote-state={result.state}>
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-panel px-3 py-2 sm:mt-6">
        <RemoteDoc size={18} className="shrink-0 text-muted" />
        <div className="min-w-0 flex-1 basis-56">
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer" className="flex min-w-0 items-center gap-1.5 text-body-m text-acc-hi hover:underline" data-remote-source>
              <span className="truncate" title={href}>
                {short}
              </span>
              <ExternalLink size={14} className="shrink-0" />
            </a>
          ) : (
            <span className="block truncate text-body-m" data-remote-source title={short}>
              {short || t('remote.noSource')}
            </span>
          )}
          <div className="flex flex-wrap items-center gap-x-3 text-caption text-muted">
            <span>{view.source.sync ? t('remote.readOnlySynced') : t('remote.readOnly')}</span>
            {ref && (
              <span className="inline-flex min-w-0 items-center gap-1 font-mono" title={t('remote.ref')}>
                <GitBranch size={12} className="shrink-0" /> <span className="truncate">{ref}</span>
              </span>
            )}
            {result.state === 'ok' && result.commit && (
              <span title={result.commit.id}>
                {t('remote.commit')} <span className="font-mono">{result.commit.id.slice(0, 8)}</span>
                {result.commit.at ? `, ${day(result.commit.at)}` : ''}
              </span>
            )}
            {result.state === 'ok' && !synced && <span data-remote-fetched>{t('remote.fetched', { time: clock(result.fetchedAt) })}</span>}
            {synced && (
              <span data-remote-synced title={result.state === 'ok' ? t('remote.syncedFetched', { time: stampOf(result.fetchedAt) }) : undefined}>
                {t('remote.synced', { time: stampOf(synced.checkedAt) })}
              </span>
            )}
          </div>
        </div>
        <div className="no-print flex shrink-0 items-center gap-1">
          <button type="button" className="btn-icon" onClick={view.reload} disabled={loading} title={reloadLabel} aria-label={reloadLabel} data-remote-reload>
            {loading ? <Loader2 size={18} className="animate-spin" /> : <RefreshCw size={18} />}
          </button>
          {canEdit && (
            <button type="button" className="btn-icon" onClick={() => openDialog({ kind: 'remote', noteId: note.id })} title={t('remote.editSource')} aria-label={t('remote.editSource')} data-remote-edit>
              <Pencil size={18} />
            </button>
          )}
        </div>
      </div>
      {synced?.problem && result.state === 'ok' && (
        <div role="status" className="no-print mt-2 flex flex-wrap items-center gap-2 text-body-s text-amber" data-remote-sync-problem={synced.problem}>
          <Info size={16} className="shrink-0" />
          <span className="min-w-0 flex-1 basis-56">{t('remote.syncFailed', { problem: remoteProblemText(synced.problem) })}</span>
        </div>
      )}
      {ownText && (
        <div className="no-print mt-2 flex flex-wrap items-center gap-2 text-body-s text-muted" data-remote-own-text>
          <Info size={16} className="shrink-0" />
          <span className="min-w-0 flex-1 basis-56">{t('remote.ownText')}</span>
          {canEdit && (
            <button type="button" className="btn-text" onClick={() => confirm(t('remote.ownTextConfirm')) && void vault.update(note.id, { content: clearRemoteSource(note.content) })}>
              {t('remote.ownTextShow')}
            </button>
          )}
        </div>
      )}
      <div className="note-sheet mt-4 border-t border-outline-variant pb-12 pt-6 sm:mt-6 sm:pt-8 print:mt-0 print:border-0 print:pt-0" aria-busy={loading}>
        {result.state === 'ok' ? (
          <Editor docKey={`remote:${note.id}`} value={view.text} readOnly foreign stamp={stamp} onView={onView} callouts={callouts} placeholder={t('remote.empty')} />
        ) : (
          <div role={result.state === 'loading' ? 'status' : 'alert'} className="rounded-lg border border-line bg-panel px-4 py-8 text-center text-body-m text-muted">
            <p>{result.state === 'loading' ? t('remote.loading') : remoteProblemText(result.state)}</p>
            {['offline', 'unreachable', 'busy', 'upstream_limit', 'missing'].includes(result.state) && (
              <button type="button" className="btn-outlined mt-4" onClick={view.reload}>
                {t('online.retry')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
