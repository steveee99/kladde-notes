import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AttachmentInfo, AttachmentNoteRef, projectTitleOf } from '@kladde/shared';
import {
  AlertTriangle,
  Check,
  CheckSquare,
  ExternalLink,
  FileText,
  Images,
  Loader2,
  Lock,
  Maximize2,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useVault, vault } from '../data/vault';
import { deleteFiles, listFiles } from '../lib/api';
import { locale, t, tl, useLang } from '../lib/i18n';
import { useReadOnly } from '../lib/readOnly';
import { navigate } from '../lib/router';
import { Sheet } from './Dialogs';

type FilterMode = 'all' | 'unused';

const FILE_ID_RE = /\/api\/files\/([A-Za-z0-9_-]{22})/g;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FilesView() {
  const vaultVersion = useVault();
  const lang = useLang();
  const loc = locale(lang);
  const dateFmt = useMemo(() => new Intl.DateTimeFormat(loc, { day: '2-digit', month: '2-digit', year: 'numeric' }), [loc]);
  const locked = useReadOnly();
  const [items, setItems] = useState<AttachmentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState<FilterMode>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [preview, setPreview] = useState<AttachmentInfo | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      if (vault.pendingCount() > 0 && (navigator.onLine || vault.standalone)) {
        await vault.sync();
      }
      const data = await listFiles();
      setItems(data);
      setSelected((prev) => {
        const validIds = new Set(data.filter((f) => f.usedIn.length === 0).map((f) => f.id));
        const next = new Set<string>();
        for (const id of prev) if (validIds.has(id)) next.add(id);
        return next;
      });
    } catch (e) {
      setError(navigator.onLine || vault.standalone ? (e as Error).message : t('files.onlineOnlyError'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreview(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview]);

  // Also cross-check local dirty/cached notes so unsynced note edits still protect attachments immediately
  const localUsage = useMemo(() => {
    const map = new Map<string, AttachmentNoteRef[]>();
    const rc = vault.roleConfig();
    for (const n of vault.list()) {
      const ids = new Set<string>();
      for (const m of n.content.matchAll(FILE_ID_RE)) ids.add(m[1]);
      if (!ids.size) continue;
      const title = projectTitleOf(n.path, n.content, rc);
      for (const fid of ids) {
        let list = map.get(fid);
        if (!list) map.set(fid, (list = []));
        list.push({ id: n.id, path: n.path, title });
      }
    }
    return map;
  }, [vaultVersion]);

  const enriched = useMemo(
    () =>
      items.map((item) => {
        const localRefs = localUsage.get(item.id) ?? [];
        if (localRefs.length === 0) return item;
        const merged = new Map<string, AttachmentNoteRef>();
        for (const r of item.usedIn) merged.set(r.id, r);
        for (const r of localRefs) merged.set(r.id, r);
        return { ...item, usedIn: [...merged.values()] };
      }),
    [items, localUsage]
  );

  // Drop any selections that became referenced locally
  useEffect(() => {
    const usedIds = new Set(enriched.filter((f) => f.usedIn.length > 0).map((f) => f.id));
    setSelected((prev) => {
      let changed = false;
      for (const id of prev) if (usedIds.has(id)) changed = true;
      if (!changed) return prev;
      const next = new Set<string>();
      for (const id of prev) if (!usedIds.has(id)) next.add(id);
      return next;
    });
  }, [enriched]);

  const unusedCount = useMemo(() => enriched.filter((f) => f.usedIn.length === 0).length, [enriched]);
  const totalBytes = useMemo(() => enriched.reduce((sum, f) => sum + f.size, 0), [enriched]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return enriched.filter((f) => {
      if (filter === 'unused' && f.usedIn.length > 0) return false;
      if (!q) return true;
      return f.name.toLowerCase().includes(q) || f.usedIn.some((n) => n.title.toLowerCase().includes(q) || n.path.toLowerCase().includes(q));
    });
  }, [enriched, filter, search]);

  const visibleUnused = useMemo(() => visible.filter((f) => f.usedIn.length === 0), [visible]);
  const allVisibleUnusedSelected = visibleUnused.length > 0 && visibleUnused.every((f) => selected.has(f.id));

  const selectedItems = useMemo(() => enriched.filter((f) => selected.has(f.id) && f.usedIn.length === 0), [enriched, selected]);
  const selectedBytes = useMemo(() => selectedItems.reduce((sum, f) => sum + f.size, 0), [selectedItems]);

  const toggleSelect = (item: AttachmentInfo) => {
    if (item.usedIn.length > 0 || locked) return;
    setNotice('');
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  };

  const toggleSelectAllUnused = () => {
    if (locked) return;
    setNotice('');
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleUnusedSelected) {
        for (const f of visibleUnused) next.delete(f.id);
      } else {
        for (const f of visibleUnused) next.add(f.id);
      }
      return next;
    });
  };

  const confirmDelete = async () => {
    if (!selectedItems.length || deleting || locked) return;
    setDeleting(true);
    setError('');
    setNotice('');
    try {
      const ids = selectedItems.map((f) => f.id);
      const res = await deleteFiles(ids);
      setConfirmOpen(false);
      await load();
      const parts: string[] = [];
      if (res.deleted.length > 0) {
        parts.push(
          tl(lang, 'files.deletedResult', {
            count: res.deleted.length,
            unit: res.deleted.length === 1 ? tl(lang, 'files.unitSingle') : tl(lang, 'files.unitPlural'),
          })
        );
      }
      if (res.skippedUsed.length > 0) {
        parts.push(tl(lang, 'files.skippedUsedResult', { count: res.skippedUsed.length }));
      }
      setNotice(parts.join(' '));
      setSelected(new Set());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="content-container space-y-5 px-4 py-6 sm:px-8 sm:py-10">
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight">
            <Images size={24} className="text-accent" />
            {tl(lang, 'files.title')}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {tl(lang, 'files.summary', {
              count: enriched.length,
              unit: enriched.length === 1 ? tl(lang, 'files.unitSingle') : tl(lang, 'files.unitPlural'),
              size: formatBytes(totalBytes),
              unused: unusedCount,
            })}
          </p>
        </div>
        <button className="btn-ghost rounded-full border border-line px-4" onClick={() => void load()} disabled={loading} title={tl(lang, 'files.refreshTitle')}>
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          <span className="hidden sm:inline">{tl(lang, 'files.refresh')}</span>
        </button>
      </header>

      {locked && (
        <div className="flex items-center gap-2 rounded-2xl border border-line bg-raised px-3.5 py-2.5 text-sm text-muted">
          <Lock size={16} className="shrink-0 text-accent" />
          {tl(lang, 'files.lockedHint')}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-2xl bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
          <AlertTriangle size={16} className="shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {notice && (
        <div className="flex items-center justify-between gap-2 rounded-2xl bg-accent-container/40 px-3.5 py-2.5 text-sm text-on-accent-container">
          <span>{notice}</span>
          <button className="rounded-full p-1 hover:bg-accent/15" onClick={() => setNotice('')} aria-label={tl(lang, 'files.closeNotice')}>
            <X size={14} />
          </button>
        </div>
      )}

      {/* Filter, Search & Multiselect Action Bar */}
      <div className="card space-y-3 p-3.5 sm:p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Filter" className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setFilter('all')}
              aria-pressed={filter === 'all'}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors ${
                filter === 'all' ? 'border-accent/50 bg-accent-container text-on-accent-container' : 'border-line text-muted hover:border-faint hover:text-ink'
              }`}
            >
              {tl(lang, 'files.filterAll')}
              <span className="rounded-full bg-bg/40 px-1.5 py-0.5 text-xs tabular-nums">{enriched.length}</span>
            </button>
            <button
              type="button"
              onClick={() => setFilter('unused')}
              aria-pressed={filter === 'unused'}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors ${
                filter === 'unused' ? 'border-accent/50 bg-accent-container text-on-accent-container' : 'border-line text-muted hover:border-faint hover:text-ink'
              }`}
            >
              {tl(lang, 'files.filterUnused')}
              <span className="rounded-full bg-bg/40 px-1.5 py-0.5 text-xs tabular-nums">{unusedCount}</span>
            </button>
          </div>

          <div className="relative min-w-[200px] flex-1">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
            <input
              type="search"
              className="input rounded-full py-1.5 pl-9 text-sm"
              placeholder={tl(lang, 'files.filterPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-ghost rounded-full border border-line px-3.5 text-xs sm:text-sm"
              disabled={locked || visibleUnused.length === 0}
              onClick={toggleSelectAllUnused}
            >
              <CheckSquare size={15} />
              {allVisibleUnusedSelected ? tl(lang, 'files.deselectVisible') : tl(lang, 'files.selectUnused', { n: visibleUnused.length })}
            </button>
            {selectedItems.length > 0 && (
              <button type="button" className="btn-ghost rounded-full px-3 text-xs sm:text-sm" onClick={() => setSelected(new Set())}>
                {tl(lang, 'files.clearSelection', { n: selectedItems.length })}
              </button>
            )}
          </div>

          <button
            type="button"
            disabled={locked || selectedItems.length === 0 || deleting}
            onClick={() => setConfirmOpen(true)}
            className="btn rounded-full bg-danger px-4 text-bg shadow-soft hover:brightness-110 disabled:opacity-40"
          >
            <Trash2 size={16} />
            {tl(lang, 'common.delete')}
            {selectedItems.length > 0 ? ` (${selectedItems.length})` : ''}
          </button>
        </div>
      </div>

      {/* Gallery Grid */}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-muted">
          <Loader2 size={20} className="animate-spin" /> {tl(lang, 'files.loading')}
        </div>
      ) : visible.length === 0 ? (
        <div className="card p-10 text-center text-muted">
          {enriched.length === 0 ? tl(lang, 'files.emptyNone') : filter === 'unused' ? tl(lang, 'files.emptyAllUsed') : tl(lang, 'files.emptyNoMatch')}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {visible.map((file) => {
            const used = file.usedIn.length > 0;
            const isSelected = !used && selected.has(file.id);
            const isImage = file.mime.startsWith('image/');
            return (
              <article
                key={file.id}
                onClick={() => {
                  if (!used && !locked) toggleSelect(file);
                }}
                className={`card group relative flex flex-col overflow-hidden transition-all ${
                  used
                    ? 'border-line/90'
                    : isSelected
                      ? 'cursor-pointer border-accent ring-2 ring-accent/40 bg-accent-container/15'
                      : locked
                        ? ''
                        : 'cursor-pointer hover:border-accent/50'
                }`}
              >
                {/* Preview area */}
                <div className="relative aspect-[4/3] w-full overflow-hidden bg-raised">
                  {isImage ? (
                    <img
                      src={file.url}
                      alt={file.name}
                      loading="lazy"
                      className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                      onClick={(e) => {
                        if (used || locked) {
                          e.stopPropagation();
                          setPreview(file);
                        }
                      }}
                    />
                  ) : (
                    <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-3 text-center text-muted">
                      <FileText size={32} className="text-accent" />
                      <span className="text-xs font-semibold uppercase tracking-wide">PDF</span>
                      <a
                        href={file.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1 rounded-full bg-surface px-3 py-1 text-xs font-medium text-ink shadow-sm hover:text-accent"
                      >
                        {tl(lang, 'common.open')} <ExternalLink size={12} />
                      </a>
                    </div>
                  )}

                  {/* Top-left: Selection checkbox (unused) OR Protected Lock badge (used) */}
                  {used ? (
                    <span
                      title={tl(lang, 'files.protectedTitle')}
                      className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-bg/90 px-2 py-1 text-[11px] font-medium text-ink shadow-sm backdrop-blur-sm"
                    >
                      <Lock size={11} className="text-accent" />
                      {tl(lang, 'files.protectedBadge')}
                    </span>
                  ) : (
                    !locked && (
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={isSelected}
                        aria-label={tl(lang, 'files.selectAria', { name: file.name })}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleSelect(file);
                        }}
                        className={`absolute left-2 top-2 flex h-7 w-7 items-center justify-center rounded-lg border transition-colors shadow-sm ${
                          isSelected ? 'border-accent bg-accent text-on-accent' : 'border-line bg-bg/85 text-transparent hover:border-accent backdrop-blur-sm'
                        }`}
                      >
                        <Check size={15} strokeWidth={3} />
                      </button>
                    )
                  )}

                  {/* Top-right: Lightbox preview button */}
                  {isImage && (
                    <button
                      type="button"
                      title={tl(lang, 'files.enlargeTitle')}
                      aria-label={tl(lang, 'files.enlargeAria', { name: file.name })}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPreview(file);
                      }}
                      className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-lg bg-bg/85 text-ink opacity-90 shadow-sm backdrop-blur-sm transition-opacity hover:text-accent sm:opacity-0 sm:group-hover:opacity-100"
                    >
                      <Maximize2 size={14} />
                    </button>
                  )}
                </div>

                {/* Metadata & Usage references */}
                <div className="flex flex-1 flex-col gap-1.5 p-3">
                  <div className="truncate text-sm font-medium" title={file.name}>
                    {file.name}
                  </div>
                  <div className="text-xs text-faint">
                    {formatBytes(file.size)} · {dateFmt.format(file.createdAt)}
                  </div>

                  {used ? (
                    <div className="mt-auto flex flex-col gap-1 pt-1">
                      <span className="text-[11px] font-medium text-muted">
                        {tl(lang, 'files.usedIn', {
                          count: file.usedIn.length,
                          unit: file.usedIn.length === 1 ? tl(lang, 'files.noteSingle') : tl(lang, 'files.notePlural'),
                        })}
                      </span>
                      <div className="flex flex-wrap gap-1">
                        {file.usedIn.slice(0, 2).map((ref) => (
                          <button
                            key={ref.id}
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate(`/n/${ref.id}`);
                            }}
                            title={ref.path}
                            className="inline-flex max-w-full items-center gap-1 rounded-md bg-raised px-1.5 py-0.5 text-[11px] text-accent hover:bg-accent/15"
                          >
                            <FileText size={10} className="shrink-0" />
                            <span className="truncate">{ref.title}</span>
                          </button>
                        ))}
                        {file.usedIn.length > 2 && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setPreview(file);
                            }}
                            className="rounded-md bg-raised px-1.5 py-0.5 text-[11px] text-muted hover:text-ink"
                          >
                            {tl(lang, 'files.moreRefs', { n: file.usedIn.length - 2 })}
                          </button>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="mt-auto pt-1 text-[11px] font-medium text-warn">{tl(lang, 'files.unusedBadge')}</div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Confirmation Sheet */}
      {confirmOpen && (
        <Sheet title={tl(lang, 'files.deleteSheetTitle')} onClose={() => !deleting && setConfirmOpen(false)}>
          <p className="mb-3 text-sm text-muted">
            {tl(lang, 'files.deleteSheetDescBefore')} <b>{selectedItems.length}</b>{' '}
            {selectedItems.length === 1 ? tl(lang, 'files.deleteSheetFileSingle') : tl(lang, 'files.deleteSheetFilePlural')} ({formatBytes(selectedBytes)}){' '}
            {tl(lang, 'files.deleteSheetDescAfter')}
          </p>
          <ul className="mb-4 max-h-48 divide-y divide-line overflow-y-auto rounded-2xl border border-line bg-raised/50 px-3 scrollbar-thin">
            {selectedItems.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                <span className="truncate">{item.name}</span>
                <span className="shrink-0 text-xs text-faint">{formatBytes(item.size)}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className="btn-ghost rounded-full px-4" disabled={deleting} onClick={() => setConfirmOpen(false)}>
              {tl(lang, 'common.cancel')}
            </button>
            <button
              type="button"
              className="btn rounded-full bg-danger px-4 text-bg shadow-soft hover:brightness-110"
              disabled={deleting}
              onClick={() => void confirmDelete()}
            >
              {deleting ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
              {deleting ? tl(lang, 'files.deleting') : tl(lang, 'files.confirmDeleteBtn')}
            </button>
          </div>
        </Sheet>
      )}

      {/* Fullscreen Preview / Detail Lightbox */}
      {preview &&
        createPortal(
          <div className="wz-lightbox anim-fade-in" onClick={() => setPreview(null)}>
            <div
              className="flex max-h-[90vh] w-full max-w-3xl cursor-default flex-col gap-3 rounded-3xl bg-surface p-4 text-ink shadow-soft"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{preview.name}</div>
                  <div className="text-xs text-muted">
                    {formatBytes(preview.size)} · {dateFmt.format(preview.createdAt)} · {preview.mime}
                  </div>
                </div>
                <a href={preview.url} target="_blank" rel="noopener noreferrer" className="btn-ghost rounded-full border border-line px-3 text-xs">
                  <ExternalLink size={14} /> {tl(lang, 'common.open')}
                </a>
                <button type="button" className="btn-icon" onClick={() => setPreview(null)} aria-label={tl(lang, 'files.closePreviewAria')}>
                  <X size={18} />
                </button>
              </div>
              {preview.mime.startsWith('image/') && (
                <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-2xl bg-raised p-2">
                  <img src={preview.url} alt={preview.name} className="max-h-[65vh] max-w-full rounded-xl object-contain" />
                </div>
              )}
              {preview.usedIn.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="inline-flex items-center gap-1 text-muted">
                    <Lock size={12} className="text-accent" /> {tl(lang, 'files.usedInShort')}
                  </span>
                  {preview.usedIn.map((ref) => (
                    <button
                      key={ref.id}
                      type="button"
                      onClick={() => {
                        setPreview(null);
                        navigate(`/n/${ref.id}`);
                      }}
                      className="rounded-lg bg-raised px-2 py-1 text-accent hover:bg-accent/15"
                    >
                      {ref.path}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-warn">{tl(lang, 'files.unusedDetail')}</div>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
