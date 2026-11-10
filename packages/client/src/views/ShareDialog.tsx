import { useEffect, useState } from 'react';
import { Check, Copy, Folder, Globe, Trash2, UserPlus, X } from 'lucide-react';
import type { FolderPermissions, FolderShares, NoteShare, NoteShares } from '@kladde/shared';
import { api } from '../lib/api';
import { folderDisplayName, folderLeafDisplayName, getLang, Lang, tl, useLang } from '../lib/i18n';
import { useVisualViewport } from '../lib/viewport';

/** What is shared: one note, or a folder with its subfolders (including notes added later) */
export type ShareTarget = { note: string } | { folder: string };

interface Shares {
  users: NoteShare[];
  inherited?: NoteShare[];
  publicToken?: string | null;
}

const READ_ONLY: FolderPermissions = { canWrite: false, canCreate: false, canDelete: false };

const permissionsOf = (s: NoteShare): FolderPermissions => ({ canWrite: s.canWrite, canCreate: !!s.canCreate, canDelete: !!s.canDelete });

/** The share endpoints of a note or folder */
function endpoints(target: ShareTarget) {
  if ('note' in target) {
    const base = `/notes/${target.note}`;
    return {
      list: () => api<NoteShares>(`${base}/shares`),
      set: (username: string, p: FolderPermissions) => api<NoteShares>(`${base}/shares`, { method: 'PUT', json: { username, canWrite: p.canWrite } }),
      remove: (username: string) => api<NoteShares>(`${base}/shares/${encodeURIComponent(username)}`, { method: 'DELETE' }),
    };
  }
  const folder = target.folder;
  return {
    list: () => api<FolderShares>(`/folders/shares?folder=${encodeURIComponent(folder)}`),
    set: (username: string, p: FolderPermissions) => api<FolderShares>('/folders/shares', { method: 'PUT', json: { folder, username, ...p } }),
    remove: (username: string) => api<FolderShares>('/folders/shares', { method: 'DELETE', json: { folder, username } }),
  };
}

/** Short summary of what a folder share allows */
export function describePermissions(p: FolderPermissions, lang: Lang = getLang()): string {
  if (!p.canWrite) return tl(lang, 'share.permReadLower');
  return [tl(lang, 'share.permWriteLower'), p.canCreate && tl(lang, 'share.permCreateLower'), p.canDelete && tl(lang, 'share.permDeleteLower')]
    .filter(Boolean)
    .join(', ');
}

/**
 * Notes: read or edit. Folders: reading is always allowed; editing, creating and deleting can be switched on
 * separately (creating or deleting switches editing on, switching editing off switches both off).
 */
