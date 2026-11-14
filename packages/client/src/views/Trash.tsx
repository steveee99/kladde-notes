/**
 * Trash (#25): the deleted notes of the own space. Restore puts a note back at its old path (or asks for
 * a new one when that path is taken), a folder deletion restores as one unit, and "Delete for good" /
 * "Empty trash" purge notes with their history. The server purges old entries on its own.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { splitPath, type TrashConflict, type TrashEntry } from '@kladde/shared';
import { AlertTriangle, ChevronDown, ChevronRight, FileText, Folder, Loader2, RefreshCw, Trash2, Undo2 } from '../lib/icons';
import { ApiError, emptyTrash, listTrash, purgeTrash, restoreTrash, restoreTrashBatch, type RestoreResult } from '../lib/api';
import { vault } from '../data/vault';
import { folderDisplayName, locale, t, useLang } from '../lib/i18n';
import { useReadOnly } from '../lib/readOnly';
import { navigate } from '../lib/router';
import { Sheet } from './Dialogs';

const DAY_MS = 24 * 60 * 60 * 1000;

/** One row of the list: a single note, or every note of one folder deletion */
type Group = { kind: 'note'; entry: TrashEntry } | { kind: 'folder'; batch: string; folder: string; entries: TrashEntry[]; deletedAt: number; deletedBy: string | null };

function groupEntries(entries: TrashEntry[]): Group[] {
  const groups: Group[] = [];
  const batches = new Map<string, Extract<Group, { kind: 'folder' }>>();
  for (const entry of entries) {
    if (!entry.batch) {
      groups.push({ kind: 'note', entry });
      continue;
    }
    let g = batches.get(entry.batch);
    if (!g) {
      g = { kind: 'folder', batch: entry.batch, folder: entry.folder ?? splitPath(entry.path).folder, entries: [], deletedAt: entry.deletedAt, deletedBy: entry.deletedBy };
      batches.set(entry.batch, g);
      groups.push(g);
    }
    g.entries.push(entry);
  }
  return groups;
}

