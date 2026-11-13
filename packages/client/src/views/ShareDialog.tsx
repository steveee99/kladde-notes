import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Folder, Globe, Trash2, UserPlus, X } from '../lib/icons';
import type { FolderPermissions, FolderShares, NoteShare, NoteShares } from '@kladde/shared';
import { api } from '../lib/api';
import { folderDisplayName, folderLeafDisplayName, getLang, Lang, tl, useLang } from '../lib/i18n';
import { useVisualViewport } from '../lib/viewport';
import { Avatar } from './Avatar';
import { Dropdown } from './Dropdown';
import { Switch } from './Switch';

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
      <Dropdown
        variant="ghost"
        className="shrink-0 text-on-surface-variant"
        value={value.canWrite ? 'w' : 'r'}
        aria-label={tl(lang, 'share.permWrite')}
        onChange={(v) => onChange({ ...READ_ONLY, canWrite: v === 'w' })}
        options={[
          { value: 'r', label: tl(lang, 'share.permReadLower') },
          { value: 'w', label: tl(lang, 'share.permWriteLower') },
        ]}
      />
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
      <span className="chip bg-secondary-container text-on-secondary-container" title={tl(lang, 'share.permReadAlwaysTitle')}>
        {tl(lang, 'share.permRead')}
      </span>
      {options.map(([key, label, title]) => (
        <button
          key={key}
          type="button"
          title={title}
          aria-pressed={value[key]}
          className={`chip ${value[key] ? 'bg-secondary-container text-on-secondary-container' : 'text-on-surface-variant hover:text-on-surface'}`}
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

  return createPortal(
    <div
      className="fixed inset-x-0 z-50 flex items-end justify-center sm:items-center"
      style={vp ? { top: `${vp.top}px`, height: `${vp.height}px` } : { top: 0, bottom: 0 }}
    >
      <div className="fixed inset-0 bg-scrim/[0.32] anim-fade-in" onClick={onClose} />
      <div className="relative max-h-[min(90vh,100%)] w-full max-w-md overflow-y-auto rounded-t-3xl bg-surface-container-high px-6 pt-6 shadow-elevation-3 anim-sheet [--pad-bottom:1.25rem] safe-bottom sm:rounded-3xl">
        <div className="mb-4 flex items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-headline-s">
            {isNote ? tl(lang, 'share.noteTitle') : tl(lang, 'share.folderTitle', { name: folderLeafDisplayName(target.folder, lang) })}
          </h2>
          <button className="btn-icon ml-auto shrink-0" onClick={onClose} aria-label={tl(lang, 'common.close')}>
            <X size={18} />
          </button>
        </div>
        {!isNote && <p className="mb-3 text-sm text-on-surface-variant">{tl(lang, 'share.folderHint')}</p>}
        <form
          className={isNote ? 'flex gap-2' : 'space-y-2'}
          onSubmit={(e) => {
            e.preventDefault();
            void call(ep.set(username.trim(), permissions)).then((ok) => ok && (setUsername(''), setPermissions(READ_ONLY)));
          }}
        >
          <div className="flex flex-1 flex-wrap items-center gap-2 sm:flex-nowrap">
            <input className="input min-w-0 flex-1 basis-32" placeholder={tl(lang, 'share.usernamePlaceholder')} value={username} onChange={(e) => setUsername(e.target.value)} />
            {isNote && <PermissionPicker folder={false} value={permissions} onChange={setPermissions} />}
            <button className="btn-primary shrink-0 rounded-full px-4" disabled={!username.trim()} title={tl(lang, 'share.shareBtnTitle')}>
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
              <li key={u.username} className="flex flex-wrap items-center gap-2.5 rounded-xl px-2 py-1.5 anim-fade-up hover:bg-surface-container-high">
                <Avatar name={u.username} avatarUrl={u.avatarUrl} size="sm" />
                <span className="min-w-0 flex-1 truncate">{u.username}</span>
                {isNote && <PermissionPicker folder={false} value={permissionsOf(u)} onChange={(p) => void call(ep.set(u.username, p))} />}
                <button className="btn-icon h-8 w-8" title={tl(lang, 'share.removeTitle')} onClick={() => void call(ep.remove(u.username))}>
                  <Trash2 size={15} />
                </button>
                {!isNote && (
                  <div className="basis-full pl-8">
                    <PermissionPicker folder value={permissionsOf(u)} onChange={(p) => void call(ep.set(u.username, p))} />
                  </div>
                )}
              </li>
            )
          )}
          {shares?.inherited?.map((u) => <ViaFolder key={`${u.viaFolder}:${u.username}`} share={u} />)}
        </ul>
        {isNote && (
          <div className="mt-5 rounded-2xl border border-outline-variant p-3.5">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Globe size={16} className="text-tertiary" />
              <span className="flex-1">{tl(lang, 'share.publicLinkLabel')}</span>
              <Switch
                checked={!!link}
                label={tl(lang, 'share.publicLinkLabel')}
                onChange={(on) => void call(api<NoteShares>(`/notes/${noteId}/public`, { method: 'PUT', json: { enabled: on } }))}
              />
            </div>
            {link && (
              <button
                className="mt-2.5 flex w-full items-center gap-2 rounded-xl bg-surface-container-high px-3 py-2 text-left text-xs text-on-surface-variant anim-fade-in"
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
        {error && <p className="mt-3 text-sm text-error">{error}</p>}
      </div>
    </div>,
    document.body
  );
}

/** Access that comes from a shared (parent) folder: shown, but managed on that folder */
function ViaFolder({ share }: { share: NoteShare }) {
  const lang = useLang();
  return (
    <li className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 text-on-surface-variant anim-fade-up" title={tl(lang, 'share.viaFolderTitle')}>
      <Avatar name={share.username} avatarUrl={share.avatarUrl} size="sm" />
      <span className="min-w-0 flex-1 truncate">{share.username}</span>
      <span className="flex max-w-[60%] min-w-0 items-center gap-1 text-xs text-on-surface-variant">
        <Folder size={12} className="shrink-0" /> <span className="truncate">{share.viaFolder ? folderDisplayName(share.viaFolder, lang) : ''}</span> ·{' '}
        <span className="shrink-0">{describePermissions(permissionsOf(share), lang)}</span>
      </span>
    </li>
  );
}