function PermissionPicker({ folder, value, onChange }: { folder: boolean; value: FolderPermissions; onChange: (p: FolderPermissions) => void }) {
  const lang = useLang();
  if (!folder) {
    return (
      <select className="rounded-lg bg-surface text-sm text-muted" value={value.canWrite ? 'w' : 'r'} onChange={(e) => onChange({ ...READ_ONLY, canWrite: e.target.value === 'w' })}>
        <option value="r">{tl(lang, 'share.permReadLower')}</option>
        <option value="w">{tl(lang, 'share.permWriteLower')}</option>
      </select>
    );
  }
  const toggle = (key: keyof FolderPermissions) => {
    const on = !value[key];
    if (key === 'canWrite') onChange(on ? { ...value, canWrite: true } : READ_ONLY);
    else onChange({ ...value, [key]: on, canWrite: on || value.canWrite });
  };
  const options: [keyof FolderPermissions, string, string][] = [
    ['canWrite', tl(lang, 'share.permWrite'), tl(lang, 'share.permWriteHint')],
    ['canCreate', tl(lang, 'share.permCreate'), tl(lang, 'share.permCreateHint')],
    ['canDelete', tl(lang, 'share.permDelete'), tl(lang, 'share.permDeleteHint')],
  ];
  return (
    <div className="flex flex-wrap gap-1">
      <span className="chip bg-accent-container/60 text-on-accent-container" title={tl(lang, 'share.permReadAlwaysTitle')}>
        {tl(lang, 'share.permRead')}
      </span>
      {options.map(([key, label, title]) => (
        <button
          key={key}
          type="button"
          title={title}
          aria-pressed={value[key]}
          className={`chip transition-colors ${value[key] ? 'bg-accent-container text-on-accent-container' : 'text-faint hover:text-ink'}`}
          onClick={() => toggle(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function ShareDialog({ target, onClose }: { target: ShareTarget; onClose: () => void }) {
  const lang = useLang();
  const isNote = 'note' in target;
  const noteId = isNote ? target.note : '';
  const ep = endpoints(target);
  const [shares, setShares] = useState<Shares | null>(null);
  const [username, setUsername] = useState('');
  const [permissions, setPermissions] = useState<FolderPermissions>(READ_ONLY);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const call = async (p: Promise<Shares>) => {
    setError('');
    try {
      setShares(await p);
      return true;
    } catch (e) {
      setError((e as Error).message === 'Notiz nicht gefunden (oder nicht deine).' ? tl(lang, 'share.notSyncedError') : (e as Error).message);
      return false;
    }
  };
  useEffect(() => void call(ep.list()), ['note' in target ? target.note : target.folder]);
  const link = shares?.publicToken ? `${location.origin}/s/${shares.publicToken}` : null;
  const vp = useVisualViewport();

  return (
    <div
      className="fixed inset-x-0 z-50 flex items-end justify-center sm:items-center"
      style={vp ? { top: `${vp.top}px`, height: `${vp.height}px` } : { top: 0, bottom: 0 }}
    >
      <div className="fixed inset-0 bg-black/40 anim-fade-in" onClick={onClose} />
      <div className="relative max-h-[min(90vh,100%)] w-full max-w-md overflow-y-auto rounded-t-3xl bg-surface px-5 pt-5 shadow-soft anim-sheet [--pad-bottom:1.25rem] safe-bottom sm:rounded-3xl">
        <div className="mb-4 flex items-center">
          <h2 className="min-w-0 truncate text-lg font-semibold">
            {isNote ? tl(lang, 'share.noteTitle') : tl(lang, 'share.folderTitle', { name: folderLeafDisplayName(target.folder, lang) })}
          </h2>
          <button className="btn-icon ml-auto" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {!isNote && <p className="mb-3 text-sm text-muted">{tl(lang, 'share.folderHint')}</p>}
        <form
          className={isNote ? 'flex gap-2' : 'space-y-2'}
          onSubmit={(e) => {
            e.preventDefault();
            void call(ep.set(username.trim(), permissions)).then((ok) => ok && (setUsername(''), setPermissions(READ_ONLY)));
          }}
        >
          <div className="flex flex-1 gap-2">
            <input className="input" placeholder={tl(lang, 'share.usernamePlaceholder')} value={username} onChange={(e) => setUsername(e.target.value)} />
            {isNote && <PermissionPicker folder={false} value={permissions} onChange={setPermissions} />}
            <button className="btn-primary rounded-full px-4" disabled={!username.trim()} title={tl(lang, 'share.shareBtnTitle')}>
              <UserPlus size={16} />
            </button>
          </div>
          {!isNote && <PermissionPicker folder value={permissions} onChange={setPermissions} />}
        </form>
        <ul className="mt-3 space-y-1">
          {shares?.users.map((u) =>
            u.viaFolder ? (
              <ViaFolder key={u.username} share={u} />
            ) : (
              <li key={u.username} className="flex flex-wrap items-center gap-2 rounded-xl px-2 py-1.5 anim-fade-up hover:bg-raised">
                <span className="min-w-0 flex-1 truncate">{u.username}</span>
                {isNote && <PermissionPicker folder={false} value={permissionsOf(u)} onChange={(p) => void call(ep.set(u.username, p))} />}
                <button className="btn-icon h-8 w-8" title={tl(lang, 'share.removeTitle')} onClick={() => void call(ep.remove(u.username))}>
                  <Trash2 size={15} />
                </button>
                {!isNote && (
                  <div className="basis-full">
                    <PermissionPicker folder value={permissionsOf(u)} onChange={(p) => void call(ep.set(u.username, p))} />
                  </div>
                )}
              </li>
            )
          )}
          {shares?.inherited?.map((u) => <ViaFolder key={`${u.viaFolder}:${u.username}`} share={u} />)}
        </ul>
        {isNote && (
          <div className="mt-5 rounded-2xl border border-line p-3.5">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Globe size={16} className="text-accent2" />
              <span className="flex-1">{tl(lang, 'share.publicLinkLabel')}</span>
              <button
                type="button"
                role="switch"
                aria-checked={!!link}
                aria-label={tl(lang, 'share.publicLinkLabel')}
                onClick={() => void call(api<NoteShares>(`/notes/${noteId}/public`, { method: 'PUT', json: { enabled: !link } }))}
                className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border-2 p-0.5 transition-colors ${
                  link ? 'border-accent bg-accent' : 'border-faint/60 bg-raised'
                }`}
              >
                <span
                  className={`flex h-5 w-5 items-center justify-center rounded-full transition-transform duration-150 ${
                    link ? 'translate-x-5 bg-on-accent text-accent' : 'translate-x-0 scale-75 bg-muted text-surface'
                  }`}
                >
                  {link && <Check size={12} strokeWidth={3} />}
                </span>
              </button>
            </div>
            {link && (
              <button
                className="mt-2.5 flex w-full items-center gap-2 rounded-xl bg-raised px-3 py-2 text-left text-xs text-muted anim-fade-in"
                onClick={() => {
                  void navigator.clipboard?.writeText(link);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                <span className="flex-1 truncate">{link}</span>
                {copied ? tl(lang, 'common.copiedCheck') : <Copy size={14} />}
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
  const lang = useLang();
  return (
    <li className="flex items-center gap-2 rounded-xl px-2 py-1.5 text-muted anim-fade-up" title={tl(lang, 'share.viaFolderTitle')}>
      <span className="flex-1">{share.username}</span>
      <span className="flex min-w-0 items-center gap-1 text-xs text-faint">
        <Folder size={12} className="shrink-0" /> <span className="truncate">{share.viaFolder ? folderDisplayName(share.viaFolder, lang) : ''}</span> ·{' '}
        {describePermissions(permissionsOf(share), lang)}
      </span>
    </li>
  );
}
