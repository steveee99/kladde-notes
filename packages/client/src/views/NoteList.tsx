import { useState, useSyncExternalStore } from 'react';
import { Archive, ArchiveRestore, ArrowDownAZ, ChevronRight, Clock, CornerLeftUp, Folder, FolderPlus, LayoutGrid, List, Plus, Table2, Users } from 'lucide-react';
import { PARA, archiveTarget, excerpt, extractMeta, restoreTarget, splitPath } from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import type { LocalNote } from '../data/db';
import { navigate } from '../lib/router';
import { FolderNameInput, newNote } from './Shell';
import { dragSource, useDropTarget } from '../lib/dnd';
import { describePermissions } from './ShareDialog';
import type { SharedFolder } from '@kladde/shared';

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

const MODES: { id: NoteViewMode; label: string; Icon: typeof List }[] = [
  { id: 'cards', label: 'Kacheln', Icon: LayoutGrid },
  { id: 'list', label: 'Liste', Icon: List },
  { id: 'table', label: 'Tabelle', Icon: Table2 },
];

export function ViewSwitch() {
  const [mode, setMode] = useNoteViewMode();
  return (
    <div className="inline-flex shrink-0 rounded-xl bg-raised/60 p-0.5" role="group" aria-label="Ansicht">
      {MODES.map(({ id, label, Icon }) => (
        <button
          key={id}
          title={label}
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

const fmtDate = (t: number, long = false) => new Date(t).toLocaleDateString('de-DE', long ? { day: '2-digit', month: '2-digit', year: 'numeric' } : { day: 'numeric', month: 'short' });

function NoteRow({ note }: { note: LocalNote }) {
  const meta = extractMeta(note.path, note.content);
  return (
    <li
      role="button"
      tabIndex={0}
      {...(note.access === 'owner' ? dragSource({ kind: 'note', id: note.id }) : {})}
      onClick={() => navigate(`/n/${note.id}`)}
      onKeyDown={(e) => e.key === 'Enter' && navigate(`/n/${note.id}`)}
      className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 transition-colors hover:bg-raised/60"
    >
      <span className="min-w-0 flex-1 truncate font-medium">{meta.title}</span>
      {note.access !== 'owner' && (
        <span className="chip hidden sm:inline-flex">
          <Users size={11} /> {note.owner}
        </span>
      )}
      {note.dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" title="Noch nicht synchronisiert" />}
      <span className="hidden max-w-[40%] truncate text-xs text-faint md:inline">{meta.folder}</span>
      <span className="shrink-0 text-xs text-faint">{fmtDate(note.updatedAt)}</span>
    </li>
  );
}

function NoteTable({ notes }: { notes: LocalNote[] }) {
  return (
    <div className="card overflow-x-auto scrollbar-thin">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wider text-faint">
            <th className="px-3 py-2 font-semibold">Titel</th>
            <th className="px-3 py-2 font-semibold">Ordner</th>
            <th className="px-3 py-2 font-semibold">Tags</th>
            <th className="px-3 py-2 font-semibold">Erstellt</th>
            <th className="px-3 py-2 font-semibold">Geändert</th>
          </tr>
        </thead>
        <tbody>
          {notes.map((n) => {
            const meta = extractMeta(n.path, n.content);
            return (
              <tr key={n.id} tabIndex={0} onClick={() => navigate(`/n/${n.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/n/${n.id}`)} className="cursor-pointer border-t border-line/60 transition-colors hover:bg-raised/60">
                <td className="max-w-[18rem] truncate px-3 py-2 font-medium">{meta.title}</td>
                <td className="max-w-[12rem] truncate px-3 py-2 text-muted">{meta.folder}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {meta.tags.slice(0, 4).map((t) => (
                      <span key={t} className="cm-tag">
                        #{t}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-muted">{fmtDate(n.createdAt, true)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-muted">{fmtDate(n.updatedAt, true)}</td>
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
  const meta = extractMeta(note.path, note.content);
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
        <span className="truncate font-medium">{meta.title}</span>
        {note.access !== 'owner' && (
          <span className="chip">
            <Users size={11} /> {note.owner}
          </span>
        )}
        {note.dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" title="Noch nicht synchronisiert" />}
      </div>
      <p className="mt-1 line-clamp-2 break-words text-sm text-muted">{excerpt(note.content) || 'Leer'}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-faint">
        <span>{new Date(note.updatedAt).toLocaleDateString('de-DE', { day: 'numeric', month: 'short' })}</span>
        {meta.tags.slice(0, 4).map((t) => (
          <span key={t} className="cm-tag">
            #{t}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Subfolder row: opens the folder, accepts dropped notes and folders, can itself be dragged */
function FolderRow({ path, count }: { path: string; count: number }) {
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
      <span className="min-w-0 flex-1 truncate font-medium">{path.split('/').pop()}</span>
      {count > 0 && <span className="text-xs text-faint">{count}</span>}
      <ChevronRight size={16} className="shrink-0 text-faint" />
    </li>
  );
}

/** "Up one level" row, also a drop target for the parent folder */
function ParentRow({ folder }: { folder: string }) {
  const drop = useDropTarget(folder);
  return (
    <li
      role="button"
      tabIndex={0}
      {...drop.props}
      className={`drop-target flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-muted transition-colors hover:bg-raised/60 hover:text-ink ${drop.over ? 'drop-over' : ''}`}
      onClick={() => navigate(folder ? `/f/${encodeURIComponent(folder)}` : '/notes')}
      onKeyDown={(e) => e.key === 'Enter' && navigate(folder ? `/f/${encodeURIComponent(folder)}` : '/notes')}
      title={folder || 'Oberste Ebene'}
    >
      <CornerLeftUp size={17} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{folder ? folder.split('/').pop() : 'Oberste Ebene'}</span>
    </li>
  );
}

/** One folder another user shares with me: its notes, and a new note in it when that is allowed */
function SharedFolderSection({ shared, notes }: { shared: SharedFolder; notes: LocalNote[] }) {
  const [creating, setCreating] = useState(false);
  return (
    <section className="anim-fade-up">
      <div className="mb-2 flex items-center gap-2">
        <Folder size={16} className="shrink-0 text-accent" />
        <h2 className="min-w-0 truncate font-semibold" title={shared.folder}>
          {shared.folder.split('/').pop()}
        </h2>
        <span className="chip shrink-0">
          <Users size={11} /> {shared.owner} · {describePermissions(shared)}
        </span>
        {shared.canCreate && !creating && (
          <button className="edit-only btn-ghost ml-auto shrink-0" onClick={() => setCreating(true)}>
            <Plus size={16} /> <span className="hidden sm:inline">Neue Notiz</span>
          </button>
        )}
      </div>
      {creating && (
        <div className="mb-3">
          <FolderNameInput
            placeholder={`Titel der neuen Notiz in „${shared.folder.split('/').pop()}“`}
            onDone={(title) => {
              setCreating(false);
              if (title) void vault.createShared(shared, title.replace(/[\\/]/g, '-')).then((n) => navigate(`/n/${n.id}`));
            }}
          />
        </div>
      )}
      {notes.length === 0 ? (
        <p className="px-1 text-sm text-faint">Noch keine Notizen in diesem Ordner.</p>
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
  if (!notes.length && !vault.sharedFolders.length) return <div className="py-16 text-center text-faint anim-fade-in">Noch hat niemand etwas mit dir geteilt.</div>;
  return (
    <div className="space-y-8">
      {[...byFolder].map(([f, list]) => (
        <SharedFolderSection key={`${f.owner}/${f.folder}`} shared={f} notes={list} />
      ))}
      {single.length > 0 && (
        <section className="anim-fade-up">
          {byFolder.size > 0 && <h2 className="mb-2 font-semibold">Einzelne Notizen</h2>}
          <NoteCollection notes={single} />
        </section>
      )}
    </div>
  );
}

/** Notes of one folder (with subfolders), all notes, or the ones shared with me */
export function NoteList({ folder, mode }: { folder?: string; mode: 'folder' | 'all' | 'shared' }) {
  useVault();
  const [sort, setSort] = useState<'updated' | 'title'>('updated');
  const [creating, setCreating] = useState(false);
  let notes = vault.list();
  if (mode === 'shared') notes = notes.filter((n) => n.access !== 'owner');
  else notes = notes.filter((n) => n.access === 'owner');
  if (mode === 'folder' && folder !== undefined) notes = notes.filter((n) => splitPath(n.path).folder === folder);
  notes.sort((a, b) => (sort === 'updated' ? b.updatedAt - a.updatedAt : a.path.localeCompare(b.path, 'de', { numeric: true })));
  const subfolders = mode === 'folder' ? vault.folders().filter((f) => f.startsWith(`${folder}/`) && !f.slice(folder!.length + 1).includes('/')) : [];
  // Notes in a folder and all its subfolders (owned ones, like the list itself)
  const countIn = (f: string) => vault.list().filter((n) => n.access === 'owner' && (splitPath(n.path).folder === f || splitPath(n.path).folder.startsWith(`${f}/`))).length;
  const parent = mode === 'folder' && folder ? (folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '') : null;
  const title = mode === 'all' ? 'Alle Notizen' : mode === 'shared' ? 'Mit mir geteilt' : folder!.split('/').pop();

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-8 sm:py-10">
      <div className="mb-6 flex items-center gap-2 anim-fade-up">
        <div className="min-w-0 flex-1">
          {mode === 'folder' && folder!.includes('/') && <p className="truncate text-sm text-faint">{folder!.split('/').slice(0, -1).join(' / ')}</p>}
          <h1 className="truncate text-2xl font-bold tracking-tight">{title}</h1>
        </div>
        <ViewSwitch />
        <button className="btn-icon" title="Sortierung" onClick={() => setSort(sort === 'updated' ? 'title' : 'updated')}>
          {sort === 'updated' ? <Clock size={18} /> : <ArrowDownAZ size={18} />}
        </button>
        {mode === 'folder' && folder && folder !== PARA.archive && (
          restoreTarget(folder) !== null ? (
            <button className="edit-only btn-ghost" title={`Zurück nach ${restoreTarget(folder)}`} onClick={() => void vault.restoreFolder(folder).then(() => navigate(`/f/${encodeURIComponent(restoreTarget(folder)!)}`, true))}>
              <ArchiveRestore size={16} /> <span className="hidden sm:inline">Wiederherstellen</span>
            </button>
          ) : (
            !Object.values(PARA).includes(folder as never) && (
              <button
                className="edit-only btn-ghost"
                title="Ordner mit allen Notizen ins Archiv verschieben"
                onClick={() => confirm(`„${folder}“ archivieren?`) && void vault.archiveFolder(folder).then(() => navigate(`/f/${encodeURIComponent(archiveTarget(folder))}`, true))}
              >
                <Archive size={16} /> <span className="hidden sm:inline">Archivieren</span>
              </button>
            )
          )
        )}
        {mode !== 'shared' && (
          <button className="edit-only btn-primary" onClick={() => newNote(folder)}>
            <Plus size={16} /> Neu
          </button>
        )}
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
                placeholder="Name des Unterordners"
                onDone={(name) => {
                  setCreating(false);
                  if (name) void vault.addFolder(`${folder}/${name.replace(/\//g, '-')}`);
                }}
              />
            </li>
          ) : (
            <li className="edit-only">
              <button className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-muted transition-colors hover:bg-raised/60 hover:text-ink" onClick={() => setCreating(true)}>
                <FolderPlus size={17} className="shrink-0" /> Unterordner anlegen
              </button>
            </li>
          )}
        </ul>
      )}
      {mode === 'shared' ? (
        <SharedList notes={notes} />
      ) : notes.length === 0 ? (
        <div className="py-16 text-center text-faint anim-fade-in">Noch keine Notizen hier.</div>
      ) : (
        <NoteCollection notes={notes} />
      )}
    </div>
  );
}
