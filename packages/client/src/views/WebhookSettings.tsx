import { useEffect, useState } from 'react';
import type { EventDelivery, EventSource, EventSourceCreated, TicketHookProvider } from '@kladde/shared';
import { Check, KeyRound, Loader2, Plus, Trash2, Webhook } from '../lib/icons';
import { api } from '../lib/api';
import { locale, tl, useLang, type I18nKey } from '../lib/i18n';
import { useVault, vault } from '../data/vault';
import { SettingsPage } from './SettingsPage';
import { Dropdown } from './Dropdown';
import { CopyField } from './McpSettings';

/*
 * Central webhooks (#149, docs/EVENTS.md): one webhook per GitLab/GitHub project or group feeds the ticket
 * automations and every plugin that subscribes to git events. Owners of a group manage the group's webhooks here
 * too. The list shows the latest deliveries (status and event, never payloads).
 */

const STATUS: Record<EventDelivery['status'], { label: I18nKey; tone: string }> = {
  accepted: { label: 'webhooks.status.accepted', tone: 'bg-green-bg text-green' },
  failed: { label: 'webhooks.status.failed', tone: 'bg-red-bg text-red' },
  invalid: { label: 'webhooks.status.invalid', tone: 'bg-red-bg text-red' },
  ignored: { label: 'webhooks.status.ignored', tone: 'bg-raised text-muted' },
  filtered: { label: 'webhooks.status.filtered', tone: 'bg-raised text-muted' },
  duplicate: { label: 'webhooks.status.duplicate', tone: 'bg-amber-bg text-amber' },
};

/** What to tick at the provider: the events Kladde understands */
const GITLAB_TRIGGERS = ['Push events', 'Tag push events', 'Comments', 'Issues events', 'Merge request events', 'Job events', 'Pipeline events', 'Deployment events', 'Wiki page events', 'Releases events'];
const GITHUB_EVENTS = ['Pull requests', 'Pull request reviews', 'Pushes', 'Workflow runs', 'Workflow jobs', 'Issues', 'Issue comments', 'Commit comments', 'Releases', 'Deployment statuses', 'Wiki'];

const splitProjects = (text: string) =>
  text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);