export function TrashView() {
  const lang = useLang();
  const locked = useReadOnly();
  const dateFmt = useMemo(() => new Intl.DateTimeFormat(locale(lang), { dateStyle: 'medium', timeStyle: 'short' }), [lang]);
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [retentionDays, setRetentionDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ text: string; noteId?: string } | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [conflict, setConflict] = useState<{ entry: TrashEntry; path: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // Deletions still waiting on this device belong in the list too
      if (vault.pendingCount() > 0 && (navigator.onLine || vault.standalone)) await vault.sync();
      const list = await listTrash();
      setEntries(list.entries);
      setRetentionDays(list.retentionDays);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('trash.offline'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => groupEntries(entries), [entries]);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError('');
    setNotice(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const restored = async (res: RestoreResult) => {
    // Pull right away so the notes are back in the lists before the user navigates
    await vault.sync().catch(() => {});
    const ids = new Set(res.restored.map((r) => r.id));
    setEntries((list) => list.filter((e) => !ids.has(e.id)));
    if (res.restored.length === 1) setNotice({ text: t('trash.restored', { name: splitPath(res.restored[0].path).name }), noteId: res.restored[0].id });
    else setNotice({ text: t('trash.restoredMany', { n: res.restored.length }) });
  };

  const restoreOne = (entry: TrashEntry, path?: string) =>
    run(entry.id, async () => {
      try {
        await restored(await restoreTrash(entry.id, path));
        setConflict(null);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) setConflict({ entry, path: (err.data as TrashConflict).suggestion });
        else throw err;
      }
    });

  const purge = (ids: string[], question: string) => {
    if (!confirm(question)) return;
    void run(ids.join(','), async () => {
      for (const id of ids) await purgeTrash(id);
      setEntries((list) => list.filter((e) => !ids.includes(e.id)));
    });
  };

  const meta = (deletedAt: number, deletedBy: string | null) => {
    const parts = [t('trash.deletedAt', { date: dateFmt.format(deletedAt) })];
    if (deletedBy) parts.push(t('trash.deletedBy', { user: deletedBy }));
    if (retentionDays > 0) parts.push(t('trash.daysLeft', { n: Math.max(0, Math.ceil((deletedAt + retentionDays * DAY_MS - Date.now()) / DAY_MS)) }));
    return parts.join(' · ');
  };

  const actions = (key: string, onRestore: () => void, onPurge: () => void, restoreLabel = t('trash.restore')) => (
    <div className="flex shrink-0 flex-wrap items-center gap-1">
      <button type="button" className="btn-tonal h-9 !px-3" disabled={locked || busy !== null} onClick={onRestore}>
        {busy === key ? <Loader2 size={16} className="animate-spin" /> : <Undo2 size={16} />}
        <span className="max-sm:hidden">{restoreLabel}</span>
      </button>
      <button type="button" className="btn-icon h-9 w-9" disabled={locked || busy !== null} onClick={onPurge} title={t('trash.purge')} aria-label={t('trash.purge')}>
        <Trash2 size={18} />
      </button>
    </div>
  );

  return (
    <div className="content-container space-y-5 px-4 py-6 sm:px-8 sm:py-10">
      <div className="flex flex-wrap items-center gap-2 anim-fade-up">
        <h1 className="min-w-0 flex-1 text-headline-m">{t('trash.title')}</h1>
        <button type="button" className="btn-icon" onClick={() => void load()} title={t('files.refreshTitle')} aria-label={t('files.refreshTitle')} disabled={loading}>
          <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
        </button>
        {entries.length > 0 && (
          <button
            type="button"
            className="btn-outlined"
            disabled={locked || busy !== null}
            onClick={() => {
              if (!confirm(t('trash.emptyConfirm', { n: entries.length }))) return;
              void run('all', async () => {
                await emptyTrash();
                setEntries([]);
              });
            }}
          >
            <Trash2 size={16} /> {t('trash.emptyBtn')}
          </button>
        )}
      </div>
      <p className="text-body-m text-on-surface-variant anim-fade-up">{retentionDays > 0 ? t('trash.intro', { days: retentionDays }) : t('trash.introForever')}</p>

      {error && (
        <div role="alert" className="flex items-center gap-2 rounded-2xl bg-error-container px-4 py-3 text-sm text-on-error-container">
          <AlertTriangle size={16} className="shrink-0" /> {error}
        </div>
      )}
      {notice && (
        <div role="status" className="flex items-center gap-3 rounded-2xl bg-secondary-container px-4 py-3 text-sm text-on-secondary-container">
          <span className="min-w-0 flex-1">{notice.text}</span>
          {notice.noteId && (
            <button type="button" className="btn-text h-8 !px-3" onClick={() => navigate(`/n/${notice.noteId}`)}>
              {t('trash.open')}
            </button>
          )}
        </div>
      )}

      {loading && entries.length === 0 ? (
        <div className="flex justify-center py-10 text-on-surface-variant">
          <Loader2 size={20} className="animate-spin" />
        </div>
      ) : groups.length === 0 && !error ? (
        <p className="py-10 text-center text-on-surface-variant">{t('trash.empty')}</p>
      ) : (
        <ul className="card divide-y divide-outline-variant/60 p-1 anim-fade-up">
          {groups.map((g) => {
            if (g.kind === 'note') {
              const { folder, name } = splitPath(g.entry.path);
              return (
                <li key={g.entry.id} className="flex items-center gap-3 px-3 py-2.5">
                  <FileText size={18} className="shrink-0 text-on-surface-variant" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{name}</div>
                    <div className="truncate text-xs text-on-surface-variant">
                      {folder ? `${folderDisplayName(folder, lang)} · ` : ''}
                      {meta(g.entry.deletedAt, g.entry.deletedBy)}
                    </div>
                  </div>
                  {actions(
                    g.entry.id,
                    () => void restoreOne(g.entry),
                    () => purge([g.entry.id], t('trash.purgeConfirm', { name }))
                  )}
                </li>
              );
            }
            const expanded = open.has(g.batch);
            const ids = g.entries.map((e) => e.id);
            return (
              <li key={g.batch} className="px-3 py-2.5">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    className="btn-icon h-8 w-8 shrink-0"
                    aria-expanded={expanded}
                    aria-label={t('trash.folderLabel', { folder: g.folder })}
                    onClick={() =>
                      setOpen((s) => {
                        const next = new Set(s);
                        if (expanded) next.delete(g.batch);
                        else next.add(g.batch);
                        return next;
                      })
                    }
                  >
                    {expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                  </button>
                  <Folder size={18} className="-ml-1 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">
                      {t('trash.folderLabel', { folder: folderDisplayName(g.folder, lang) })} <span className="font-normal text-on-surface-variant">· {g.entries.length}</span>
                    </div>
                    <div className="truncate text-xs text-on-surface-variant">{meta(g.deletedAt, g.deletedBy)}</div>
                  </div>
                  {actions(
                    ids.join(','),
                    () => void run(ids.join(','), async () => restored(await restoreTrashBatch(g.batch))),
                    () => purge(ids, t('trash.purgeFolderConfirm', { n: ids.length, folder: g.folder })),
                    t('trash.restoreFolder', { n: g.entries.length })
                  )}
                </div>
                {expanded && (
                  <ul className="ml-12 mt-1 space-y-0.5 text-sm text-on-surface-variant">
                    {g.entries.map((e) => (
                      <li key={e.id} className="truncate" title={e.path}>
                        {e.path}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {conflict && (
        <Sheet title={t('trash.restore')} onClose={() => setConflict(null)}>
          <p className="mb-3 text-sm text-on-surface-variant">{t('trash.pathTaken', { path: conflict.entry.path })}</p>
          <input
            className="input mb-4"
            value={conflict.path}
            onChange={(e) => setConflict({ ...conflict, path: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && conflict.path.trim() && void restoreOne(conflict.entry, conflict.path.trim())}
            autoFocus
          />
          <button
            type="button"
            className="btn-primary w-full rounded-full py-2.5"
            disabled={!conflict.path.trim() || busy !== null}
            onClick={() => void restoreOne(conflict.entry, conflict.path.trim())}
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Undo2 size={16} />} {t('trash.restore')}
          </button>
        </Sheet>
      )}
    </div>
  );
}
