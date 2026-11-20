/**
 * Activity of a group or a shared folder (#70): created, edited (grouped per person and hour), moved, deleted,
 * restored and released notes, and who joined or left. Entries since the last visit of this page are marked.
 */
import { useEffect, useMemo, useState } from 'react';
import { Activity as ActivityIcon, ArrowLeft, Folder, Users } from '../lib/icons';
import { splitPath, type ActivityEntry, type ActivityList } from '@kladde/shared';
import { api } from '../lib/api';
import { useVault, vault } from '../data/vault';
import { locale, tl, useLang, type I18nKey, type Lang } from '../lib/i18n';
import { navigate } from '../lib/router';
import { Avatar } from './Avatar';
import { PageBody, PageHeader } from './PageHeader';

export type ActivityScope = { group: string } | { owner: string; folder: string };

/** Route of the activity page of a group or a shared folder */
export const activityPath = (scope: ActivityScope) =>
  'group' in scope ? `/activity?group=${encodeURIComponent(scope.group)}` : `/activity?owner=${encodeURIComponent(scope.owner)}&folder=${encodeURIComponent(scope.folder)}`;

const scopeKey = (scope: ActivityScope) => ('group' in scope ? `g:${scope.group}` : `f:${scope.owner}/${scope.folder}`);

function lastVisit(key: string): number {
  try {
    return Number(localStorage.getItem(`kladde.activityVisit.${key}`)) || 0;
  } catch {
    return 0;
  }
}

function remember(key: string, at: number) {
  try {
    localStorage.setItem(`kladde.activityVisit.${key}`, String(at));
  } catch {
    /* ignore */
  }
}

/** "anna edited Plan (3×)" */
function describe(e: ActivityEntry, lang: Lang): { verb: string; target: string | null } {
  const name = (p?: string) => (p ? splitPath(p).name : '');
  switch (e.kind) {
    case 'member_added':
      return { verb: tl(lang, 'activity.memberAdded', { member: e.member ?? '', role: e.role ? tl(lang, `groups.role.${e.role}` as I18nKey) : '' }), target: null };
    case 'member_removed':
      return { verb: tl(lang, 'activity.memberRemoved', { member: e.member ?? '' }), target: null };
    case 'member_role':
      return { verb: tl(lang, 'activity.memberRole', { member: e.member ?? '', role: e.role ? tl(lang, `groups.role.${e.role}` as I18nKey) : '' }), target: null };
    case 'folder_shared':
      return { verb: tl(lang, 'activity.folderShared', { member: e.member ?? '' }), target: null };
    case 'folder_unshared':
      return { verb: tl(lang, 'activity.folderUnshared', { member: e.member ?? '' }), target: null };
    case 'moved':
      return { verb: tl(lang, 'activity.moved', { from: name(e.previousPath) === name(e.path) ? splitPath(e.previousPath ?? '').folder || '/' : name(e.previousPath) }), target: name(e.path) };
    case 'released':
      return { verb: tl(lang, 'activity.released', { version: e.version ?? '' }), target: name(e.path) };
    case 'edited':
      return { verb: e.count > 1 ? tl(lang, 'activity.editedTimes', { n: e.count }) : tl(lang, 'activity.edited'), target: name(e.path) };
    default:
      return { verb: tl(lang, `activity.${e.kind}` as I18nKey), target: name(e.path) };
  }
}

