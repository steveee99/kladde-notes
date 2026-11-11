import { useState, useSyncExternalStore } from 'react';
import { Archive, ArchiveRestore, ArrowDownAZ, ChevronRight, Clock, CornerLeftUp, Folder, FolderPlus, LayoutGrid, List, Plus, Table2, Trash2 } from 'lucide-react';
import { INBOX_FOLDER, archiveTarget, excerpt, extractMeta, projectTitleOf, restoreTarget, splitPath } from '@kladde/shared';
import type { SharedFolder } from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import type { LocalNote } from '../data/db';
import { navigate } from '../lib/router';
import { FolderNameInput, newNote } from './Shell';
import { dragSource, useDropTarget } from '../lib/dnd';
import { describePermissions } from './ShareDialog';
import { Avatar } from './Avatar';
import { folderDisplayName, folderLeafDisplayName, locale, t, useLang, type I18nKey, type Lang } from '../lib/i18n';

export type NoteViewMode = 'cards' | 'list' | 'table';
const VIEW_KEY = 'kladde.noteView';
const viewListeners = new Set<() => void>();
let viewMode: NoteViewMode = (() => {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === 'list' || v === 'table' ? v : 'cards';
  } catch {
    return 'cards';
  }
})();

/** Cards, list or table: one choice for every place that lists notes, remembered on this device */
export function useNoteViewMode(): [NoteViewMode, (m: NoteViewMode) => void] {
  const mode = useSyncExternalStore(
    (l) => {
      viewListeners.add(l);
      return () => viewListeners.delete(l);
    },
    () => viewMode
  );
  return [
    mode,
    (m) => {
      viewMode = m;
      try {
        localStorage.setItem(VIEW_KEY, m);
      } catch {
        /* private mode: keep it for this session only */
      }
      viewListeners.forEach((l) => l());
    },
  ];
}

const MODES: { id: NoteViewMode; labelKey: I18nKey; Icon: typeof List }[] = [
  { id: 'cards', labelKey: 'list.viewCards', Icon: LayoutGrid },
  { id: 'list', labelKey: 'list.viewList', Icon: List },
  { id: 'table', labelKey: 'list.viewTable', Icon: Table2 },
];

export function ViewSwitch() {
  useLang();
  const [mode, setMode] = useNoteViewMode();
  return (
    <div className="inline-flex shrink-0 rounded-xl bg-raised/60 p-0.5" role="group" aria-label={t('list.viewLabel')}>
      {MODES.map(({ id, labelKey, Icon }) => (
        <button
          key={id}
          title={t(labelKey)}
          aria-pressed={mode === id}
          onClick={() => setMode(id)}
          className={`inline-flex h-8 w-8 items-center justify-center rounded-[10px] transition-all duration-150 ${mode === id ? 'bg-surface text-accent shadow-soft' : 'text-muted hover:text-ink'}`}
        >
          <Icon size={16} />
        </button>
      ))}
    </div>
  );
}

const fmtDate = (ts: number, lang: Lang, long = false) =>
  new Date(ts).toLocaleDateString(locale(lang), long ? { day: '2-digit', month: '2-digit', year: 'numeric' } : { day: 'numeric', month: 'short' });

