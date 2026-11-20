/**
 * Groups (#58): a group owns notes and shares them with all its members, each member has a role. The overview
 * lists and creates groups, the group view browses its folders and notes, the settings sheet manages members,
 * renames and deletes the group, and the move sheet moves own notes or folders into a group.
 */
import { useCallback, useEffect, useState } from 'react';
import { GROUP_ROLES, canWriteInGroup, splitPath, type GroupDetails, type GroupInfo, type GroupRole } from '@kladde/shared';
import { Activity as ActivityIcon, ArrowLeft, ChevronRight, CornerLeftUp, Folder, FolderInput, FolderPlus, Loader2, Plus, Settings, Star, Trash2, Users } from '../lib/icons';
import { api, ApiError } from '../lib/api';
import { useVault, vault } from '../data/vault';
import { activityPath } from './ActivityView';
import { openDialog } from '../lib/dialogs';
import { folderDisplayName, t, useLang, type I18nKey } from '../lib/i18n';
import { navigate } from '../lib/router';
import { isCoarsePointer } from '../lib/viewport';
import { Avatar } from './Avatar';
import { Sheet } from './Dialogs';
import { Dropdown } from './Dropdown';
import { NoteCollection } from './NoteList';
import { PageBody, PageHeader } from './PageHeader';

export const groupRoleLabel = (role: GroupRole) => t(`groups.role.${role}` as I18nKey);
const roleHint = (role: GroupRole) => t(`groups.roleHint.${role}` as I18nKey);