export function ActivityView({ scope }: { scope: ActivityScope }) {
  useVault();
  const lang = useLang();
  const loc = locale(lang);
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [error, setError] = useState('');
  const key = scopeKey(scope);
  const [since] = useState(() => lastVisit(key));
  const query = activityPath(scope).slice('/activity'.length);

  useEffect(() => {
    let alive = true;
    api<ActivityList>(`/activity${query}`)
      .then((r) => {
        if (!alive) return;
        setEntries(r.entries);
        remember(key, Date.now());
      })
      .catch((err) => alive && setError((err as Error).message));
    return () => {
      alive = false;
    };
  }, [query, key]);

  const group = 'group' in scope ? vault.group(scope.group) : undefined;
  const title = 'group' in scope ? (group?.name ?? '') : (scope.folder.split('/').pop() ?? scope.folder);
  const days = useMemo(() => {
    const out: { day: string; label: string; entries: ActivityEntry[] }[] = [];
    const fmt = new Intl.DateTimeFormat(loc, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    for (const e of entries ?? []) {
      const d = new Date(e.at);
      const day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (out[out.length - 1]?.day !== day) out.push({ day, label: fmt.format(d), entries: [] });
      out[out.length - 1].entries.push(e);
    }
    return out;
  }, [entries, loc]);
  const timeFmt = new Intl.DateTimeFormat(loc, { hour: '2-digit', minute: '2-digit' });
  const back = () => ('group' in scope ? navigate(`/g/${encodeURIComponent(scope.group)}`) : navigate(scope.owner === vault.actorName ? `/f/${encodeURIComponent(scope.folder)}` : '/shared'));

  return (
    <div data-activity-view>
      <PageHeader
        title={
          <span className="flex items-center gap-1.5">
            <button className="btn-icon -ml-2 h-8 w-8 shrink-0" onClick={back} title={tl(lang, 'common.back')} aria-label={tl(lang, 'common.back')}>
              <ArrowLeft size={18} />
            </button>
            {tl(lang, 'activity.title')}
          </span>
        }
        subtitle={
          <span className="flex items-center gap-1.5 truncate">
            {'group' in scope ? <Users size={14} /> : <Folder size={14} />} {title}
          </span>
        }
      />
      <PageBody className="max-w-[960px] !mx-0">
      {error ? (
        <p className="card p-6 text-sm text-on-surface-variant">{tl(lang, 'activity.unavailable')}</p>
      ) : entries === null ? (
        <p className="py-10 text-center text-on-surface-variant" role="status">
          {tl(lang, 'common.loading')}
        </p>
      ) : entries.length === 0 ? (
        <div className="card flex flex-col items-center gap-2 p-8 text-center text-sm text-on-surface-variant anim-fade-up">
          <ActivityIcon size={28} />
          {tl(lang, 'activity.empty')}
        </div>
      ) : (
        <div className="space-y-6">
          {days.map((d) => (
            <section key={d.day} className="anim-fade-up" aria-label={d.label}>
              <h2 className="mb-2 px-1 text-title-s capitalize text-on-surface-variant">{d.label}</h2>
              <ul className="card divide-y divide-outline-variant/60 p-1">
                {d.entries.map((e) => {
                  const { verb, target } = describe(e, lang);
                  const note = e.noteId ? vault.get(e.noteId) : undefined;
                  const fresh = e.at > since && e.actor !== vault.actorName;
                  return (
                    <li key={e.id} className="flex items-center gap-3 px-3 py-2.5" data-activity-kind={e.kind}>
                      <Avatar name={e.actor ?? '?'} size="sm" />
                      <div className="min-w-0 flex-1 text-sm">
                        <span className="font-medium">{e.actor ?? tl(lang, 'activity.someone')}</span> {verb}{' '}
                        {target &&
                          (note && e.kind !== 'deleted' ? (
                            <button type="button" className="font-medium text-primary hover:underline" onClick={() => navigate(`/n/${note.id}`)}>
                              {target}
                            </button>
                          ) : (
                            <span className="font-medium">{target}</span>
                          ))}
                      </div>
                      {fresh && <span className="chip h-6 shrink-0 px-2 text-xs text-primary">{tl(lang, 'activity.new')}</span>}
                      <time className="shrink-0 text-xs tabular-nums text-on-surface-variant" dateTime={new Date(e.at).toISOString()}>
                        {timeFmt.format(new Date(e.at))}
                      </time>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
      </PageBody>
    </div>
  );
}

/** A dot on notes someone else changed since the user last opened them (#70) */
export function NewMark({ noteId }: { noteId: string }) {
  const lang = useLang();
  const news = vault.newsOf(noteId);
  if (!news || !vault.features().activity.enabled) return null;
  const label = news.by ? tl(lang, 'activity.newBy', { name: news.by }) : tl(lang, 'activity.new');
  return <span role="img" data-new-mark className="h-2 w-2 shrink-0 rounded-full bg-primary" title={label} aria-label={label} />;
}