function NoteRow({ note }: { note: LocalNote }) {
  const lang = useLang();
  const meta = extractMeta(note.path, note.content);
  const title = projectTitleOf(note.path, note.content, vault.roleConfig());
  return (
    <li
      role="button"
      tabIndex={0}
      {...(note.access === 'owner' ? dragSource({ kind: 'note', id: note.id }) : {})}
      onClick={() => navigate(`/n/${note.id}`)}
      onKeyDown={(e) => e.key === 'Enter' && navigate(`/n/${note.id}`)}
      className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 transition-colors hover:bg-raised/60"
    >
      <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
      {note.access !== 'owner' && (
        <span className="chip hidden shrink-0 sm:inline-flex">
          <Avatar name={note.owner ?? ''} avatarUrl={note.ownerAvatar} size="xs" /> {note.owner}
        </span>
      )}
      {note.dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" title={t('list.unsynced')} />}
      <span className="hidden max-w-[40%] truncate text-xs text-faint md:inline">{meta.folder ? folderDisplayName(meta.folder, lang) : ''}</span>
      <span className="shrink-0 text-xs text-faint">{fmtDate(note.updatedAt, lang)}</span>
    </li>
  );
}

function NoteTable({ notes }: { notes: LocalNote[] }) {
  const lang = useLang();
  const rc = vault.roleConfig();
  return (
    <div className="card overflow-x-auto scrollbar-thin">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wider text-faint">
            <th className="px-3 py-2 font-semibold">{t('list.colTitle')}</th>
            <th className="px-3 py-2 font-semibold">{t('list.colFolder')}</th>
            <th className="px-3 py-2 font-semibold">{t('list.colTags')}</th>
            <th className="px-3 py-2 font-semibold">{t('list.colCreated')}</th>
            <th className="px-3 py-2 font-semibold">{t('list.colUpdated')}</th>
          </tr>
        </thead>
        <tbody>
          {notes.map((n) => {
            const meta = extractMeta(n.path, n.content);
            const title = projectTitleOf(n.path, n.content, rc);
            return (
              <tr key={n.id} tabIndex={0} onClick={() => navigate(`/n/${n.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/n/${n.id}`)} className="cursor-pointer border-t border-line/60 transition-colors hover:bg-raised/60">
                <td className="max-w-[18rem] truncate px-3 py-2 font-medium">{title}</td>
                <td className="max-w-[12rem] truncate px-3 py-2 text-muted">{meta.folder ? folderDisplayName(meta.folder, lang) : ''}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {meta.tags.slice(0, 4).map((tag) => (
                      <span key={tag} className="cm-tag">
                        #{tag}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-muted">{fmtDate(n.createdAt, lang, true)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-muted">{fmtDate(n.updatedAt, lang, true)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Notes as cards, rows or a table, depending on the chosen view */
export function NoteCollection({ notes, cols = 'sm:grid-cols-2 lg:grid-cols-3' }: { notes: LocalNote[]; cols?: string }) {
  const [mode] = useNoteViewMode();
  if (mode === 'table') return <NoteTable notes={notes} />;
  if (mode === 'list') {
    return (
      <ul className="card stagger divide-y divide-line/60 p-1">
        {notes.map((n) => (
          <NoteRow key={n.id} note={n} />
        ))}
      </ul>
    );
  }
  return (
    <div className={`stagger grid grid-cols-1 gap-3 ${cols}`}>
      {notes.map((n) => (
        <NoteCard key={n.id} note={n} />
      ))}
    </div>
  );
}

export function NoteCard({ note }: { note: LocalNote }) {
  const lang = useLang();
  const meta = extractMeta(note.path, note.content);
  const title = projectTitleOf(note.path, note.content, vault.roleConfig());
  return (
    <div
      role="button"
      tabIndex={0}
      {...(note.access === 'owner' ? dragSource({ kind: 'note', id: note.id }) : {})}
      onClick={() => navigate(`/n/${note.id}`)}
      onKeyDown={(e) => e.key === 'Enter' && navigate(`/n/${note.id}`)}
      className="card group w-full min-w-0 cursor-pointer p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-accent/40"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        {note.access !== 'owner' && (
          <span className="chip max-w-[55%] shrink-0">
            <Avatar name={note.owner ?? ''} avatarUrl={note.ownerAvatar} size="xs" /> <span className="truncate">{note.owner}</span>
          </span>
        )}
        {note.dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" title={t('list.unsynced')} />}
      </div>
      <p className="mt-1 line-clamp-2 break-words text-sm text-muted">{excerpt(note.content) || t('common.empty')}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-faint">
        <span>{fmtDate(note.updatedAt, lang)}</span>
        {meta.tags.slice(0, 4).map((tag) => (
          <span key={tag} className="cm-tag">
            #{tag}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Subfolder row: opens the folder, accepts dropped notes and folders, can itself be dragged */
function FolderRow({ path, count }: { path: string; count: number }) {
  const lang = useLang();
  const drop = useDropTarget(path);
  return (
    <li
      role="button"
      tabIndex={0}
      {...dragSource({ kind: 'folder', path })}
      {...drop.props}
      className={`drop-target flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-raised/60 ${drop.over ? 'drop-over' : ''}`}
      onClick={() => navigate(`/f/${encodeURIComponent(path)}`)}
      onKeyDown={(e) => e.key === 'Enter' && navigate(`/f/${encodeURIComponent(path)}`)}
    >
      <Folder size={17} className="shrink-0 text-accent" />
      <span className="min-w-0 flex-1 truncate font-medium">{folderLeafDisplayName(path, lang)}</span>
      {count > 0 && <span className="text-xs text-faint">{count}</span>}
      <ChevronRight size={16} className="shrink-0 text-faint" />
    </li>
  );
}

/** "Up one level" row, also a drop target for the parent folder */
function ParentRow({ folder }: { folder: string }) {
  const lang = useLang();
  const drop = useDropTarget(folder);
  const label = folder ? folderLeafDisplayName(folder, lang) : t('list.parentLevel');
  return (
    <li
      role="button"
      tabIndex={0}
      {...drop.props}
      className={`drop-target flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-muted transition-colors hover:bg-raised/60 hover:text-ink ${drop.over ? 'drop-over' : ''}`}
      onClick={() => navigate(folder ? `/f/${encodeURIComponent(folder)}` : '/notes')}
      onKeyDown={(e) => e.key === 'Enter' && navigate(folder ? `/f/${encodeURIComponent(folder)}` : '/notes')}
      title={folder ? folderDisplayName(folder, lang) : t('list.parentLevel')}
    >
      <CornerLeftUp size={17} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </li>
  );
}

/** One folder another user shares with me: its notes, and a new note in it when that is allowed */
function SharedFolderSection({ shared, notes }: { shared: SharedFolder; notes: LocalNote[] }) {
  const [creating, setCreating] = useState(false);
  const folderLabel = shared.folder.split('/').pop() ?? shared.folder;
  return (
    <section className="anim-fade-up">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Folder size={16} className="shrink-0 text-accent" />
        <h2 className="min-w-0 truncate font-semibold" title={shared.folder}>
          {folderLabel}
        </h2>
        <span className="chip min-w-0 max-w-full">
          <Avatar name={shared.owner} avatarUrl={shared.ownerAvatar} size="xs" />
          <span className="truncate">
            {shared.owner} · {describePermissions(shared)}
          </span>
        </span>
        {shared.canCreate && !creating && (
          <button className="edit-only btn-ghost ml-auto shrink-0 max-sm:!px-2.5" onClick={() => setCreating(true)}>
            <Plus size={16} /> <span className="hidden sm:inline">{t('nav.newNote')}</span>
          </button>
        )}
      </div>
      {creating && (
        <div className="mb-3">
          <FolderNameInput
            placeholder={t('list.newNoteInSharedPlaceholder', { folder: folderLabel })}
            onDone={(title) => {
              setCreating(false);
              if (title) void vault.createShared(shared, title.replace(/[\\/]/g, '-')).then((n) => navigate(`/n/${n.id}`));
            }}
          />
        </div>
      )}
      {notes.length === 0 ? (
        <p className="px-1 text-sm text-faint">{t('list.emptySharedFolder')}</p>
      ) : (
        <NoteCollection notes={notes} />
      )}
    </section>
  );
}

/** "Shared with me": grouped by the folders shared with me, then single shared notes */
function SharedList({ notes }: { notes: LocalNote[] }) {
  const byFolder = new Map<SharedFolder, LocalNote[]>(vault.sharedFolders.map((f) => [f, []]));
  const single: LocalNote[] = [];
  for (const n of notes) {
    const f = vault.sharedFolderOf(n);
    if (f && byFolder.has(f)) byFolder.get(f)!.push(n);
    else single.push(n);
  }
  if (!notes.length && !vault.sharedFolders.length) return <div className="py-16 text-center text-faint anim-fade-in">{t('list.emptyShared')}</div>;
  return (
    <div className="space-y-8">
      {[...byFolder].map(([f, list]) => (
        <SharedFolderSection key={`${f.owner}/${f.folder}`} shared={f} notes={list} />
      ))}
      {single.length > 0 && (
        <section className="anim-fade-up">
          {byFolder.size > 0 && <h2 className="mb-2 font-semibold">{t('list.singleNotes')}</h2>}
          <NoteCollection notes={single} />
        </section>
      )}
    </div>
  );
}

/** Notes of one folder (with subfolders), all notes, or the ones shared with me */
export function NoteList({ folder, mode }: { folder?: string; mode: 'folder' | 'all' | 'shared' }) {
  useVault();
  const lang = useLang();
  const [sort, setSort] = useState<'updated' | 'title'>('updated');
  const [creating, setCreating] = useState(false);
  const rc = vault.roleConfig();
  let notes = vault.list();
  if (mode === 'shared') notes = notes.filter((n) => n.access !== 'owner');
  else notes = notes.filter((n) => n.access === 'owner');
  if (mode === 'folder' && folder !== undefined) notes = notes.filter((n) => splitPath(n.path).folder === folder);
  notes.sort((a, b) =>
    sort === 'updated'
      ? b.updatedAt - a.updatedAt
      : projectTitleOf(a.path, a.content, rc).localeCompare(projectTitleOf(b.path, b.content, rc), locale(lang), { numeric: true }) ||
        a.path.localeCompare(b.path, locale(lang), { numeric: true })
  );
  const subfolders = mode === 'folder' ? vault.folders().filter((f) => f.startsWith(`${folder}/`) && !f.slice(folder!.length + 1).includes('/')) : [];
  // Notes in a folder and all its subfolders (owned ones, like the list itself)
  const countIn = (f: string) => vault.list().filter((n) => n.access === 'owner' && (splitPath(n.path).folder === f || splitPath(n.path).folder.startsWith(`${f}/`))).length;
  const parent = mode === 'folder' && folder ? (folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '') : null;
  const title = mode === 'all' ? t('list.allNotes') : mode === 'shared' ? t('list.sharedWithMe') : folder ? folderLeafDisplayName(folder, lang) : t('list.parentLevel');
  const features = vault.features();
  const archiveRoot = features.para.folders.archive;
  const restoreDest = mode === 'folder' && folder && features.para.enabled ? restoreTarget(folder, archiveRoot) : null;
  const protectedFolders = new Set<string>([INBOX_FOLDER]);
  if (features.para.enabled) {
    protectedFolders.add(features.para.folders.projects);
    protectedFolders.add(features.para.folders.areas);
    protectedFolders.add(features.para.folders.resources);
    protectedFolders.add(features.para.folders.archive);
  }
  if (features.zettel.enabled) protectedFolders.add(features.zettel.folder);

  return (
    <div className="content-container mx-auto px-4 py-6 sm:px-8 sm:py-10">
      <div className="mb-6 flex flex-wrap items-center gap-2 anim-fade-up">
        <div className="min-w-0 flex-1 basis-40">
          {mode === 'folder' && folder && folder.includes('/') && (
            <p className="truncate text-sm text-faint">
              {folderDisplayName(folder.split('/').slice(0, -1).join('/'), lang).replace(/\//g, ' / ')}
            </p>
          )}
          <h1 className="truncate text-2xl font-bold tracking-tight">{title}</h1>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <ViewSwitch />
          <button className="btn-icon shrink-0" title={t('list.sortTooltip')} onClick={() => setSort(sort === 'updated' ? 'title' : 'updated')}>
            {sort === 'updated' ? <Clock size={18} /> : <ArrowDownAZ size={18} />}
          </button>
          {mode === 'folder' && folder && features.para.enabled && folder !== archiveRoot && (
            restoreDest !== null ? (
              <button
                className="edit-only btn-ghost shrink-0 max-sm:!px-2.5"
                title={t('para.restoreTitle', { folder: restoreDest ? folderDisplayName(restoreDest, lang) : t('common.topLevelPlain') })}
                onClick={() => void vault.restoreFolder(folder).then(() => navigate(restoreDest ? `/f/${encodeURIComponent(restoreDest)}` : '/notes', true))}
              >
                <ArchiveRestore size={16} /> <span className="hidden sm:inline">{t('para.restoreBtn')}</span>
              </button>
            ) : (
              !protectedFolders.has(folder) && (
                <button
                  className="edit-only btn-ghost shrink-0 max-sm:!px-2.5"
                  title={t('list.archiveFolderTitle')}
                  onClick={() =>
                    confirm(t('list.archiveFolderConfirm', { folder: folderDisplayName(folder, lang) })) &&
                    void vault.archiveFolder(folder).then(() => navigate(`/f/${encodeURIComponent(archiveTarget(folder, archiveRoot))}`, true))
                  }
                >
                  <Archive size={16} /> <span className="hidden sm:inline">{t('para.archiveBtn')}</span>
                </button>
              )
            )
          )}
          {mode === 'folder' && folder && !protectedFolders.has(folder) && folder !== features.daily.folder && (
            <button
              className="edit-only btn-ghost shrink-0 hover:text-danger max-sm:!px-2.5"
              title={t('list.deleteFolderTitle')}
              onClick={() => {
                const n = vault.notesInFolder(folder);
                const name = folderDisplayName(folder, lang);
                if (!confirm(n ? t('list.deleteFolderConfirm', { folder: name, n }) : t('list.deleteEmptyFolderConfirm', { folder: name }))) return;
                const up = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';
                void vault.deleteFolderWithNotes(folder).then((ok) => ok && navigate(up ? `/f/${encodeURIComponent(up)}` : '/notes', true));
              }}
            >
              <Trash2 size={16} /> <span className="hidden sm:inline">{t('list.deleteFolderBtn')}</span>
            </button>
          )}
          {mode !== 'shared' && (
            <button className="edit-only btn-primary shrink-0 rounded-full px-4 max-sm:!px-3.5" onClick={() => newNote(folder)}>
              <Plus size={16} /> {t('list.newBtn')}
            </button>
          )}
        </div>
      </div>
      {mode === 'folder' && (
        <ul className="card mb-6 divide-y divide-line/60 p-1 anim-fade-up">
          {parent !== null && <ParentRow folder={parent} />}
          {subfolders.map((f) => (
            <FolderRow key={f} path={f} count={countIn(f)} />
          ))}
          {creating ? (
            <li className="px-1 py-1">
              <FolderNameInput
                placeholder={t('list.subfolderPlaceholder')}
                onDone={(name) => {
                  setCreating(false);
                  if (name) void vault.addFolder(`${folder}/${name.replace(/\//g, '-')}`);
                }}
              />
            </li>
          ) : (
            <li className="edit-only">
              <button className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-muted transition-colors hover:bg-raised/60 hover:text-ink" onClick={() => setCreating(true)}>
                <FolderPlus size={17} className="shrink-0" /> {t('list.subfolderAdd')}
              </button>
            </li>
          )}
        </ul>
      )}
      {mode === 'shared' ? (
        <SharedList notes={notes} />
      ) : notes.length === 0 ? (
        <div className="py-16 text-center text-faint anim-fade-in">{t('list.emptyFolder')}</div>
      ) : (
        <NoteCollection notes={notes} />
      )}
    </div>
  );
}