/** Route of a group, optionally of one of its folders */
export const groupPath = (groupId: string, folder = '') => `/g/${encodeURIComponent(groupId)}${folder ? `/${encodeURIComponent(folder)}` : ''}`;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** `/groups`: the user's groups, and a new one */
export function GroupsView() {
  useVault();
  useLang();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const group = await api<GroupInfo>('/groups', { method: 'POST', json: { name } });
      await vault.sync();
      navigate(groupPath(group.id));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <PageHeader title={t('groups.title')} subtitle={t('groups.intro')} />
      <PageBody className="max-w-[960px] !mx-0">
      {vault.groups.length === 0 ? (
        <p className="mb-4 text-body-m text-muted">{t('groups.empty')}</p>
      ) : (
        <ul className="card mb-4 divide-y divide-line overflow-hidden anim-fade-up" data-groups-list>
          {vault.groups.map((g) => (
            <li key={g.id}>
              <button
                type="button"
                className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-body-m transition-colors hover:bg-raised"
                onClick={() => navigate(groupPath(g.id))}
              >
                <Users size={18} className="shrink-0 text-primary" />
                <span className="min-w-0 flex-1 truncate font-medium">{g.name}</span>
                <span className="chip shrink-0">{groupRoleLabel(g.role)}</span>
                <span className="text-xs text-on-surface-variant">{vault.groupNotes(g.id).length}</span>
                <ChevronRight size={16} className="shrink-0 text-on-surface-variant" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="card edit-only flex flex-col gap-2 p-3 sm:flex-row anim-fade-up">
        <input
          className="input flex-1"
          placeholder={t('groups.namePlaceholder')}
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void create()}
          aria-label={t('groups.namePlaceholder')}
        />
        <button className="btn-primary shrink-0" disabled={busy || !name.trim()} onClick={() => void create()}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} {t('groups.create')}
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-error">{error}</p>}
      </PageBody>
    </div>
  );
}

/** `/g/<id>[/<folder>]`: the folders and notes of a group */
export function GroupView({ groupId, folder = '' }: { groupId: string; folder?: string }) {
  useVault();
  useLang();
  const group = vault.group(groupId);
  if (!group) {
    return (
      <div className="px-4 py-16 text-center text-muted">
        <p>{t('groups.notFound')}</p>
        <button className="btn-text mt-4" onClick={() => navigate('/groups')}>
          {t('groups.title')}
        </button>
      </div>
    );
  }
  const writer = canWriteInGroup(group.role);
  const notes = vault.groupNotes(groupId);
  const here = notes.filter((n) => splitPath(n.path).folder === folder).sort((a, b) => b.updatedAt - a.updatedAt);
  const subfolders = vault.groupFolders(groupId).filter((f) => (folder ? f.startsWith(`${folder}/`) && !f.slice(folder.length + 1).includes('/') : !f.includes('/')));
  const countIn = (f: string) => notes.filter((n) => splitPath(n.path).folder === f || splitPath(n.path).folder.startsWith(`${f}/`)).length;
  const parent = folder ? (folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '') : null;
  return (
    <div>
      <PageHeader
        title={folder ? folder.split('/').pop() : group.name}
        subtitle={
          <span className="flex items-center gap-1.5 truncate">
            <Users size={14} /> {[group.name, ...folder.split('/').slice(0, -1)].join('/')} · {groupRoleLabel(group.role)}
          </span>
        }
        actions={
          <>
          {vault.features().favorites.enabled && (!folder || vault.groupFolders(groupId).includes(folder)) && (
            <button
              className={`btn-icon shrink-0 ${vault.isFavoriteGroupFolder(groupId, folder) ? 'text-primary' : ''}`}
              aria-pressed={vault.isFavoriteGroupFolder(groupId, folder)}
              title={vault.isFavoriteGroupFolder(groupId, folder) ? t('groups.unfavorite') : t('groups.favorite')}
              aria-label={vault.isFavoriteGroupFolder(groupId, folder) ? t('groups.unfavorite') : t('groups.favorite')}
              onClick={() => void vault.toggleFavoriteGroupFolder(groupId, folder).catch((err) => alert(message(err)))}
              data-group-favorite
            >
              <Star size={20} filled={vault.isFavoriteGroupFolder(groupId, folder)} />
            </button>
          )}
          {vault.features().activity.enabled && (
            <button className="btn-ghost shrink-0 phone:!px-2.5" onClick={() => navigate(activityPath({ group: groupId }))} title={t('activity.title')} data-open-activity>
              <ActivityIcon size={16} /> <span className="hidden sm:inline">{t('activity.title')}</span>
            </button>
          )}
          <button className="btn-ghost shrink-0 phone:!px-2.5" onClick={() => navigate(groupManagePath(groupId))} title={t('groups.manage')}>
            <Settings size={16} /> <span className="hidden sm:inline">{t('groups.manage')}</span>
          </button>
          {writer && (
            <button className="edit-only btn-tonal" onClick={() => openDialog({ kind: 'note', group: groupId, folder })}>
              <Plus size={18} /> {t('groups.newNote')}
            </button>
          )}
          </>
        }
      />
      <PageBody>
      <ul className="card mb-5 divide-y divide-line overflow-hidden anim-fade-up">
        {parent !== null && (
          <li>
            <button
              type="button"
              className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-body-m text-muted transition-colors hover:bg-raised hover:text-text"
              onClick={() => navigate(groupPath(groupId, parent))}
            >
              <CornerLeftUp size={17} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{parent ? parent.split('/').pop() : group.name}</span>
            </button>
          </li>
        )}
        {subfolders.map((f) => (
          <li key={f}>
            <button
              type="button"
              className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-body-m transition-colors hover:bg-raised"
              onClick={() => navigate(groupPath(groupId, f))}
            >
              <Folder size={17} className="shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate font-medium">{f.split('/').pop()}</span>
              <span className="text-xs text-on-surface-variant">{countIn(f)}</span>
              <ChevronRight size={16} className="shrink-0 text-on-surface-variant" />
            </button>
          </li>
        ))}
        {writer && (
          <li className="edit-only">
            <button
              type="button"
              className="flex w-full items-center gap-3 px-3.5 py-2.5 text-body-m text-muted transition-colors hover:bg-raised hover:text-text"
              onClick={() => {
                // A group folder exists through its notes: open it and create the first note there
                const name = prompt(t('groups.newFolderPrompt'))?.trim().replace(/[\\/]/g, '-');
                if (name) navigate(groupPath(groupId, folder ? `${folder}/${name}` : name));
              }}
            >
              <FolderPlus size={17} className="shrink-0" /> {t('groups.newFolder')}
            </button>
          </li>
        )}
      </ul>
      {here.length === 0 ? (
        <div className="empty-sheet anim-fade-in"><p className="empty-title">{t('groups.emptyFolder')}</p></div>
      ) : (
        <NoteCollection notes={here} />
      )}
      </PageBody>
    </div>
  );
}

/** Route of a group's management page */
export const groupManagePath = (groupId: string) => `/groups/${encodeURIComponent(groupId)}`;

/** `/groups/<id>`: name, members (as a table, for large groups), figures, leaving and deleting a group */
export function GroupManageView({ groupId }: { groupId: string }) {
  useVault();
  useLang();
  const me = vault.group(groupId);
  const [details, setDetails] = useState<GroupDetails | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<GroupRole>('editor');
  const [filter, setFilter] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [confirmName, setConfirmName] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await api<GroupDetails>(`/groups/${encodeURIComponent(groupId)}`);
      setDetails(d);
      setName(d.name);
    } catch (err) {
      setError(message(err));
    }
  }, [groupId]);
  useEffect(() => void load(), [load]);

  /** Runs a change; the answer (if it is the group) replaces the shown details, and every device pulls */
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      const res = await fn();
      if (res && typeof res === 'object' && 'members' in res) setDetails(res as GroupDetails);
      await vault.sync();
      return true;
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const back = (
    <button className="btn-icon -ml-2 h-8 w-8 shrink-0" onClick={() => navigate(groupPath(groupId))} title={t('groups.backToGroup')} aria-label={t('groups.backToGroup')}>
      <ArrowLeft size={18} />
    </button>
  );
  if (!details) {
    return (
      <div className="mx-auto w-full max-w-[1600px] px-4 py-5 nav:px-7">
        {back}
        {error ? <p className="mt-6 text-center text-on-surface-variant">{error}</p> : <Loader2 size={20} className="mx-auto mt-10 animate-spin text-on-surface-variant" />}
      </div>
    );
  }

  const addMember = () => {
    if (busy || !username.trim()) return;
    void run(() => api(`/groups/${encodeURIComponent(groupId)}/members`, { method: 'PUT', json: { username: username.trim(), role } })).then((ok) => ok && setUsername(''));
  };
  const owner = details.role === 'owner';
  const owners = details.members.filter((m) => m.role === 'owner').length;
  const q = filter.trim().toLowerCase();
  const shown = q ? details.members.filter((m) => m.username.toLowerCase().includes(q) || groupRoleLabel(m.role).toLowerCase().includes(q)) : details.members;
  const stats: { label: string; value: number }[] = [
    { label: t('groups.statNotes'), value: details.notes },
    { label: t('groups.statAttachments'), value: details.attachments },
    { label: t('groups.statMembers'), value: details.members.length },
  ];

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-1.5">
            {back}
            {t('groups.settingsTitle')}
          </span>
        }
        subtitle={
          <span className="flex items-center gap-1.5 truncate">
            <Users size={14} /> {details.name} · {groupRoleLabel(details.role)}
          </span>
        }
      />
      <PageBody className="max-w-[960px] !mx-0">
      <div className="space-y-5">
        {owner && (
          <section className="card p-4 anim-fade-up">
            <label className="mb-1.5 block text-title-s" htmlFor="group-name">
              {t('groups.nameLabel')}
            </label>
            <div className="flex gap-2">
              <input id="group-name" className="input min-w-0 flex-1" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
              <button
                className="btn-tonal shrink-0"
                disabled={busy || !name.trim() || name.trim() === details.name}
                onClick={() =>
                  void run(() => api(`/groups/${encodeURIComponent(groupId)}`, { method: 'PATCH', json: { name } })).then((ok) => {
                    if (ok) void load();
                  })
                }
              >
                {t('groups.rename')}
              </button>
            </div>
          </section>
        )}

        <section className="card p-4 anim-fade-up">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="flex-1 text-title-m">{t('groups.members')}</h2>
            {details.members.length > 6 && (
              <input
                className="input !w-full sm:!w-60"
                placeholder={t('groups.filterMembers')}
                aria-label={t('groups.filterMembers')}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            )}
          </div>
          {owner && (
            <div className="mb-4 flex flex-col gap-2 sm:flex-row">
              <input
                className="input min-w-0 flex-1"
                placeholder={t('groups.usernamePlaceholder')}
                aria-label={t('groups.usernamePlaceholder')}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addMember()}
                autoComplete="off"
              />
              <Dropdown className="shrink-0 sm:!w-40" value={role} onChange={(r) => setRole(r as GroupRole)} aria-label={t('groups.newMemberRole')} options={GROUP_ROLES.map((r) => ({ value: r, label: groupRoleLabel(r) }))} />
              <button
                className="btn-tonal shrink-0"
                disabled={busy || !username.trim()}
                onClick={addMember}
              >
                <Plus size={16} /> {t('groups.addMember')}
              </button>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm" data-group-members>
              <thead>
                <tr className="border-b border-outline-variant text-left text-label-l text-on-surface-variant">
                  <th scope="col" className="px-2 py-2 font-medium">
                    {t('groups.memberCol')}
                  </th>
                  <th scope="col" className="w-32 px-2 py-2 font-medium sm:w-44">
                    {t('groups.roleCol')}
                  </th>
                  {owner && (
                    <th scope="col" className="w-10 px-1 py-2">
                      <span className="sr-only">{t('groups.remove')}</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {shown.map((m) => {
                  const lastOwner = m.role === 'owner' && owners <= 1;
                  return (
                    <tr key={m.username} className="border-b border-outline-variant/50 last:border-b-0">
                      <td className="max-w-0 px-2 py-1">
                        <span className="flex min-w-0 items-center gap-2">
                          <Avatar name={m.username} avatarUrl={m.avatarUrl} size="sm" />
                          <span className="truncate">{m.username}</span>
                        </span>
                      </td>
                      <td className="px-1 py-1 sm:px-2">
                        {owner ? (
                          <Dropdown
                            variant="ghost"
                            value={m.role}
                            aria-label={t('groups.roleLabel', { user: m.username })}
                            onChange={(next) => void run(() => api(`/groups/${encodeURIComponent(groupId)}/members`, { method: 'PUT', json: { username: m.username, role: next } }))}
                            options={GROUP_ROLES.map((r) => ({ value: r, label: groupRoleLabel(r), disabled: lastOwner && r !== 'owner' }))}
                          />
                        ) : (
                          groupRoleLabel(m.role)
                        )}
                      </td>
                      {owner && (
                        <td className="px-1 py-1 text-right">
                          <button
                            className="btn-icon hover:text-error"
                            disabled={busy || lastOwner}
                            title={lastOwner ? t('groups.lastOwnerHint') : t('groups.remove')}
                            aria-label={t('groups.removeUser', { user: m.username })}
                            onClick={() =>
                              confirm(t('groups.removeConfirm', { user: m.username })) &&
                              void run(() => api(`/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(m.username)}`, { method: 'DELETE' }))
                            }
                          >
                            <Trash2 size={16} />
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={owner ? 3 : 2} className="px-2 py-4 text-center text-on-surface-variant">
                      {t('groups.noMatch')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <dl className="mt-4 grid grid-cols-3 gap-2" data-group-stats>
            {stats.map((s) => (
              <div key={s.label} className="rounded-2xl bg-surface-container-high px-3 py-2 text-center">
                <dd className="text-title-l tabular-nums">{s.value}</dd>
                <dt className="text-xs text-on-surface-variant">{s.label}</dt>
              </div>
            ))}
          </dl>
          <ul className="mt-4 space-y-0.5 text-xs text-on-surface-variant">
            {GROUP_ROLES.map((r) => (
              <li key={r}>
                <span className="font-medium">{groupRoleLabel(r)}</span>: {roleHint(r)}
              </li>
            ))}
          </ul>
          {owner && owners <= 1 && <p className="mt-2 text-xs text-on-surface-variant">{t('groups.lastOwnerHint')}</p>}
        </section>

        {error && <p className="text-sm text-error">{error}</p>}

        <div className="flex flex-wrap gap-2 anim-fade-up">
          {me && !(owner && owners <= 1) && (
            <button
              className="btn-outlined"
              disabled={busy}
              onClick={async () => {
                if (!confirm(t('groups.leaveConfirm', { name: details.name }))) return;
                const ok = await run(() => api(`/groups/${encodeURIComponent(groupId)}/leave`, { method: 'POST', json: {} }));
                if (ok) navigate('/groups', true);
              }}
            >
              {t('groups.leave')}
            </button>
          )}
          {owner && (
            <button className="btn-outlined !border-error/60 !text-error" disabled={busy} onClick={() => setDeleting(true)} data-group-delete>
              <Trash2 size={16} /> {t('groups.deleteTitle')}
            </button>
          )}
        </div>
      </div>

      {deleting && (
        <Sheet
          title={t('groups.deleteTitle')}
          onClose={() => {
            setDeleting(false);
            setConfirmName('');
          }}
        >
          <div className="pb-2">
            <p className="mb-4 rounded-2xl border border-error/40 bg-error/10 px-3 py-2.5 text-sm text-error" role="alert">
              {t('groups.deleteDesc', { notes: details.notes, attachments: details.attachments })}
            </p>
            <label className="mb-1.5 block text-sm" htmlFor="group-delete-confirm">
              {t('groups.deleteConfirmLabel', { name: details.name })}
            </label>
            <input
              id="group-delete-confirm"
              className="input mb-4"
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              autoComplete="off"
              autoFocus={!isCoarsePointer()}
            />
            {error && <p className="mb-3 text-sm text-error">{error}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <button
                className="btn-text"
                onClick={() => {
                  setDeleting(false);
                  setConfirmName('');
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                className="btn-primary !bg-error !text-on-error"
                disabled={busy || confirmName.trim() !== details.name}
                onClick={async () => {
                  const ok = await run(() => api(`/groups/${encodeURIComponent(groupId)}`, { method: 'DELETE', json: { confirm: confirmName.trim() } }));
                  if (ok) navigate('/groups', true);
                }}
              >
                {busy ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />} {t('groups.deleteBtn')}
              </button>
            </div>
          </div>
        </Sheet>
      )}
      </PageBody>
    </div>
  );
}

/**
 * Moves an own note or a whole own folder into a group the user writes in. Shares of the moved notes end;
 * links between them keep working, links to notes outside only for people who see those.
 */
export function MoveToGroupSheet({ noteIds, folder, label, onClose }: { noteIds: string[]; folder?: string; label: string; onClose: () => void }) {
  useVault();
  const lang = useLang();
  const groups = vault.writableGroups();
  const [groupId, setGroupId] = useState(groups[0]?.id ?? '');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const folders = groupId ? vault.groupFolders(groupId) : [];
  const move = async () => {
    if (!groupId || busy) return;
    setBusy(true);
    setError('');
    try {
      const { moved } = await vault.moveToGroup(groupId, noteIds, target, folder);
      onClose();
      if (moved.length === 1 && !folder) navigate(`/n/${moved[0].id}`, true);
      else navigate(groupPath(groupId, folder ? splitPath(moved[0]?.path ?? '').folder.split('/').slice(0, (target ? target.split('/').length : 0) + 1).join('/') : target), true);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title={t('groups.moveTitle')} onClose={onClose}>
      {groups.length === 0 ? (
        <div className="pb-4">
          <p className="mb-4 text-sm text-on-surface-variant">{t('groups.moveNone')}</p>
          <button
            className="btn-tonal"
            onClick={() => {
              onClose();
              navigate('/groups');
            }}
          >
            <Users size={16} /> {t('groups.title')}
          </button>
        </div>
      ) : (
        <div className="space-y-4 pb-2">
          <p className="text-sm text-on-surface-variant">
            {folder ? t('groups.moveFolderDesc', { folder: folderDisplayName(folder, lang), n: noteIds.length }) : t('groups.moveNoteDesc', { name: label })}
          </p>
          <div className="flex flex-col gap-1.5 text-sm sm:flex-row sm:items-center sm:gap-2">
            <span className="shrink-0 text-on-surface-variant">{t('groups.moveGroup')}</span>
            <Dropdown
              className="flex-1"
              value={groupId}
              aria-label={t('groups.moveGroup')}
              onChange={(id) => {
                setGroupId(id);
                setTarget('');
              }}
              options={groups.map((g) => ({ value: g.id, label: g.name }))}
            />
          </div>
          <div className="flex flex-col gap-1.5 text-sm sm:flex-row sm:items-center sm:gap-2">
            <span className="shrink-0 text-on-surface-variant">{t('groups.moveTarget')}</span>
            <Dropdown
              className="flex-1"
              value={target}
              aria-label={t('groups.moveTarget')}
              onChange={setTarget}
              options={['', ...folders].map((f) => ({ value: f, label: f || t('common.topLevelPlain') }))}
            />
          </div>
          <p className="rounded-2xl bg-surface-container px-3 py-2 text-xs text-on-surface-variant">{t('groups.moveWarning')}</p>
          {error && <p className="text-sm text-error">{error}</p>}
          <button className="btn-primary w-full py-2.5" disabled={busy || !groupId || noteIds.length === 0} onClick={() => void move()} autoFocus={!isCoarsePointer()}>
            {busy ? <Loader2 size={16} className="animate-spin" /> : <FolderInput size={16} />} {t('groups.moveBtn')}
          </button>
        </div>
      )}
    </Sheet>
  );
}
