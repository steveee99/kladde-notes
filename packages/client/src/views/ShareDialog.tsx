import { useEffect, useState } from 'react';
import { Copy, Folder, Globe, Trash2, UserPlus, X } from 'lucide-react';
import type { FolderShares, NoteShare, NoteShares } from '@kladde/shared';
import { api } from '../lib/api';

/** What is shared: one note, or a folder with its subfolders (including notes added later) */
export type ShareTarget = { note: string } | { folder: string };

interface Shares {
  users: NoteShare[];
  inherited?: NoteShare[];
  publicToken?: string | null;
}

/** The share endpoints of a note or folder */
function endpoints(target: ShareTarget) {
  if ('note' in target) {
    const base = `/notes/${target.note}`;
    return {
      list: () => api<NoteShares>(`${base}/shares`),
      set: (username: string, canWrite: boolean) => api<NoteShares>(`${base}/shares`, { method: 'PUT', json: { username, canWrite } }),
      remove: (username: string) => api<NoteShares>(`${base}/shares/${encodeURIComponent(username)}`, { method: 'DELETE' }),
    };
  }
  const folder = target.folder;
  return {
    list: () => api<FolderShares>(`/folders/shares?folder=${encodeURIComponent(folder)}`),
    set: (username: string, canWrite: boolean) => api<FolderShares>('/folders/shares', { method: 'PUT', json: { folder, username, canWrite } }),
    remove: (username: string) => api<FolderShares>('/folders/shares', { method: 'DELETE', json: { folder, username } }),
  };
}

export function ShareDialog({ target, onClose }: { target: ShareTarget; onClose: () => void }) {
  const isNote = 'note' in target;
  const noteId = isNote ? target.note : '';
  const ep = endpoints(target);
  const [shares, setShares] = useState<Shares | null>(null);
  const [username, setUsername] = useState('');
  const [canWrite, setCanWrite] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const call = async (p: Promise<Shares>) => {
    setError('');
    try {
      setShares(await p);
    } catch (e) {
      setError((e as Error).message === 'Notiz nicht gefunden (oder nicht deine).' ? 'Die Notiz ist noch nicht synchronisiert – bitte online gehen.' : (e as Error).message);
    }
  };
  useEffect(() => void call(ep.list()), ['note' in target ? target.note : target.folder]);
  const link = shares?.publicToken ? `${location.origin}/s/${shares.publicToken}` : null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/40 anim-fade-in" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-t-3xl bg-surface px-5 pt-5 shadow-soft anim-sheet [--pad-bottom:1.25rem] safe-bottom sm:rounded-3xl">
        <div className="mb-4 flex items-center">
          <h2 className="min-w-0 truncate text-lg font-semibold">{isNote ? 'Teilen' : `Ordner „${target.folder.split('/').pop()}“ teilen`}</h2>
          <button className="btn-icon ml-auto" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {!isNote && <p className="mb-3 text-sm text-muted">Gilt für alle Notizen darin, auch in Unterordnern und für Notizen, die du später hinzufügst.</p>}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void call(ep.set(username, canWrite)).then(() => setUsername(''));
          }}
        >
          <input className="input" placeholder="Benutzername" value={username} onChange={(e) => setUsername(e.target.value)} />
          <select className="input w-auto" value={canWrite ? 'w' : 'r'} onChange={(e) => setCanWrite(e.target.value === 'w')}>
            <option value="r">lesen</option>
            <option value="w">bearbeiten</option>
          </select>
          <button className="btn-primary" disabled={!username.trim()}>
            <UserPlus size={16} />
          </button>
        </form>
        <ul className="mt-3 space-y-1">
          {shares?.users.map((u) =>
            u.viaFolder ? (
              <ViaFolder key={u.username} share={u} />
            ) : (
            <li key={u.username} className="flex items-center gap-2 rounded-xl px-2 py-1.5 anim-fade-up hover:bg-raised">
              <span className="flex-1">{u.username}</span>
              <select
                className="rounded-lg bg-transparent text-sm text-muted"
                value={u.canWrite ? 'w' : 'r'}
                onChange={(e) => void call(ep.set(u.username, e.target.value === 'w'))}
              >
                <option value="r">lesen</option>
                <option value="w">bearbeiten</option>
              </select>
              <button className="btn-icon h-8 w-8" onClick={() => void call(ep.remove(u.username))}>
                <Trash2 size={15} />
              </button>
            </li>
            )
          )}
          {shares?.inherited?.map((u) => <ViaFolder key={`${u.viaFolder}:${u.username}`} share={u} />)}
        </ul>
        {isNote && (
        <div className="mt-5 rounded-2xl border border-line p-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <Globe size={16} className="text-accent2" /> Öffentlicher Link (nur lesen)
            <input
              type="checkbox"
              className="ml-auto h-5 w-9 cursor-pointer appearance-none rounded-full bg-line transition-colors before:block before:h-4 before:w-4 before:translate-x-0.5 before:rounded-full before:bg-white before:transition-transform checked:bg-accent checked:before:translate-x-[18px]"
              checked={!!link}
              onChange={(e) => void call(api<NoteShares>(`/notes/${noteId}/public`, { method: 'PUT', json: { enabled: e.target.checked } }))}
            />
          </label>
          {link && (
            <button
              className="mt-2 flex w-full items-center gap-2 rounded-lg bg-raised px-3 py-2 text-left text-xs text-muted anim-fade-in"
              onClick={() => {
                void navigator.clipboard?.writeText(link);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              <span className="flex-1 truncate">{link}</span>
              {copied ? 'Kopiert ✓' : <Copy size={14} />}
            </button>
          )}
        </div>
        )}
        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      </div>
    </div>
  );
}

/** Access that comes from a shared (parent) folder: shown, but managed on that folder */
function ViaFolder({ share }: { share: NoteShare }) {
  return (
    <li className="flex items-center gap-2 rounded-xl px-2 py-1.5 text-muted anim-fade-up" title="Wird am Ordner verwaltet">
      <span className="flex-1">{share.username}</span>
      <span className="flex min-w-0 items-center gap-1 text-xs text-faint">
        <Folder size={12} className="shrink-0" /> <span className="truncate">{share.viaFolder}</span> · {share.canWrite ? 'bearbeiten' : 'lesen'}
      </span>
    </li>
  );
}
