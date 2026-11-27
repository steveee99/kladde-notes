/**
 * The cockpit's connections: each user's own GitLab token (for one of the instances the admin configured) and Jira
 * account. Tokens go to the server once and never come back; the page shows whom they belong to.
 */
import { useEffect, useState } from 'react';
import { safeUrl } from '@kladde/shared';
import { ConnectionProblem, refreshConnections, removeConnection, saveConnection, useConnections } from '../data/cockpit';
import { Check, ExternalLink, Merge, Ticket, Trash2 } from '../lib/icons';
import { tl, useLang, type I18nKey, type Lang } from '../lib/i18n';
import { Dropdown } from './Dropdown';

function problemMessage(err: unknown, lang: Lang): string {
  if (!(err instanceof ConnectionProblem)) return (err as Error).message;
  const key: Record<string, I18nKey> = {
    no_access: 'cockpit.conn.noAccess',
    unreachable: 'cockpit.conn.unreachable',
    not_found: 'cockpit.conn.notFound',
    upstream_limit: 'cockpit.problem.busy',
  };
  if (err.problem === 'invalid') {
    if (err.detail === 'token') return tl(lang, 'cockpit.conn.badToken');
    if (err.detail === 'email') return tl(lang, 'cockpit.conn.badEmail');
    if (err.detail === 'private') return tl(lang, 'cockpit.conn.private');
    return tl(lang, 'cockpit.conn.badUrl');
  }
  return tl(lang, key[err.problem] ?? 'cockpit.conn.unreachable');
}

function useAct() {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const lang = useLang();
  const act = async (what: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(what);
    setError('');
    setMessage('');
    try {
      await fn();
      if (done) setMessage(done);
    } catch (err) {
      setError(problemMessage(err, lang));
    } finally {
      setBusy('');
    }
  };
  return { busy, error, message, act };
}