export function WebhookSettingsView() {
  const lang = useLang();
  useVault();
  const loc = locale(lang);
  const when = (ms: number) => new Date(ms).toLocaleString(loc, { dateStyle: 'medium', timeStyle: 'short' });
  const ownedGroups = vault.groups.filter((g) => g.role === 'owner');

  const [sources, setSources] = useState<EventSource[] | null>(null);
  const [created, setCreated] = useState<{ source: EventSource; secret: string; rotated?: boolean } | null>(null);
  const [provider, setProvider] = useState<TicketHookProvider>('gitlab');
  const [name, setName] = useState('');
  const [projects, setProjects] = useState('');
  const [owner, setOwner] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => api<EventSource[]>('/event-sources').then(setSources, (err) => setError((err as Error).message));
  useEffect(() => {
    void load();
  }, []);

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api<EventSourceCreated>('/event-sources', { method: 'POST', json: { provider, name, projects: splitProjects(projects), ...(owner ? { group: owner } : {}) } });
      setCreated(result);
      setSources((list) => [...(list ?? []), result.source]);
      setName('');
      setProjects('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rotate = async (source: EventSource) => {
    if (!confirm(tl(lang, 'webhooks.rotateConfirm', { name: source.name }))) return;
    setError('');
    try {
      const { secret } = await api<{ secret: string }>(`/event-sources/${encodeURIComponent(source.id)}/rotate`, { method: 'POST' });
      setCreated({ source, secret, rotated: true });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async (source: EventSource) => {
    if (!confirm(tl(lang, 'webhooks.removeConfirm', { name: source.name }))) return;
    setError('');
    try {
      setSources(await api<EventSource[]>(`/event-sources/${encodeURIComponent(source.id)}`, { method: 'DELETE' }));
      if (created?.source.id === source.id) setCreated(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const events = created?.source.provider === 'github' ? GITHUB_EVENTS : GITLAB_TRIGGERS;

  return (
    <SettingsPage title={tl(lang, 'webhooks.title')}>
      <p className="text-body-m text-muted anim-fade-up">{tl(lang, 'webhooks.intro')}</p>

      <section className="card space-y-4 p-5 anim-fade-up" aria-label={tl(lang, 'webhooks.createTitle')}>
        <h2 className="text-title-m text-strong">{tl(lang, 'webhooks.createTitle')}</h2>
        {created ? (
          <div className="space-y-3 rounded-lg border border-acc-line p-4" data-webhook-created>
            <p className="flex items-start gap-2 text-body-m text-text">
              <Check size={18} className="mt-0.5 shrink-0 text-green" /> {tl(lang, created.rotated ? 'webhooks.rotated' : 'webhooks.created', { name: created.source.name })}
            </p>
            <div className="space-y-1">
              <p className="text-label-l text-muted">{tl(lang, 'webhooks.url')}</p>
              <CopyField value={created.source.url} label={tl(lang, 'webhooks.url')} />
            </div>
            <div className="space-y-1">
              <p className="text-label-l text-muted">{tl(lang, created.source.provider === 'gitlab' ? 'webhooks.tokenGitlab' : 'webhooks.tokenGithub')}</p>
              <CopyField value={created.secret} label={tl(lang, 'webhooks.secret')} />
            </div>
            <p className="text-body-s text-muted">{tl(lang, 'webhooks.secretOnce')}</p>
            {!created.rotated && (
              <div className="space-y-1.5 text-body-s text-muted">
                <p>{tl(lang, created.source.provider === 'gitlab' ? 'webhooks.stepsGitlab' : 'webhooks.stepsGithub')}</p>
                <ul className="flex flex-wrap gap-1.5">
                  {events.map((e) => (
                    <li key={e} className="pill bg-raised text-soft">
                      {e}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <button className="btn-text" onClick={() => setCreated(null)}>
              {tl(lang, 'common.done')}
            </button>
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <div className="segmented" role="group" aria-label={tl(lang, 'webhooks.provider')}>
              {(['gitlab', 'github'] as const).map((p) => (
                <button key={p} type="button" aria-pressed={provider === p} onClick={() => setProvider(p)}>
                  {p === 'gitlab' ? 'GitLab' : 'GitHub'}
                </button>
              ))}
            </div>
            <label className="block text-label-l text-muted">
              {tl(lang, 'webhooks.name')}
              <input className="input mt-1" value={name} maxLength={80} placeholder={tl(lang, 'webhooks.namePlaceholder')} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="block text-label-l text-muted">
              {tl(lang, 'webhooks.projects')}
              <textarea className="input mt-1 min-h-[4.5rem] font-mono text-body-s" value={projects} placeholder={provider === 'gitlab' ? 'gruppe/projekt\ngruppe/untergruppe' : 'org/repo'} onChange={(e) => setProjects(e.target.value)} />
              <span className="mt-1 block text-body-s text-faint">{tl(lang, 'webhooks.projectsHint')}</span>
            </label>
            {ownedGroups.length > 0 && (
              <div className="flex flex-col gap-1.5 text-label-l text-muted sm:flex-row sm:items-center sm:gap-2">
                <span className="shrink-0">{tl(lang, 'webhooks.owner')}</span>
                <Dropdown
                  value={owner}
                  onChange={setOwner}
                  aria-label={tl(lang, 'webhooks.owner')}
                  className="sm:w-auto sm:min-w-[14rem]"
                  options={[{ value: '', label: tl(lang, 'webhooks.ownerMe') }, ...ownedGroups.map((g) => ({ value: g.id, label: tl(lang, 'webhooks.ownerGroup', { name: g.name }) }))]}
                />
              </div>
            )}
            <button className="btn-tonal" type="submit" disabled={busy} data-create-webhook>
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} {tl(lang, 'webhooks.create')}
            </button>
          </form>
        )}
        {error && (
          <p className="text-body-s text-red" role="alert">
            {error}
          </p>
        )}
      </section>

      <section className="card divide-y divide-line anim-fade-up" aria-label={tl(lang, 'webhooks.listTitle')}>
        <h2 className="p-5 pb-3 text-title-m text-strong">{tl(lang, 'webhooks.listTitle')}</h2>
        {sources === null && !error && (
          <p className="flex items-center gap-2 p-5 pt-3 text-body-s text-muted">
            <Loader2 size={16} className="animate-spin" /> {tl(lang, 'common.loading')}
          </p>
        )}
        {sources?.length === 0 && <p className="p-5 pt-3 text-body-s text-muted">{tl(lang, 'webhooks.empty')}</p>}
        {sources?.map((s) => (
          <article key={s.id} className="space-y-3 p-4" data-webhook={s.id}>
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-acc-bg text-acc-hi">
                <Webhook size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-body-l text-strong">{s.name}</h3>
                <p className="truncate text-body-s text-muted">
                  {s.provider === 'gitlab' ? 'GitLab' : 'GitHub'} · {s.owner.kind === 'group' ? tl(lang, 'webhooks.ownerGroup', { name: s.owner.name }) : tl(lang, 'webhooks.ownerMe')} · {tl(lang, 'webhooks.by', { name: s.createdBy || '–', date: when(s.createdAt) })}
                </p>
                <p className="truncate font-mono text-caption text-faint">{s.projects.length ? s.projects.join(', ') : tl(lang, 'webhooks.allProjects')}</p>
              </div>
              <button className="btn-icon h-8 w-8 shrink-0" title={tl(lang, 'webhooks.rotate')} aria-label={tl(lang, 'webhooks.rotateNamed', { name: s.name })} onClick={() => void rotate(s)}>
                <KeyRound size={16} />
              </button>
              <button className="btn-icon h-8 w-8 shrink-0" title={tl(lang, 'webhooks.remove')} aria-label={tl(lang, 'webhooks.removeNamed', { name: s.name })} onClick={() => void remove(s)}>
                <Trash2 size={16} />
              </button>
            </div>
            <CopyField value={s.url} label={tl(lang, 'webhooks.url')} />
            {s.deliveries.length ? (
              <ul className="space-y-1" aria-label={tl(lang, 'webhooks.deliveries')}>
                {s.deliveries.slice(0, 8).map((d) => (
                  <li key={`${d.id}-${d.status}-${d.at}`} className="flex min-w-0 items-baseline gap-2 text-body-s">
                    <span className={`pill shrink-0 ${STATUS[d.status].tone}`}>{tl(lang, STATUS[d.status].label)}</span>
                    <span className="shrink-0 font-mono text-caption text-faint">{when(d.at)}</span>
                    <span className="shrink-0 font-mono text-caption text-soft">{d.type ? `${d.type}${d.action ? `:${d.action}` : ''}` : d.kind || '–'}</span>
                    <span className="min-w-0 truncate text-muted" title={d.detail}>
                      {[d.project, d.detail].filter(Boolean).join(' · ')}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-body-s text-faint">{tl(lang, 'webhooks.noDeliveries')}</p>
            )}
          </article>
        ))}
      </section>
      <p className="text-body-s text-faint">
        <button className="text-acc underline-offset-2 hover:underline" onClick={() => void load()}>
          {tl(lang, 'webhooks.reload')}
        </button>
      </p>
    </SettingsPage>
  );
}