function GitlabCard() {
  const lang = useLang();
  const { connections } = useConnections();
  const gl = connections?.gitlab ?? null;
  const instances = connections?.instances ?? [];
  const [instanceId, setInstanceId] = useState('');
  const [token, setToken] = useState('');
  const { busy, error, message, act } = useAct();
  useEffect(() => setInstanceId(gl?.instanceId ?? instances[0]?.id ?? ''), [gl?.instanceId, instances.length]);
  const host = instances.find((i) => i.id === instanceId);
  const tokenPage = host ? safeUrl(`${host.url}/-/user_settings/personal_access_tokens?name=Kladde%20Cockpit&scopes=read_api`) : '';

  return (
    <section className="card space-y-3 p-5" aria-labelledby="cockpit-gitlab" data-cockpit-connection="gitlab">
      <div className="flex items-center gap-2">
        <Merge size={18} className="text-amber" />
        <h3 id="cockpit-gitlab" className="flex-1 text-title-m text-strong">
          GitLab
        </h3>
        {gl ? <span className="pill bg-green-bg text-green">{tl(lang, 'cockpit.conn.as', { name: `@${gl.username}` })}</span> : <span className="pill bg-raised text-muted">{tl(lang, 'cockpit.conn.none')}</span>}
      </div>
      {instances.length === 0 ? (
        <p className="text-body-s text-muted">{tl(lang, 'cockpit.conn.noInstances')}</p>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void act('save', async () => {
              await saveConnection('gitlab', { instanceId, token });
              setToken('');
            }, tl(lang, 'cockpit.conn.saved'));
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-label-m text-muted">{tl(lang, 'cockpit.conn.instance')}</span>
              <Dropdown aria-label={tl(lang, 'cockpit.conn.instance')} value={instanceId} options={instances.map((i) => ({ value: i.id, label: i.url.replace(/^https?:\/\//, '') }))} onChange={setInstanceId} />
            </label>
            <label className="block">
              <span className="mb-1 block text-label-m text-muted">{tl(lang, 'cockpit.conn.gitlabToken')}</span>
              <input
                className="input font-mono text-body-s"
                type="password"
                autoComplete="off"
                placeholder={gl ? tl(lang, 'cockpit.conn.keepToken') : 'glpat-…'}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                required={!gl || gl.instanceId !== instanceId}
                data-cockpit-gitlab-token
              />
            </label>
          </div>
          <p className="text-caption text-faint">
            {tl(lang, 'cockpit.conn.gitlabHint')}{' '}
            {tokenPage && (
              <a className="inline-flex items-center gap-1 text-acc-hi hover:underline" href={tokenPage} target="_blank" rel="noopener noreferrer">
                {tl(lang, 'cockpit.conn.createToken')} <ExternalLink size={12} />
              </a>
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" className="btn-tonal" disabled={!!busy}>
              <Check size={16} /> {tl(lang, 'cockpit.conn.check')}
            </button>
            {gl && (
              <button type="button" className="btn-text" disabled={!!busy} onClick={() => void act('remove', () => removeConnection('gitlab'))}>
                <Trash2 size={16} /> {tl(lang, 'cockpit.conn.remove')}
              </button>
            )}
            {message && <span className="text-body-s text-green">{message}</span>}
            {error && (
              <span className="text-body-s text-red" role="alert">
                {error}
              </span>
            )}
          </div>
        </form>
      )}
    </section>
  );
}

function JiraCard() {
  const lang = useLang();
  const { connections } = useConnections();
  const jira = connections?.jira ?? null;
  const [kind, setKind] = useState<'cloud' | 'datacenter'>('cloud');
  const [url, setUrl] = useState('');
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const { busy, error, message, act } = useAct();
  useEffect(() => {
    if (!jira) return;
    setKind(jira.kind);
    setUrl(jira.url);
    setEmail(jira.email);
  }, [jira?.updatedAt]);

  return (
    <section className="card space-y-3 p-5" aria-labelledby="cockpit-jira" data-cockpit-connection="jira">
      <div className="flex items-center gap-2">
        <Ticket size={18} className="text-acc" />
        <h3 id="cockpit-jira" className="flex-1 text-title-m text-strong">
          Jira
        </h3>
        {jira ? <span className="pill bg-green-bg text-green">{tl(lang, 'cockpit.conn.as', { name: jira.accountName })}</span> : <span className="pill bg-raised text-muted">{tl(lang, 'cockpit.conn.none')}</span>}
      </div>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void act('save', async () => {
            await saveConnection('jira', { kind, url, email, token });
            setToken('');
          }, tl(lang, 'cockpit.conn.saved'));
        }}
      >
        <div className="segmented" role="group" aria-label={tl(lang, 'cockpit.conn.kind')}>
          <button type="button" aria-pressed={kind === 'cloud'} onClick={() => setKind('cloud')}>
            Cloud
          </button>
          <button type="button" aria-pressed={kind === 'datacenter'} onClick={() => setKind('datacenter')}>
            Data Center
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-label-m text-muted">{tl(lang, 'cockpit.conn.url')}</span>
            <input className="input font-mono text-body-s" type="url" required placeholder={kind === 'cloud' ? 'https://firma.atlassian.net' : 'https://jira.firma.de'} value={url} onChange={(e) => setUrl(e.target.value)} />
          </label>
          {kind === 'cloud' && (
            <label className="block">
              <span className="mb-1 block text-label-m text-muted">{tl(lang, 'cockpit.conn.email')}</span>
              <input className="input" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
          )}
        </div>
        <label className="block">
          <span className="mb-1 block text-label-m text-muted">{kind === 'cloud' ? tl(lang, 'cockpit.conn.apiToken') : tl(lang, 'cockpit.conn.pat')}</span>
          <input className="input font-mono text-body-s" type="password" autoComplete="off" placeholder={jira ? tl(lang, 'cockpit.conn.keepToken') : ''} value={token} onChange={(e) => setToken(e.target.value)} required={!jira} />
        </label>
        <p className="text-caption text-faint">
          {kind === 'cloud' ? (
            <a className="inline-flex items-center gap-1 text-acc-hi hover:underline" href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener noreferrer">
              {tl(lang, 'cockpit.conn.createToken')} <ExternalLink size={12} />
            </a>
          ) : (
            tl(lang, 'cockpit.conn.patHint')
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn-tonal" disabled={!!busy}>
            <Check size={16} /> {tl(lang, 'cockpit.conn.check')}
          </button>
          {jira && (
            <button type="button" className="btn-text" disabled={!!busy} onClick={() => void act('remove', () => removeConnection('jira'))}>
              <Trash2 size={16} /> {tl(lang, 'cockpit.conn.remove')}
            </button>
          )}
          {message && <span className="text-body-s text-green">{message}</span>}
          {error && (
            <span className="text-body-s text-red" role="alert">
              {error}
            </span>
          )}
        </div>
      </form>
    </section>
  );
}

/** Both connections; in the features dialog's settings tab and in the cockpit's connections sheet */
export function CockpitConnectionsView() {
  const lang = useLang();
  const { error } = useConnections();
  useEffect(() => void refreshConnections(), []);
  return (
    <div className="space-y-4" data-cockpit-connections>
      <p className="text-body-s text-muted">{tl(lang, 'cockpit.conn.intro')}</p>
      {error && <p className="text-body-s text-red">{error}</p>}
      <GitlabCard />
      <JiraCard />
    </div>
  );
}
